"""
pretix and SumUp brought to agree about the money that went back to a card.

Two holes, both found with the first real card refunds, on 24 September 2026.

**SumUp refuses a refund asked for right after the payment.** "409 · The
transaction is not refundable in its current state": a customer changing their
mind at the counter is the case a till meets most, and it is the one SumUp says
no to. The same refund, made in SumUp's dashboard a few minutes later, went
through. So that answer is not a refusal. The refund is left *in transit* —
pretix' own state for money on its way, which the order page shows as such and
which stops anyone refunding the same payment twice — and asked for again from
pretix' periodic task until SumUp takes it. After three days of "not yet" it is
something else, and the refund is failed for a person to look at.

**A payment given back in SumUp never reached pretix.** Refunded or cancelled
in SumUp's dashboard or app, it stayed paid in pretix and counted in the
takings; and a refund pretix had marked failed stayed on the list of money owed
to a customer who had it back. SumUp tells nobody. So the same task reads
SumUp's history of payments given back and brings each one a reader of this
server took into line: a whole payment cancels its order, as pretix' own
"Cancel the order" would, with the refund recorded and the sale reversed in the
journal; a refund pretix was waiting on is marked done; a part given back is
recorded as an external refund, for somebody to process on the order.

What is never done here is a decision nobody made. The one refund this module
sends is one somebody already asked for, and only after reading the
transaction again, so money SumUp has already given back is not asked for a
second time.
"""
import json
import logging
from datetime import datetime, timedelta
from decimal import Decimal

from django.db import transaction
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from django_scopes import scopes_disabled
from pretix.base.i18n import language
from pretix.base.models import Order, Organizer
from pretix.base.models.orders import OrderPayment, OrderRefund

from .models import PosSale, PosTerminalPayment
from .payment import CARD
from .sumup import ERR_CONFLICT, SumUpAccount, SumUpError, given_back

logger = logging.getLogger(__name__)

#: On a refund's info: when SumUp first answered "not yet". A refund in
#: transit with this is one of ours to ask for again.
PENDING_SINCE = "sumup_pending_since"
#: On a refund's info: when SumUp was last asked, for the Sales page.
TRIED_AT = "sumup_tried_at"
#: How long a refund SumUp keeps refusing is asked for again. The first real
#: one went through in SumUp's dashboard within minutes; three days of "not
#: yet", a weekend included, is something a person has to look at.
GIVE_UP_AFTER = timedelta(days=3)
#: How far back a payment given back in SumUp is looked for. An older sale is
#: refunded from pretix' own refund dialog, which records it by itself.
LOOK_BACK = timedelta(days=30)
#: Who the journal says cancelled a sale SumUp gave back. Not translated: it
#: names a company, and it is the same word in every language.
SUMUP = "SumUp"
#: On the organizer's settings: when the periodic task last compared it with
#: SumUp and what came of it, as JSON, for the Sales page. The one sign on
#: screen that the task runs at all: pretix leaves its pace to the server's
#: cron, anywhere from every minute to every hour.
LAST_COMPARED = "openpos_sumup_compared"


def mark_pending(refund, answer, *, transaction_id="", user=None, auth=None):
    """
    Leave a card refund in transit: SumUp has not taken it yet.

    Called on SumUp's 409, from the till and from pretix' refund dialog alike.
    Nobody has to do anything about it, and nothing may be handed back at the
    counter: the card gets the money once SumUp agrees, and :func:`reconcile_all`
    asks until it does. Written on the order once, when it starts waiting.
    """
    info = refund.info_data or {}
    starting = PENDING_SINCE not in info or refund.state != OrderRefund.REFUND_STATE_TRANSIT
    stamp = now().isoformat()
    refund.info_data = {
        **info,
        **({"transaction_id": transaction_id} if transaction_id else {}),
        PENDING_SINCE: stamp if starting else info[PENDING_SINCE],
        TRIED_AT: stamp,
        "sumup_error": answer,
    }
    refund.state = OrderRefund.REFUND_STATE_TRANSIT
    refund.save(update_fields=["state", "info"])
    if starting:
        refund.order.log_action(
            "pretix_openpos.order.refund.pending",
            data={"local_id": refund.local_id, "answer": answer},
            user=user,
            auth=auth,
        )


