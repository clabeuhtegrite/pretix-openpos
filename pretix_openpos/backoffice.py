"""
What pretix' own back office does to a till's order, written to the journal.

The till is not the only place a sale can be cancelled. pretix' order page has
a Cancel button, its REST API a cancel endpoint, and an organiser can cancel a
whole event at once. None of them used to reach the journal, so a sale struck
off in pretix went on counting in the evening's takings — and the till could no
longer reverse it either, because pretix already said it was cancelled.

pretix tells plugins about every cancellation and every reactivation, with a
signal carrying the order. This module answers both. A cancellation made
anywhere but at a till becomes a reversal in the journal, in the name of
whoever made it; a reactivation undoes that reversal when the money never left.
Both are new rows, as everything in the journal is: nothing written before is
touched.
"""
import contextvars
import logging
from contextlib import contextmanager
from decimal import Decimal

from django.db import transaction
from django.db.models import Q
from pretix.base.i18n import language
from pretix.base.models import Order
from pretix.base.models.orders import OrderFee

from .models import PosSale, refund_key, reversed_positions

logger = logging.getLogger(__name__)

#: Set while a till cancels an order through pretix' own service.
_till_cancelling = contextvars.ContextVar("openpos_till_cancelling", default=False)


@contextmanager
def till_cancelling():
    """
    Mark the cancellation about to run as the till's own.

    The till writes its reversal itself — with the till, the cashier and the
    key the app sent, which is what a retried request finds again — so the
    signal pretix sends at the end of that same cancellation must not write a
    second one. A context variable rather than an argument, because the signal
    is pretix' and carries nothing but the order.
    """
    token = _till_cancelling.set(True)
    try:
        yield
    finally:
        _till_cancelling.reset(token)


def cancelled_by_a_till() -> bool:
    return _till_cancelling.get()


def _journal_rows(order):
    """
    The rows a till wrote for this order: the sale, and the deposit handed back
    in the same basket.

    The deposit row has no order of its own — pretix cannot hold one — and is
    found by the key the sale's derives, which is how the two were written
    together. Reversing only the sale would leave the takings short by the
    cups for good: the customer paid the net, and the net is what goes back.
    """
    sales = list(
        PosSale.objects.filter(
            event=order.event, order=order, kind=PosSale.KIND_SALE
        ).order_by("seq")
    )
    if not sales:
        return []
    deposits = list(
        PosSale.objects.filter(
            event=order.event,
            kind=PosSale.KIND_DEPOSIT_REFUND,
            idempotency_key__in=[refund_key(sale.idempotency_key) for sale in sales],
        ).order_by("seq")
    )
    return sales + deposits


def _latest_entry(order, action_type):
    return (
        order.all_logentries()
        .filter(action_type=action_type)
        .order_by("-datetime", "-pk")
        .first()
    )


def _who(entry):
    """
    Whoever pretix says made the change, as text the journal can keep.

    Copied rather than pointed at, like a cashier's name: the journal outlives
    user accounts, API tokens and devices alike, and its row has to go on
    saying who did it after they are gone. Blank when pretix names nobody —
    a customer cancelling their own order, for one.
    """
    if entry is None:
        return ""
    if entry.user:
        return entry.user.get_full_name()[:190]
    for actor in (entry.api_token, entry.oauth_application, entry.device):
        if actor is not None:
            return (actor.name or "")[:190]
    return ""


def _cancellation_fee_line(event, amount):
    """A journal line for what a cancellation kept, named as pretix names it."""
    with language(event.settings.locale):
        name = str(dict(OrderFee.FEE_TYPES)[OrderFee.FEE_TYPE_CANCELLATION])
    return {
        "item": None,
        "item_name": name,
        "variation": None,
        "variation_name": None,
        "count": 1,
        "unit_price": str(amount),
        "line_total": str(amount),
        "fee": OrderFee.FEE_TYPE_CANCELLATION,
    }


def journal_cancellation(order, *, recorded_at=None):
    """
    Reverse, in the journal, a till's sale that pretix has cancelled.

    Returns the rows written: none for an order no till sold, and none for a
    sale the journal already shows reversed.

    A cancellation that kept a fee leaves the order standing, at that fee — the
    customer is owed the rest and not the whole. The sale's reversal carries
    the fee as a line of its own, so the column still adds up to what was kept
    and a reader can see why the reversal is short of the sale.
    """
    rows = _journal_rows(order)
    if not rows:
        return []
    event = order.event
    already = PosSale.cancelled_seqs(event, [row.seq for row in rows])
    live = [row for row in rows if row.seq not in already]
    if not live:
        return []

    entry = _latest_entry(order, "pretix.event.order.canceled")
    who = _who(entry)
    reason = ((entry.parsed_data.get("comment") if entry else "") or "")[:190]
    kept = order.total if order.status != Order.STATUS_CANCELED else Decimal("0.00")

    written = []
    with transaction.atomic():
        for row in live:
            positions = reversed_positions(row.positions)
            total = -row.total
            if kept and row.kind == PosSale.KIND_SALE:
                positions.append(_cancellation_fee_line(event, kept))
                total += kept
                kept = Decimal("0.00")
            # Which reversal of this row it is. A sale can be cancelled,
            # reactivated and cancelled again, and each time is a row of its
            # own that needs a key no earlier one holds.
            generation = PosSale.objects.filter(
                event=event, kind=PosSale.KIND_CANCELLATION, cancels_seq=row.seq
            ).count() + 1
            written.append(
                PosSale.record(
                    event=event,
                    # As the till does it: the order goes on the sale's
                    # reversal, and the deposit's has none to carry.
                    order=order if row.kind == PosSale.KIND_SALE else None,
                    device=None,
                    cashier=who,
                    payment_type=row.payment_type,
                    total=total,
                    positions=positions,
                    idempotency_key=f"backoffice:{row.seq}:cancellation:{generation}",
                    testmode=row.testmode,
                    kind=PosSale.KIND_CANCELLATION,
                    cancels_seq=row.seq,
                    reason=reason,
                    recorded_at=recorded_at,
                )
            )
    return written


