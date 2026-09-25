"""
The card reader a till drives.

What became of a reader payment is asked of SumUp here and nowhere else, for a
till polling while it waits and for SumUp's own callback alike, and
:class:`TerminalActions` holds the three actions that put a basket on the
reader, follow it, and take it back off. How a till may take a card at all is
:func:`card_mode`.
"""
import logging
from datetime import timedelta
from decimal import Decimal

from django.core.cache import cache
from django.db import IntegrityError
from django.db.models import Q
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Device
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from ..models import PosCategory, PosDevice, PosTerminalPayment
from ..sumup import (
    CHECKOUT_CLOSED, ERR_RATE_LIMITED, POLL_TIMEOUT, SumUpAccount, SumUpError, still_running, succeeded,
)
from ..webhook import webhook_url
from .catalog import (
    custom_sale_item, deposit_item, for_date, get_pos_channel, quota_availability, refuse_oversized, resolve_line,
    sellable_items,
)
from .evenings import selling_subevent

logger = logging.getLogger(__name__)

#: The cashier takes the card themselves and tells the till so. No reader.
CARD_DECLARED = "declared"
#: A reader is assigned to this device and is the only way to pay by card on it.
CARD_TERMINAL = "terminal"

#: How long a reader is treated as held by a payment nobody has answered.
#:
#: One machine can only face one cardholder, so a payment waiting on a reader
#: holds it against every till that shares it. Past this it is a leftover
#: rather than a payment in progress — the prompt has timed out on the device
#: long before — and a leftover that held the reader for the rest of the
#: evening would be the worse failure of the two: it would take card payments
#: off the bar entirely, with nobody able to say why.
READER_HELD_FOR = timedelta(minutes=5)


def settle_terminal_payment(payment, account):
    """
    Ask SumUp what became of a reader payment, and write it down.

    The only place a payment is allowed to become successful, and the reason
    the unsigned callback is harmless: that callback causes this to run, and
    this asks the Transactions API over an authenticated connection. The till
    polls into the same function on a timer — through
    :func:`poll_terminal_payment`, which keeps that to one question at a time —
    so an installation SumUp cannot reach settles every payment anyway, a
    second or two later.

    One call to SumUp, and a second only when the first cannot answer: the
    request on the reader is asked about only while no transaction exists, and
    never after a question that got no answer at all. Every call here is bounded
    by the timeout of ``account``; a poll's account gives up early, and giving
    up leaves the row as it was.

    Giving up is said, though, on the payment itself: ``sumup_unreachable`` is
    left on it — not a column, only an answer to this call — true when SumUp
    could not be asked this time: no answer in time, no connection, or SumUp
    failing on its side. The row then says "pending" because nobody could find
    out otherwise, which is not the same news for a cashier as a cardholder
    still looking for their card, and the till is told so.
    """
    payment.sumup_unreachable = False
    if payment.settled:
        return payment
    if not payment.client_transaction_id:
        # The checkout call never came back with a handle, so there is nothing
        # to ask about yet. Saying "not paid" here would be the same mistake as
        # writing a refusal on a timeout: this row is still open, and the way
        # it closes is the reader being cleared, not a guess made here.
        return payment
    try:
        transaction_data = account.transaction(payment.client_transaction_id)
    except SumUpError as exc:
        if exc.retryable or exc.code == ERR_RATE_LIMITED:
            # Nothing is written. "We could not ask" is not "it failed", and
            # writing the latter would lose a payment that went through while
            # a cable was out — money taken, no sale, and nothing to point at.
            # SumUp asking for a moment's peace (its 429) is the same news:
            # the question went unanswered, and a busy evening with several
            # tills waiting on cards is exactly when it says so.
            payment.sumup_unreachable = True
            return payment
        payment.status = PosTerminalPayment.STATUS_FAILED
        payment.failure = str(exc.message)[:190]
        payment.save(update_fields=["status", "failure", "updated"])
        return payment

    if transaction_data is None and payment.checkout_id:
        # No card has been presented, which on its own says nothing: the
        # customer may still be looking for theirs. The request on the reader
        # knows better — it reads cancelled once the cashier has pressed stop,
        # or once it expired with nobody in front of it — and without asking
        # it, the till went on waiting for a card that was never coming, with
        # the reader held against every till that shares it. Only a request
        # that ended unpaid closes the payment here: "successful" waits for
        # the transaction, which is what a refund will need.
        checkout = account.reader_checkout(payment.reader_id, payment.checkout_id)
        if checkout and checkout.get("status") in CHECKOUT_CLOSED:
            payment.status = PosTerminalPayment.STATUS_FAILED
            # SumUp's word, in the same case as the Transactions API's, which
            # is what the till turns into a sentence.
            payment.failure = str(checkout["status"]).upper()[:190]
            payment.save(update_fields=["status", "failure", "updated"])
            logger.info(
                "Reader checkout %s ended %s: %s",
                payment.checkout_id,
                checkout["status"],
                checkout.get("payment_failure_reason") or "no reason given",
            )
        return payment

    if still_running(transaction_data):
        return payment

    if succeeded(transaction_data):
        payment.status = PosTerminalPayment.STATUS_SUCCESSFUL
        # Kept rather than looked up again: this is what a refund needs, and by
        # the time one is asked for it is the shortest way back to the money.
        payment.transaction_id = str(transaction_data.get("id") or "")
    else:
        payment.status = PosTerminalPayment.STATUS_FAILED
        payment.failure = str(transaction_data.get("status") or "")[:190]
    payment.save(update_fields=["status", "transaction_id", "failure", "updated"])
    return payment