def pending_refunds(**filters):
    """
    Card refunds left in transit for SumUp, oldest first.

    ``filters`` narrow the query, to an event or an organizer. Filtered on the
    info in Python rather than in the query: it is JSON kept as text, and there
    are a handful of these at most.
    """
    refunds = (
        _in_transit()
        .filter(**filters)
        .select_related("order", "order__event")
        .order_by("created", "pk")
    )
    return [refund for refund in refunds if PENDING_SINCE in (refund.info_data or {})]


def terminal_for(order):
    """The reader payment behind a till's card sale, if a reader took it."""
    sale = PosSale.objects.filter(
        event_id=order.event_id, order=order, kind=PosSale.KIND_SALE
    ).first()
    return PosTerminalPayment.settling(sale)


def reconcile_all():
    """
    Compare every organizer that has something to compare with SumUp.

    For pretix' periodic task. An organizer is asked about only when a reader
    of it took a card payment that has not gone back yet, within
    :data:`LOOK_BACK`, or when one of its refunds is waiting for SumUp — so an
    installation that sold nothing by card this month makes no call at all.
    One organizer's trouble is logged and left for the next pass rather than
    stopping the others. Returns what was done, by organizer.
    """
    with scopes_disabled():
        organizers = Organizer.objects.filter(
            pk__in=set(_standing().values_list("event__organizer_id", flat=True))
            | set(_in_transit().values_list("order__event__organizer_id", flat=True))
        ).order_by("pk")
        done = {}
        for organizer in organizers:
            account = SumUpAccount(organizer)
            if not account.configured:
                continue
            try:
                done[organizer.slug] = reconcile_organizer(organizer, account)
            except Exception:
                logger.exception("Open POS could not compare %s with SumUp", organizer.slug)
                remember(organizer, {**_nothing_yet(), "crashed": True})
        return done


def _standing():
    """Reader payments SumUp could have given back without pretix hearing of it."""
    return PosTerminalPayment.objects.filter(
        status=PosTerminalPayment.STATUS_SUCCESSFUL,
        refunded__isnull=True,
        created__gte=now() - LOOK_BACK,
    ).exclude(transaction_id="")


def _in_transit():
    """Card refunds on their way, among them those waiting for SumUp."""
    return OrderRefund.objects.filter(provider=CARD, state=OrderRefund.REFUND_STATE_TRANSIT)


def anything_to_compare(organizer):
    """
    Whether a pass would ask SumUp anything about this organizer.

    The periodic task skips one that has nothing, so its last pass says
    nothing about whether the task still runs.
    """
    return (
        _standing().filter(event__organizer=organizer).exists()
        or _in_transit().filter(order__event__organizer=organizer).exists()
    )


def _nothing_yet():
    """What a pass has done before it starts, in the shape the Sales page reads."""
    return {
        "compared": False,
        "listed": 0,
        "given_back": 0,
        "sent": 0,
        "waiting": 0,
        "failed": 0,
        "error": "",
        "crashed": False,
    }


def reconcile_organizer(organizer, account=None, *, event=None):
    """
    One pass for one organizer: what SumUp gave back, then what SumUp still owes.

    In that order, so that a refund somebody made in SumUp's dashboard while
    this one was waiting is recognised before it is asked for again.

    ``event`` narrows the pass to one event's payments and refunds: the Sales
    page's button, for somebody allowed to change that event's orders and no
    other's. A pass over the whole organizer — the periodic task's — is
    written down on it with :func:`remember`.
    """
    account = account or SumUpAccount(organizer)
    done = _nothing_yet()
    _compare(organizer, account, done, event=event)
    for refund in pending_refunds(
        **({"order__event": event} if event is not None else {"order__event__organizer": organizer})
    ):
        try:
            _ask_again(refund, account, done)
        except Exception:
            logger.exception(
                "Open POS could not ask SumUp again for refund %s", refund.full_id
            )
    if event is None:
        remember(organizer, done)
    return done


def remember(organizer, done):
    """Write down a periodic pass on the organizer, for the Sales page."""
    organizer.settings.set(LAST_COMPARED, json.dumps({"at": now().isoformat(), **done}))


def last_comparison(organizer):
    """
    The last periodic pass over this organizer, or ``None`` if none ran yet.

    ``at`` is read back as a datetime. Anything unreadable counts as no pass:
    the page then says none ran, which is what it would have to say anyway.
    """
    try:
        record = json.loads(organizer.settings.get(LAST_COMPARED) or "")
        record["at"] = datetime.fromisoformat(record["at"])
    except (TypeError, ValueError, KeyError):
        return None
    return {**_nothing_yet(), **record}