def journal_reactivation(order):
    """
    Undo, in the journal, the cancellation of a till's sale pretix has reactivated.

    Only when the order comes back paid. pretix reactivates a paid order when
    no money went back — a cancellation nobody refunded — and a pending one
    when it did; in that case the customer holds the money again and the sale
    is not takings, so the reversal stands and the order says why.

    Returns ``(rows written, reversals left standing)``.
    """
    rows = _journal_rows(order)
    if not rows:
        return [], []
    event = order.event
    cancellations = list(
        PosSale.objects.filter(
            event=event,
            kind=PosSale.KIND_CANCELLATION,
            cancels_seq__in=[row.seq for row in rows],
        ).order_by("seq")
    )
    undone = PosSale.cancelled_seqs(event, [c.seq for c in cancellations])
    live = [c for c in cancellations if c.seq not in undone]
    if not live or order.status != Order.STATUS_PAID:
        return [], live

    who = _who(_latest_entry(order, "pretix.event.order.reactivated"))
    written = []
    with transaction.atomic():
        for cancellation in live:
            written.append(
                PosSale.record(
                    event=event,
                    order=order if cancellation.order_id else None,
                    device=None,
                    cashier=who,
                    payment_type=cancellation.payment_type,
                    total=-cancellation.total,
                    positions=reversed_positions(cancellation.positions),
                    # One reactivation per cancellation, ever: once undone it
                    # is out of `live` above for good.
                    idempotency_key=f"backoffice:{cancellation.seq}:reactivation",
                    testmode=cancellation.testmode,
                    kind=PosSale.KIND_REACTIVATION,
                    cancels_seq=cancellation.seq,
                )
            )
    return written, []


def _summary(rows):
    return [
        {"seq": row.seq, "cancels_seq": row.cancels_seq, "total": str(row.total)}
        for row in rows
    ]


def _failed(order, action, exc):
    """Say on the order that the journal missed this, without failing pretix."""
    logger.exception("Open POS could not journal the %s of %s", action, order.code)
    try:
        order.log_action(
            "pretix_openpos.order.journal.failed",
            data={"action": action, "error": exc.__class__.__name__},
        )
    except Exception:  # pragma: no cover - nothing left to tell
        logger.exception("Open POS could not log that either")


def record_cancellation(order, *, recorded_at=None, user=None, late=False):
    """
    Journal a cancellation made outside the till, and say so on the order.

    Called from pretix' signal, at the end of pretix' own cancellation, and
    from the Sales page's catch-up. The order is cancelled whatever happens
    here, so nothing here may raise. A row
    that could not be written is logged on the order, and the Sales page keeps
    listing the sale until somebody writes it — see
    :func:`cancelled_outside_the_journal`.
    """
    try:
        # A savepoint, so that a failure here leaves whatever transaction
        # pretix is running usable for the rest of its work.
        with transaction.atomic():
            written = journal_cancellation(order, recorded_at=recorded_at)
            if written:
                order.log_action(
                    "pretix_openpos.order.journal.cancelled",
                    # `late` when the Sales page's catch-up wrote it, long
                    # after pretix cancelled: the history then says why the
                    # line comes after the fact.
                    data={"rows": _summary(written), "late": late},
                    user=user,
                )
    except Exception as exc:
        _failed(order, "cancellation", exc)
        return []
    return written


def record_reactivation(order):
    """Journal a reactivation, or say on the order why the journal keeps it cancelled."""
    try:
        with transaction.atomic():
            written, standing = journal_reactivation(order)
            if written:
                order.log_action(
                    "pretix_openpos.order.journal.reactivated",
                    data={"rows": _summary(written)},
                )
            elif standing:
                order.log_action(
                    "pretix_openpos.order.journal.not_restored",
                    data={"rows": _summary(standing)},
                )
    except Exception as exc:
        _failed(order, "reactivation", exc)
        return []
    return written


def cancelled_outside_the_journal(event, limit=200):
    """
    Till sales pretix has cancelled that the journal still counts.

    Every one of these was cancelled before Open POS listened for it — or while
    writing it failed, which the order's history then says. Until it is in the
    journal, it inflates the takings of the evening it was sold on.

    An order that kept a cancellation fee stays paid, and is recognised by its
    cancellation date instead; a reactivation clears that date, so an order
    brought back does not show up here.
    """
    sales = list(
        PosSale.objects.filter(event=event, kind=PosSale.KIND_SALE)
        .filter(
            Q(order__status=Order.STATUS_CANCELED)
            | Q(order__cancellation_date__isnull=False)
        )
        .select_related("order")
        .order_by("seq")[:limit]
    )
    if not sales:
        return []
    already = PosSale.cancelled_seqs(event, [sale.seq for sale in sales])
    return [sale for sale in sales if sale.seq not in already]


def catch_up(event, *, user=None):
    """
    Write into the journal every cancellation it missed, dated when pretix made it.

    Dated then rather than now, because that is when the sale stopped standing:
    the reversal lands in the evening it belongs to, as a replayed offline sale
    does. Returns the number of sales reversed.
    """
    reversed_sales = 0
    for sale in cancelled_outside_the_journal(event):
        order = sale.order
        entry = _latest_entry(order, "pretix.event.order.canceled")
        when = entry.datetime if entry else order.cancellation_date
        written = record_cancellation(order, recorded_at=when, user=user, late=True)
        reversed_sales += sum(1 for row in written if row.order_id)
    return reversed_sales