#: How often, at most, SumUp is asked about any one reader payment, in seconds.
#:
#: The till polls on a timer while the cardholder looks for their card, and a
#: till that reloads, or a second tab on the same tablet, polls on a timer of
#: its own. A poll arriving sooner than this after the last question is
#: answered from the row as it stands, which is what the question would almost
#: always have said. When SumUp can reach this server, its callback is what
#: brings the answer in sooner.
ASK_SUMUP_EVERY = 2

#: How long a question about one reader payment is taken to be under way when
#: nothing says it has finished, in seconds.
#:
#: The mark is taken off the moment the answer is in; this only bounds what a
#: worker that died in the middle of a question costs. Longer than the slowest
#: a poll can be — two calls to SumUp, each bounded by POLL_TIMEOUT — and short
#: enough that such a death costs a waiting till a few polls, not the payment.
ASKING_FOR_AT_MOST = 20


def poll_terminal_payment(payment, account):
    """
    :func:`settle_terminal_payment`, for a till waiting on its reader.

    One question to SumUp at a time about any one payment, and no more than one
    every :data:`ASK_SUMUP_EVERY` seconds. A poll that finds a question already
    under way, or one asked a moment ago, is answered from the row as it
    stands: the same shape and the same meaning as any other answer, "still
    waiting" until the question in flight writes otherwise. Without this,
    every poll of every waiting till held a worker for as long as SumUp took to
    answer, and a pretix runs on a handful of workers: two tills waiting on a
    slow SumUp were enough to leave every other request of the evening — the
    other tills, the door, the web shop, the health probe — queueing behind
    them.

    Through the cache because that is the one thing every worker process
    shares: Redis or memcached, on a pretix set up for production. On one
    with neither, pretix' cache keeps nothing, every poll asks as it always
    did, and the short timeouts of the polling account are what bound it.

    SumUp's callback does not come through here. It says the payment has just
    ended, and a question already under way may have been asked the moment
    before and come back "pending": skipping the callback's own question on its
    account would leave the payment waiting for the next poll — or for nothing,
    once the till has gone.

    A poll answered from the row says whether the last question got through,
    as one that asks does (``sumup_unreachable``, see
    :func:`settle_terminal_payment`): a till whose every other poll was
    answered from the row would otherwise hear that SumUp is out of reach only
    every other time.
    """
    if payment.settled:
        return payment
    marks = f"pretix_openpos:terminal:{payment.pk}"
    unreachable = f"{marks}:unreachable"
    asking = f"{marks}:asking"
    if not (
        cache.add(f"{marks}:asked", True, timeout=ASK_SUMUP_EVERY)
        and cache.add(asking, True, timeout=ASKING_FOR_AT_MOST)
    ):
        payment.sumup_unreachable = bool(cache.get(unreachable))
        return payment
    try:
        # Read again now that this is the one question. Another may have
        # settled the payment between this request reading the row and taking
        # the mark, and asking SumUp once more would only hear the same answer
        # a second time.
        payment.refresh_from_db()
        settle_terminal_payment(payment, account)
        # Kept for as long as a question may take: the polls answered from the
        # row while the next one is under way repeat what this one found.
        if payment.sumup_unreachable:
            cache.set(unreachable, True, timeout=ASKING_FOR_AT_MOST)
        else:
            cache.delete(unreachable)
        return payment
    finally:
        cache.delete(asking)