def _compare(organizer, account, done, *, event=None):
    """The payments SumUp says went back, brought into pretix."""
    candidates = _standing().filter(event__organizer=organizer)
    if event is not None:
        candidates = candidates.filter(event=event)
    candidates = list(candidates)
    if not candidates:
        return
    by_id = {payment.transaction_id: payment for payment in candidates}
    by_client_id = {
        payment.client_transaction_id: payment
        for payment in candidates
        if payment.client_transaction_id
    }
    # An hour before the oldest, for any difference between SumUp's clock and
    # this one: the row here is written before the reader is even asked.
    oldest = min(payment.created for payment in candidates) - timedelta(hours=1)
    try:
        items = list(account.given_back_payments(oldest))
    except SumUpError as exc:
        # Asked again on the next pass; nothing here has changed meanwhile.
        logger.warning("SumUp's history could not be read for %s: %s", organizer.slug, exc.detail)
        done["error"] = exc.reason or str(exc.message)
        return
    done["compared"] = True
    done["listed"] = len(items)
    for item in items:
        terminal = (
            by_id.get(str(item.get("id") or ""))
            or by_id.get(str(item.get("transaction_id") or ""))
            or by_client_id.get(str(item.get("client_transaction_id") or ""))
        )
        if terminal is None:
            # Not a reader of this server's: a payment taken on the SumUp app,
            # or one already brought into line.
            continue
        try:
            if absorb(terminal, item, account=account):
                done["given_back"] += 1
        except Exception:
            logger.exception(
                "Open POS could not bring SumUp transaction %s into pretix",
                terminal.transaction_id,
            )