def reader_moved_on(payment, organizer):
    """
    Whether the reader this payment was put on is no longer this payment's.

    SumUp's terminate stops whatever is on the reader, not a payment of our
    choosing, and two tills can share one machine. So a stop is only sent while
    this payment can still be the one on it. Not once a newer payment has been
    put on the same reader, whichever till it belongs to: the stop would be
    that payment's. And not past :data:`READER_HELD_FOR`: by then the prompt
    has long timed out on the device, and the machine counts as free for any
    till that asks for it. A till tidying up a payment it left aside — the
    cashier took cash while the reader was not answering, and the network is
    back — meets exactly this, some minutes later.
    """
    if payment.created <= now() - READER_HELD_FOR:
        return True
    return PosTerminalPayment.objects.filter(
        # Two tills pressing card in the same instant can write the same
        # timestamp; the row written second is then the newer one, so that
        # of two such payments exactly one may still stop the reader.
        Q(created__gt=payment.created) | Q(created=payment.created, pk__gt=payment.pk),
        event__organizer=organizer,
        reader_id=payment.reader_id,
    ).exists()


def card_mode(pos_device) -> str:
    """
    How this device is allowed to take a card payment.

    ``"terminal"`` once a reader is assigned to it: the money goes through that
    reader, and the server will not record a card sale the reader did not
    validate. ``"declared"`` otherwise, which is what every till has done until
    now and what the door goes on doing — the cashier takes the card in the
    vendor's own app on their phone and tells the till it happened.
    """
    return CARD_TERMINAL if pos_device.drives_terminal else CARD_DECLARED