def absorb(terminal, transaction_data, *, account=None):
    """
    Bring pretix in line with a card payment SumUp says went back.

    ``transaction_data`` is SumUp's word on the transaction: a line of its
    history, or the transaction itself. Returns what was done, or ``None`` when
    there was nothing left to do — it runs on every pass, and a refund already
    brought into line has to cost nothing the second time.

    The whole payment given back, whoever did it:

    * a refund pretix was waiting on — a till's or the refund dialog's, left
      in transit on SumUp's "not yet" — is marked done;
    * otherwise the refund is recorded as made outside pretix, and the order,
      if it still stands, is cancelled first, as pretix' own "Cancel the
      order" would, without an email: at a till the buyer is standing there;
    * the sale leaves the journal's takings, in SumUp's name when nobody here
      asked for it;
    * the reader payment is marked given back, which takes it off the Sales
      page's list of refunds SumUp refused, and stops it being offered again.

    A part given back is only recorded, as a refund made outside pretix that
    the order page offers to process: what the order becomes then is for a
    person to decide, and one beer handed back does not cancel a round.
    """
    amount = given_back(transaction_data)
    if amount is None and account is not None:
        # Called refunded without saying how much. The transaction itself
        # lists its refunds.
        amount = given_back(account.transaction_by_id(terminal.transaction_id))
    if not amount:
        return None
    status = str(transaction_data.get("status") or transaction_data.get("simple_status") or "")
    whole = amount >= terminal.amount

    confirmed = []
    external = None
    with transaction.atomic():
        terminal = PosTerminalPayment.objects.select_for_update().get(pk=terminal.pk)
        if terminal.refunded is not None:
            return None
        sale = (
            PosSale.objects.filter(
                event_id=terminal.event_id,
                idempotency_key=terminal.idempotency_key,
                kind=PosSale.KIND_SALE,
            )
            .select_related("order")
            .first()
        )
        order = sale.order if sale is not None else None
        payment = (
            order.payments.filter(
                provider=CARD,
                state__in=(
                    OrderPayment.PAYMENT_STATE_CONFIRMED,
                    OrderPayment.PAYMENT_STATE_REFUNDED,
                ),
            )
            .order_by("-local_id")
            .first()
            if order is not None
            else None
        )
        cancelled = cancel_failed = already = False
        if payment is not None:
            refunds = list(payment.refunds.order_by("local_id"))
            # Never more than pretix took, whatever SumUp's figure: a refund
            # recorded here beyond the payment would be money pretix thinks it
            # owes back a second time.
            ceiling = min(amount, payment.amount)
            recorded = sum(
                (
                    refund.amount for refund in refunds
                    if refund.state in (
                        OrderRefund.REFUND_STATE_DONE, OrderRefund.REFUND_STATE_EXTERNAL
                    ) or _dismissed(refund)
                ),
                Decimal("0.00"),
            )
            for refund in refunds:
                if refund.state not in (
                    OrderRefund.REFUND_STATE_CREATED, OrderRefund.REFUND_STATE_TRANSIT
                ) or recorded + refund.amount > ceiling:
                    continue
                refund.info_data = {
                    **(refund.info_data or {}),
                    "transaction_id": terminal.transaction_id,
                }
                refund.save(update_fields=["info"])
                refund.done()
                recorded += refund.amount
                confirmed.append(refund)
            missing = ceiling - recorded
            if missing > 0:
                if whole and order.status in (Order.STATUS_PAID, Order.STATUS_PENDING):
                    cancelled = _cancel(order, status)
                    cancel_failed = not cancelled
                # Read again: the cancellation changed the order's total, and
                # pretix settles the new refund against it.
                payment = OrderPayment.objects.select_related("order").get(pk=payment.pk)
                if payment.order.status == Order.STATUS_CANCELED:
                    # No more than pretix still owes on an order that no
                    # longer stands. A refund somebody recorded by hand — a
                    # manual one, tied to no payment — has paid its part, and
                    # recording that money a second time would have the order
                    # say the customer owes it back. This payment's refunds
                    # still waiting for SumUp are no money back yet, though
                    # pretix counts them as if they were.
                    waiting = sum(
                        (
                            refund.amount for refund in refunds
                            if refund.state in (
                                OrderRefund.REFUND_STATE_CREATED,
                                OrderRefund.REFUND_STATE_TRANSIT,
                            )
                        ),
                        Decimal("0.00"),
                    )
                    owed = waiting - payment.order.pending_sum
                    missing = min(missing, max(Decimal("0.00"), owed))
                    already = missing == 0
            if missing > 0:
                external = payment.create_external_refund(
                    amount=missing,
                    info=json.dumps(
                        {"transaction_id": terminal.transaction_id, "sumup_status": status}
                    ),
                )
        if whole:
            terminal.refunded = now()
            terminal.save(update_fields=["refunded", "updated"])
        elif external is None and not confirmed:
            return None
        what = {
            "transaction_id": terminal.transaction_id,
            "status": status,
            "amount": str(amount),
            "whole": whole,
            "cancelled": cancelled,
            "cancel_failed": cancel_failed,
            "already": already,
            "confirmed": [refund.local_id for refund in confirmed],
            "external": external.local_id if external is not None else None,
        }
        if order is not None:
            order.log_action("pretix_openpos.order.sumup.given_back", data=what)

    if whole and order is not None:
        # Out of the takings, now the money is back. A cancellation has done
        # it already, and a till's own cancellation long before; this finds
        # either done and writes nothing.
        from .backoffice import acting_for, record_card_refund

        if confirmed:
            record_card_refund(confirmed[-1])
        elif external is not None:
            with acting_for(SUMUP):
                record_card_refund(external)
    return what


def _dismissed(refund):
    """
    A refund written here from SumUp's word that somebody then cancelled on the
    order page. Their call: it counts as recorded, so that the next pass does
    not write it again — only a part SumUp gives back afterwards is.
    """
    return (
        refund.state == OrderRefund.REFUND_STATE_CANCELED
        and "sumup_status" in (refund.info_data or {})
    )


def _cancel(order, status):
    """Cancel an order whose card payment SumUp gave back. Whether it worked."""
    from pretix.base.services.orders import OrderError, cancel_order

    from .backoffice import acting_for

    with language(order.event.settings.locale):
        comment = str(
            _("The card payment was cancelled in SumUp.")
            if status == "CANCELLED"
            else _("The card payment was refunded in SumUp.")
        )
    try:
        with acting_for(SUMUP):
            cancel_order(
                order.pk, send_mail=False, cancel_invoice=True, email_comment=comment
            )
    except OrderError as exc:
        # The refund is still recorded, and pretix offers to process it on the
        # order page — which is where somebody decides what else to do.
        logger.warning("Open POS could not cancel %s after SumUp gave it back: %s", order.code, exc)
        return False
    return True