class TerminalActions:
    """A payment on the calling till's reader: started, followed, and stopped."""

    # -- the card reader ---------------------------------------------------

    def _terminal_context(self, request, *, waiting=False):
        """
        The reader this till drives, refusing every till that drives none.

        ``waiting`` is for the calls a till makes while a cardholder is in front
        of the reader — asking how the payment is going, stopping it — whose
        account gives up on SumUp after :data:`~pretix_openpos.sumup.POLL_TIMEOUT`
        rather than the full timeout a payment is started with. See there.
        """
        device = request.auth if isinstance(request.auth, Device) else None
        pos_device = PosDevice.for_device(device)
        if not pos_device.drives_terminal:
            raise ValidationError(
                {"detail": [_("No card reader is assigned to this till.")],
                 "code": "no_terminal"}
            )
        account = (
            SumUpAccount(request.event.organizer, timeout=POLL_TIMEOUT)
            if waiting
            else SumUpAccount(request.event.organizer)
        )
        return device, pos_device, account

    def _terminal_payload(self, payment):
        return {
            "status": payment.status,
            "amount": str(payment.amount),
            "currency": payment.currency,
            "failure": payment.failure,
            # True when this answer is the stored row because SumUp could not
            # be asked — this time, or by the question a moment ago this poll
            # was answered from. "pending" then means "nobody could find out",
            # and a till that has been told that long enough can offer the
            # cashier a way out rather than a reader that seems to wait
            # forever. False whenever SumUp answered, and on a payment just
            # put on the reader, which nobody has asked about yet.
            "sumup_unreachable": getattr(payment, "sumup_unreachable", False),
        }

    @staticmethod
    def _refuse_if_reader_is_busy(event, reader_id, idempotency_key, account):
        """
        One reader, one cardholder — even when two tills share it.

        Two tablets behind one bar with one machine between them is a shape
        Open POS allows, and nothing in SumUp's reader checkout makes it safe
        on its own: it answers the *second* call with "busy", by which time
        this server has written a payment row and spent the till's idempotency
        key on a basket that never reached the reader. The cashier is then
        looking at a failure for a payment that was never attempted, holding a
        key they cannot reuse.

        So the refusal is made here, before anything is written. The other till
        keeps its cardholder, this one is told to wait or take cash, and its
        basket is untouched — the key is minted per attempt, so pressing card
        again a moment later is a clean first try rather than a retry.
        """
        if not reader_id:
            return
        held = (
            PosTerminalPayment.objects.filter(
                event__organizer=event.organizer,
                reader_id=reader_id,
                status=PosTerminalPayment.STATUS_PENDING,
            )
            .exclude(idempotency_key=idempotency_key)
            .order_by("-created")
            .first()
        )
        if held is None:
            return
        # Asked rather than assumed. The row reads pending because nobody has
        # looked since it was written, which is not the same as the cardholder
        # still standing there; this is the very call the other till's poll
        # makes, and it is how a finished payment stops holding the machine.
        # Made the way that poll makes it, too: when the other till has just
        # asked, or is asking right now, its answer is the one read here — at
        # worst a moment old, which costs this cashier a second tap.
        held = poll_terminal_payment(held, account)
        if held.status != PosTerminalPayment.STATUS_PENDING:
            return

        if held.created > now() - READER_HELD_FOR:
            raise ValidationError(
                {"detail": [
                    _("The card reader is taking another payment. Wait for it to "
                      "finish, or take this basket in cash.")
                ], "code": "terminal_busy"}
            )

        # Long past anything a customer is still standing in front of. Clear
        # the machine before using it, or SumUp refuses the checkout below and
        # the cashier is left with a reader that says nothing. Best-effort by
        # SumUp's own account, and safe to do here for the reason above: if the
        # cardholder had in fact answered, settling would have said so and this
        # line would not be reached.
        try:
            account.terminate_checkout(reader_id)
        except SumUpError:
            logger.info("Reader %s would not clear before a new payment", reader_id)

    @action(detail=False, methods=["post"], url_path="terminal/start", url_name="terminal-start")
    def terminal_start(self, request, **kwargs):
        """
        Put the basket on the reader and let the cardholder answer it.

        The amount is priced here, by the same code that books the order, and
        the priced basket is kept: what the card is charged and what the order
        says are the same figures by construction rather than by comparison.
        """
        from .serializers import TerminalStartSerializer

        event = request.event
        device, _pos_device, account = self._terminal_context(request)

        serializer = TerminalStartSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        idempotency_key = data["idempotency_key"]

        # A second tap, a retried request, or a till that reloaded mid-payment.
        # SumUp's reader checkout has no idempotency key of its own, so this is
        # the only thing standing between a double tap and a double charge.
        existing = PosTerminalPayment.objects.filter(
            event=event, idempotency_key=idempotency_key
        ).first()
        if existing:
            return Response(
                self._terminal_payload(settle_terminal_payment(existing, account)),
                status=status.HTTP_200_OK,
            )

        # Here, before any card is asked for: the checkout that follows books
        # this basket as it was pinned, and asks nothing of its size again.
        refuse_oversized(data["positions"])

        self._refuse_if_reader_is_busy(
            event, _pos_device.sumup_reader_id, idempotency_key, account
        )

        channel = get_pos_channel(event.organizer)
        custom_item = custom_sale_item(event)
        deposit = deposit_item(event)
        subevent = selling_subevent(event)
        sellable = sellable_items(event, channel, settled=False)
        # Refused here too, and this is the one that matters: the checkout
        # records a basket the reader has already charged rather than refusing
        # it, so a forbidden line that got as far as a cardholder would be
        # written down instead of turned away. Nothing has moved yet at this
        # point, and refusing costs a tap.
        off_limits = PosCategory.off_limits(event, _pos_device)

        priced = []
        total = Decimal("0.00")
        quota_cache = {}
        for line in data["positions"]:
            resolved = resolve_line(
                line,
                sellable=sellable,
                custom_item=custom_item,
                deposit=deposit,
                settled=False,
                subevent=subevent,
                off_limits=off_limits,
            )
            total += resolved.price * resolved.count
            if not resolved.refund:
                # Checked before the money moves, not after. It is not airtight
                # against two tills selling the last ticket in the same second
                # — the order is created a moment later, and is forced through
                # by then because refusing a paid card would be worse — but it
                # is what stops a sold-out product reaching a cardholder.
                quotas = for_date(
                    resolved.variation.quotas.all()
                    if resolved.variation
                    else resolved.item.quotas.all(),
                    subevent,
                )
                available = quota_availability(quotas, quota_cache)
                if available is not None and available < resolved.count:
                    raise ValidationError(
                        {"positions": [
                            _("{name} is sold out.").format(name=str(resolved.item.name))
                        ], "code": "sold_out"}
                    )
            priced.append(
                {
                    "item": resolved.item.pk,
                    "variation": resolved.variation.pk if resolved.variation else None,
                    "count": resolved.count,
                    "price": str(resolved.price),
                    "description": resolved.description,
                    "refund": resolved.refund,
                }
            )

        if total <= Decimal("0.00"):
            # There is no such thing as a card payment for nothing, and none
            # for less than nothing either. A basket that nets out at or below
            # zero is money leaving the drawer — a returned deposit, mostly —
            # and SumUp cannot send money to a card that no transaction of its
            # own stands behind. The drawer is the only way out, and saying so
            # here beats a reader that sits waiting for a card that can never
            # settle it.
            raise ValidationError(
                {"detail": [_("Nothing is due on this basket. Settle it in cash.")],
                 "code": "nothing_to_charge"}
            )

        try:
            payment = PosTerminalPayment.objects.create(
                event=event,
                device=device,
                device_serial=device.unique_serial if device else "",
                idempotency_key=idempotency_key,
                reader_id=_pos_device.sumup_reader_id,
                amount=total,
                currency=event.currency,
                positions=priced,
                status=PosTerminalPayment.STATUS_PENDING,
            )
        except IntegrityError:
            # Two taps in the same second: the look-up above found nothing for
            # either of them and the unique key let one through. The loser
            # takes the winner's payment rather than faulting, which is the
            # same answer a second tap gets a moment later.
            existing = PosTerminalPayment.objects.filter(
                event=event, idempotency_key=idempotency_key
            ).first()
            if existing is None:
                raise
            return Response(
                self._terminal_payload(settle_terminal_payment(existing, account)),
                status=status.HTTP_200_OK,
            )
        # Written before the reader is asked, deliberately: if this process
        # dies between the two, the row is there to be settled from SumUp
        # rather than a charge nobody in pretix has ever heard of. The reverse
        # order would lose exactly the payments that matter most.
        try:
            payment.client_transaction_id, payment.checkout_id = account.start_checkout(
                _pos_device.sumup_reader_id,
                amount=total,
                currency=event.currency,
                description=f"{event.name} · {device.name if device else ''}".strip(" ·"),
                return_url=webhook_url(event.organizer),
            )
        except SumUpError as exc:
            if exc.retryable:
                # "We could not ask" is not "it failed" — the rule the rest of
                # this module is built on, and the one place it was not kept.
                # The request may well have reached SumUp and put the amount on
                # the reader, with only the answer lost. Writing a refusal here
                # sends the cashier back to a fresh basket with a *new* key
                # while a cardholder is looking at a live prompt, which is how
                # one basket becomes two charges. So the row stays pending, and
                # the till is told what is actually known: go and look at the
                # reader.
                raise ValidationError(
                    {"detail": [exc.message], "code": "terminal_unsure"}
                )
            payment.status = PosTerminalPayment.STATUS_FAILED
            # Truncated like every other write to this column: the message is
            # translated, and a language with longer words must not turn a
            # refusal into a database error.
            payment.failure = str(exc.message)[:190]
            payment.save(update_fields=["status", "failure", "updated"])
            raise ValidationError(
                {"detail": [exc.message], "code": "terminal_unreachable"}
            )
        payment.save(update_fields=["client_transaction_id", "checkout_id", "updated"])

        return Response(self._terminal_payload(payment), status=status.HTTP_201_CREATED)

    @action(detail=False, methods=["get"], url_path="terminal/status", url_name="terminal-status")
    def terminal_status(self, request, **kwargs):
        """
        Where a payment has got to. Polled by the till while it waits.

        Answered from the row as it stands whenever SumUp cannot be asked in
        good time — no answer within POLL_TIMEOUT, a question about this payment
        already under way, one asked a moment ago (:func:`poll_terminal_payment`)
        — so a slow SumUp makes a till wait a little longer for its answer, and
        never makes it read a failure.
        """
        device, _pos_device, account = self._terminal_context(request, waiting=True)
        payment = PosTerminalPayment.objects.filter(
            event=request.event, idempotency_key=request.query_params.get("idempotency_key", "")
        ).first()
        # Checked here as well as at checkout: a key is not a secret, and one
        # till has no business watching — or ending — another till's payment.
        if payment is None or not payment.belongs_to(device):
            raise ValidationError(
                {"detail": [_("No card payment was started for this basket.")],
                 "code": "no_payment"}
            )
        return Response(self._terminal_payload(poll_terminal_payment(payment, account)))

    @action(detail=False, methods=["post"], url_path="terminal/cancel", url_name="terminal-cancel")
    def terminal_cancel(self, request, **kwargs):
        """
        Take the amount back off the reader.

        Best-effort, and honestly so: SumUp confirms nothing, and the device
        only obeys while it is still waiting for the cardholder. So the answer
        is whatever the payment turns out to be afterwards, not whatever was
        asked for — a card tapped in the same second is a payment, and the till
        has to be told that rather than a cancellation that did not happen.

        The stop is sent whenever the reader can still be this payment's, and
        what the payment became is then asked the way a poll asks it: the till
        reads a "pending" here exactly as it reads one from a poll, and its
        next poll says how it ended.

        When the reader has moved on (:func:`reader_moved_on`), nothing is sent
        to it, and SumUp is asked directly what became of this payment: a card
        charged is answered as such, a request SumUp calls over closes the
        payment as any poll would, and one still open by SumUp's account — or
        one SumUp could not be asked about — is answered ``reader_moved_on``.
        The row is not written off then: only SumUp says whether a card was
        charged, and a payment left open is still settled by the next question
        anybody asks about it.
        """
        device, _pos_device, account = self._terminal_context(request, waiting=True)
        payment = PosTerminalPayment.objects.filter(
            event=request.event,
            idempotency_key=request.data.get("idempotency_key", ""),
        ).first()
        if payment is None or not payment.belongs_to(device):
            raise ValidationError(
                {"detail": [_("No card payment was started for this basket.")],
                 "code": "no_payment"}
            )
        if not payment.settled and reader_moved_on(payment, request.event.organizer):
            # Directly rather than through the poll's guard: this answer says
            # whether a card was charged for a basket the cashier may since have
            # taken in cash, and a one-off request like this one is not what
            # the guard protects the workers from.
            settle_terminal_payment(payment, account)
            if not payment.settled:
                return Response(
                    {
                        "detail": [
                            _("This payment is no longer the one on the card reader, so the "
                              "reader was left alone.")
                        ],
                        "code": "reader_moved_on",
                        **self._terminal_payload(payment),
                    },
                    status=status.HTTP_400_BAD_REQUEST,
                )
            return Response(self._terminal_payload(payment))
        if not payment.settled:
            try:
                # The reader this payment was put on, not whichever one the
                # till has been given since. An organizer tidying up the device
                # screen mid-evening would otherwise have this stop a stranger's
                # payment while the one being cancelled goes on waiting.
                account.terminate_checkout(payment.reader_id)
            except SumUpError:
                # Already finished, already gone, or unreachable. Asking SumUp
                # what actually happened answers all three.
                pass
        return Response(self._terminal_payload(poll_terminal_payment(payment, account)))