def _ask_again(refund, account, done):
    """One more try at a refund SumUp has not taken yet."""
    terminal = terminal_for(refund.order)
    if terminal is None:
        # Nothing to name to SumUp. It cannot happen to a refund this module
        # left waiting, which named a transaction to be left waiting at all.
        return
    if terminal.refunded is not None:
        # Given back already, and written on the reader payment by whatever
        # sent it: this refund is only what pretix is still waiting on.
        _complete(refund, terminal)
        done["given_back"] += 1
        return
    try:
        current = account.transaction_by_id(terminal.transaction_id)
    except SumUpError as exc:
        _still_waiting(refund, exc.reason or str(exc.message), done)
        return
    if given_back(current) != Decimal("0.00"):
        # Given back meanwhile — in SumUp's dashboard, most likely, while this
        # was waiting — and SumUp says so on the transaction itself. Recorded
        # as such, and never sent a second time.
        if absorb(terminal, current):
            done["given_back"] += 1
        refund.refresh_from_db()
        if refund.state == OrderRefund.REFUND_STATE_TRANSIT:
            # Only part of it, or an amount SumUp does not state. Asking for
            # the whole again could be refused or could send too much: a
            # person decides.
            _give_up(refund, _status_line(current), done)
        return
    try:
        # In full, as the till and the refund dialog ask: SumUp refunds what
        # the card was charged.
        account.refund(terminal.transaction_id)
    except SumUpError as exc:
        answer = exc.reason or str(exc.message)
        if exc.code == ERR_CONFLICT or exc.retryable:
            _still_waiting(refund, answer, done)
        else:
            _give_up(refund, answer, done)
        return

    with transaction.atomic():
        terminal.refunded = now()
        terminal.save(update_fields=["refunded", "updated"])
        refund.order.log_action(
            "pretix_openpos.order.refund.accepted",
            data={"local_id": refund.local_id, "transaction_id": terminal.transaction_id},
        )
        _complete(refund, terminal)
    done["sent"] += 1


def _complete(refund, terminal):
    """Mark a waiting refund done, and take its sale out of the takings."""
    from .backoffice import record_card_refund

    refund.info_data = {
        **(refund.info_data or {}),
        "transaction_id": terminal.transaction_id,
        TRIED_AT: now().isoformat(),
    }
    refund.save(update_fields=["info"])
    refund.done()
    # A till's cancellation reversed the sale when it was made, and this finds
    # it done; a refund from pretix' dialog that left the order standing
    # reverses it now, as it would have had SumUp said yes at once.
    record_card_refund(refund)


def _status_line(transaction_data):
    """SumUp's own words for a transaction's state, for the "SumUp's answer" column."""
    words = [transaction_data.get("status"), transaction_data.get("simple_status")]
    return " · ".join(dict.fromkeys(str(word) for word in words if word))[:190]


def _since(refund):
    """When SumUp first said "not yet" to this refund."""
    try:
        return datetime.fromisoformat((refund.info_data or {})[PENDING_SINCE])
    except (KeyError, TypeError, ValueError):
        return refund.created


def _still_waiting(refund, answer, done):
    """SumUp said not yet, or could not be asked: keep waiting, up to a point."""
    if now() - _since(refund) >= GIVE_UP_AFTER:
        _give_up(refund, answer, done)
        return
    refund.info_data = {
        **(refund.info_data or {}),
        TRIED_AT: now().isoformat(),
        "sumup_error": answer,
    }
    refund.save(update_fields=["info"])
    done["waiting"] += 1


def _give_up(refund, answer, done):
    """
    Fail a refund SumUp will not take, for a person to deal with.

    It then shows as pretix shows any failed refund, and on the Sales page's
    list of refunds SumUp refused, with SumUp's last answer beside it.
    """
    since = (refund.info_data or {}).get(PENDING_SINCE)
    refund.state = OrderRefund.REFUND_STATE_FAILED
    refund.info_data = {
        **(refund.info_data or {}),
        TRIED_AT: now().isoformat(),
        "sumup_error": answer,
    }
    refund.save(update_fields=["state", "info"])
    refund.order.log_action(
        "pretix.event.order.refund.failed",
        {"local_id": refund.local_id, "provider": refund.provider, "error": answer},
    )
    refund.order.log_action(
        "pretix_openpos.order.refund.gave_up",
        data={"local_id": refund.local_id, "answer": answer, "since": since},
    )
    done["failed"] += 1
