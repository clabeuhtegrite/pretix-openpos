"""
The cash drawer: opened with a float, fed by the sales, counted, closed.

One module for the rules, called from both sides — the till's API and the
back office — so that there is exactly one place deciding what a drawer
should hold, and one place writing its ledger.

What a drawer should hold is never stored. It is worked out, every time it is
asked for, from the two append-only records that between them saw every euro
move: the drawer's own ledger (:class:`~.models.PosDrawerEntry` — the float,
cash put in, cash taken out) and the sales journal (:class:`~.models.PosSale`
— every sale, cancellation and returned deposit, each naming the opening it
belongs to). A stored running total would be a third record, and the first one
to be wrong.
"""
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Q, Sum
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _

from .models import CENT, PosDrawer, PosDrawerEntry, PosDrawerSession, PosSale

ZERO = Decimal("0.00")

NOTE = "note"
COIN = "coin"

#: Notes and coins a drawer is counted in, largest first.
#:
#: What an association's drawer actually meets, not every denomination that is
#: legal tender: a 500-euro note behind a bar is an event of its own, and a
#: list with it in makes every count one row longer. Anything missing is still
#: countable — the till can take the total typed in instead.
DENOMINATIONS = {
    "EUR": (
        [(value, NOTE) for value in ("200", "100", "50", "20", "10", "5")]
        + [(value, COIN) for value in ("2", "1", "0.50", "0.20", "0.10", "0.05", "0.02", "0.01")]
    ),
    "CHF": (
        [(value, NOTE) for value in ("200", "100", "50", "20", "10")]
        + [(value, COIN) for value in ("5", "2", "1", "0.50", "0.20", "0.10", "0.05")]
    ),
    "GBP": (
        [(value, NOTE) for value in ("50", "20", "10", "5")]
        + [(value, COIN) for value in ("2", "1", "0.50", "0.20", "0.10", "0.05", "0.02", "0.01")]
    ),
    "USD": (
        [(value, NOTE) for value in ("100", "50", "20", "10", "5", "1")]
        + [(value, COIN) for value in ("0.25", "0.10", "0.05", "0.01")]
    ),
    "CAD": (
        [(value, NOTE) for value in ("100", "50", "20", "10", "5")]
        + [(value, COIN) for value in ("2", "1", "0.25", "0.10", "0.05")]
    ),
}


def denominations_for(currency):
    """``[{"value": "50.00", "kind": "note"}, …]``, or empty for a currency not listed."""
    return [
        {"value": str(Decimal(value).quantize(CENT)), "kind": kind}
        for value, kind in DENOMINATIONS.get(currency, ())
    ]


class DrawerError(Exception):
    """
    A drawer operation refused, with a code the till acts on.

    The code is what the app reads — ``drawer_closed`` opens the drawer panel,
    ``count_stale`` sends the volunteer back to counting — and the message is
    what a person reads, in their own language.
    """

    def __init__(self, code, message):
        super().__init__(str(message))
        self.code = code
        self.message = message


def drawer_closed():
    return DrawerError(
        "drawer_closed",
        _("This till's cash drawer is not open. Open it on a counted float before "
          "taking or handing back cash."),
    )


def drawer_stale():
    return DrawerError(
        "drawer_stale",
        _("This till's cash drawer was opened on an earlier day and never closed. "
          "Close it, then open tonight's, before taking or handing back cash."),
    )


def no_drawer():
    return DrawerError("no_drawer", _("No cash drawer is assigned to this till."))


def open_session_of(drawer):
    """The opening of this drawer that is still running, or ``None``."""
    if drawer is None:
        return None
    return drawer.sessions.filter(closed_at__isnull=True).first()


def session_at(drawer, moment):
    """
    The opening that was running at ``moment``, or ``None``.

    For a sale replayed from a till that was cut off: its money went into
    whichever opening was running when the customer paid, which may well
    have been closed since. Nothing about that is refused — the cash is in a
    drawer, and the report says it arrived after the count.
    """
    if drawer is None:
        return None
    return (
        drawer.sessions.filter(opened_at__lte=moment)
        .filter(Q(closed_at__isnull=True) | Q(closed_at__gte=moment))
        .order_by("-opened_at", "-pk")
        .first()
    )


def is_stale(session, event, at=None):
    """
    Whether an opening began on an earlier till day than this one.

    Measured against the same six o'clock the takings reset at, so an evening
    that crosses midnight is one opening, and a drawer nobody closed last
    Saturday is not tonight's.
    """
    from .api.evenings import start_of_business_day

    return session.opened_at < start_of_business_day(event, at)


def figures(session):
    """
    Everything the closing report adds up, and what the drawer should hold.

    ``expected`` is the float, plus the cash sales, less the cash handed back
    (cancellations and returned deposits, whose totals are negative), plus
    the money put in, less the money taken out. Card figures are there for the
    report and nowhere near that sum; test-mode sales are counted apart,
    because their money never existed.
    """
    entries = {
        row["kind"]: row
        for row in session.entries.order_by().values("kind").annotate(
            amount=Sum("amount"), n=Count("pk")
        )
    }
    opening = session.entries.filter(kind=PosDrawerEntry.KIND_OPEN).order_by("seq").first()

    sales = {}
    testmode = 0
    for row in (
        PosSale.objects.filter(drawer_session=session)
        .order_by()
        .values("payment_type", "kind", "testmode")
        .annotate(amount=Sum("total"), n=Count("pk"))
    ):
        if row["testmode"]:
            testmode += row["n"] if row["kind"] == PosSale.KIND_SALE else 0
            continue
        sales[(row["payment_type"], row["kind"])] = row

    def sale_amount(payment_type, kind):
        row = sales.get((payment_type, kind))
        return (row["amount"] or ZERO).quantize(CENT) if row else ZERO

    def sale_count(payment_type, kind):
        row = sales.get((payment_type, kind))
        return row["n"] if row else 0

    def entry_amount(kind):
        row = entries.get(kind)
        return (row["amount"] or ZERO).quantize(CENT) if row else ZERO

    def entry_count(kind):
        row = entries.get(kind)
        return row["n"] if row else 0

    cash = PosSale.PAYMENT_CASH
    card = PosSale.PAYMENT_CARD
    result = {
        "float": opening.amount if opening and opening.amount is not None else ZERO,
        "cash_sales": sale_amount(cash, PosSale.KIND_SALE),
        "cash_sales_count": sale_count(cash, PosSale.KIND_SALE),
        # Negative: money handed back.
        "cash_cancellations": sale_amount(cash, PosSale.KIND_CANCELLATION),
        "cash_cancellations_count": sale_count(cash, PosSale.KIND_CANCELLATION),
        "deposit_refunds": sale_amount(cash, PosSale.KIND_DEPOSIT_REFUND),
        "deposit_refunds_count": sale_count(cash, PosSale.KIND_DEPOSIT_REFUND),
        "cash_in": entry_amount(PosDrawerEntry.KIND_IN),
        "cash_in_count": entry_count(PosDrawerEntry.KIND_IN),
        "cash_out": entry_amount(PosDrawerEntry.KIND_OUT),
        "cash_out_count": entry_count(PosDrawerEntry.KIND_OUT),
        "counts": entry_count(PosDrawerEntry.KIND_COUNT),
        # Net of cancellations and deposits handed back on the card, which
        # is what SumUp's own statement for the evening will say.
        "card": sum(
            (sale_amount(card, kind) for kind, _label in PosSale.KIND_CHOICES), ZERO
        ),
        "card_count": sale_count(card, PosSale.KIND_SALE),
        "testmode_count": testmode,
    }
    result["expected"] = (
        result["float"]
        + result["cash_sales"]
        + result["cash_cancellations"]
        + result["deposit_refunds"]
        + result["cash_in"]
        - result["cash_out"]
    )
    return result


def _lock(drawer):
    """
    The drawer's row, locked until the end of the transaction.

    Every write to one drawer's ledger goes through here, so two tills sharing
    a drawer — or a till and the back office — take turns rather than both
    reading the same tail and chaining onto it.
    """
    return PosDrawer.objects.select_for_update().get(pk=drawer.pk)


def _lock_session(session):
    """
    The opening's row, locked: a checkout still writing a sale into it
    finishes first, so a count or a closing sees every sale that will ever
    belong to it.
    """
    return PosDrawerSession.objects.select_for_update().get(pk=session.pk)


def _replay(drawer, idempotency_key):
    return PosDrawerEntry.objects.filter(
        drawer=drawer, idempotency_key=idempotency_key
    ).select_related("session").first()


def open_drawer(drawer, *, idempotency_key, amount, denominations=None, cashier="",
                device=None, user=None, source=PosDrawerEntry.SOURCE_TILL):
    """Start an opening with the float counted in. Returns the ledger entry."""
    with transaction.atomic():
        drawer = _lock(drawer)
        replay = _replay(drawer, idempotency_key)
        if replay is not None:
            return replay
        if drawer.archived_at is not None:
            # Its tills were let go when it was archived; this is a till that
            # had not heard yet, pressing "open" in the same instant.
            raise no_drawer()
        if open_session_of(drawer) is not None:
            raise DrawerError("drawer_open", _("This cash drawer is already open."))
        session = PosDrawerSession.objects.create(drawer=drawer, opened_at=now())
        return PosDrawerEntry.append(
            drawer=drawer,
            session=session,
            kind=PosDrawerEntry.KIND_OPEN,
            at=session.opened_at,
            amount=amount,
            denominations=denominations,
            cashier=cashier,
            device=device,
            user=user,
            source=source,
            idempotency_key=idempotency_key,
        )


def move_cash(drawer, *, idempotency_key, kind, amount, reason, cashier="", device=None,
              user=None, source=PosDrawerEntry.SOURCE_TILL):
    """Put money into the open drawer, or take some out. Returns the ledger entry."""
    if kind not in (PosDrawerEntry.KIND_IN, PosDrawerEntry.KIND_OUT):
        raise DrawerError("kind", _("Money can only go in or out."))
    if amount is None or amount <= ZERO:
        raise DrawerError("amount", _("The amount has to be more than zero."))
    if not (reason or "").strip():
        # A withdrawal with no stated reason is the first line anybody
        # auditing a drawer asks about, and the last one anybody remembers.
        raise DrawerError("reason_required", _("Say what the money is for."))
    with transaction.atomic():
        drawer = _lock(drawer)
        replay = _replay(drawer, idempotency_key)
        if replay is not None:
            return replay
        session = open_session_of(drawer)
        if session is None:
            raise drawer_closed()
        return PosDrawerEntry.append(
            drawer=drawer,
            session=session,
            kind=kind,
            amount=amount,
            reason=reason.strip(),
            cashier=cashier,
            device=device,
            user=user,
            source=source,
            idempotency_key=idempotency_key,
        )


def count_drawer(drawer, *, idempotency_key, amount, denominations=None, cashier="",
                 device=None, user=None, source=PosDrawerEntry.SOURCE_TILL):
    """
    Write down a count, with what the drawer should have held then.

    Every count is kept, recounts included: the first figure somebody arrived
    at is as much a part of the evening as the one it closed on.
    """
    with transaction.atomic():
        drawer = _lock(drawer)
        replay = _replay(drawer, idempotency_key)
        if replay is not None:
            return replay
        session = open_session_of(drawer)
        if session is None:
            raise drawer_closed()
        session = _lock_session(session)
        return PosDrawerEntry.append(
            drawer=drawer,
            session=session,
            kind=PosDrawerEntry.KIND_COUNT,
            amount=amount,
            expected=figures(session)["expected"],
            denominations=denominations,
            cashier=cashier,
            device=device,
            user=user,
            source=source,
            idempotency_key=idempotency_key,
        )


def count_is_current(session, count, expected=None):
    """
    Whether closing on this count would close on the truth.

    It has to be the last thing that happened to the drawer, and what the
    drawer should hold must not have moved since: a sale rung up on the other
    tablet while this one was being counted is cash the count never saw.
    """
    latest = session.entries.order_by("-seq").first()
    if latest is None or latest.pk != count.pk:
        return False
    if expected is None:
        expected = figures(session)["expected"]
    return count.expected == expected


def close_drawer(drawer, *, idempotency_key, reason="", count_seq=None, amount=None,
                 denominations=None, uncounted_ok=False, cashier="", device=None, user=None,
                 source=PosDrawerEntry.SOURCE_TILL):
    """
    End the opening. Returns the ledger entry.

    Closed on one of three things, in this order: a count the till has just
    written (``count_seq``), which has to still be current; an amount given
    straight away, which is what the back office does; or nothing at all,
    which only ``uncounted_ok`` allows — a drawer left open since an earlier
    evening, closed by somebody who never saw the money it held.
    """
    with transaction.atomic():
        drawer = _lock(drawer)
        replay = _replay(drawer, idempotency_key)
        if replay is not None:
            return replay
        session = open_session_of(drawer)
        if session is None:
            raise drawer_closed()
        session = _lock_session(session)
        expected = figures(session)["expected"]

        if count_seq is not None:
            count = session.entries.filter(kind=PosDrawerEntry.KIND_COUNT, seq=count_seq).first()
            if count is None:
                raise DrawerError("count_required", _("Count the drawer before closing it."))
            if not count_is_current(session, count, expected):
                raise DrawerError(
                    "count_stale",
                    _("The drawer has moved since it was counted. Count it again."),
                )
            amount = count.amount
            denominations = count.denominations
        elif amount is None and not uncounted_ok:
            raise DrawerError("count_required", _("Count the drawer before closing it."))

        entry = PosDrawerEntry.append(
            drawer=drawer,
            session=session,
            kind=PosDrawerEntry.KIND_CLOSE,
            amount=amount,
            expected=expected,
            denominations=denominations,
            reason=(reason or "").strip(),
            cashier=cashier,
            device=device,
            user=user,
            source=source,
            idempotency_key=idempotency_key,
        )
        session.closed_at = entry.datetime
        session.save(update_fields=["closed_at"])
        return entry


def archive_drawer(drawer):
    """
    Put a closed drawer away. Returns the tills that were feeding it.

    Refused while it is open: tonight's money is in it. Its tills are let go —
    they take cash with no drawer until they are given another — because a
    till left on a drawer nobody can open any more would refuse every cash
    sale, and the screen that could fix it would no longer offer the drawer.
    """
    from .models import PosDevice

    with transaction.atomic():
        drawer = _lock(drawer)
        if open_session_of(drawer) is not None:
            raise DrawerError(
                "drawer_open", _("Close the drawer before archiving it: it still holds tonight's cash.")
            )
        if drawer.archived_at is not None:
            return []
        tills = list(
            PosDevice.objects.filter(drawer=drawer)
            .select_related("device")
            .order_by("device__name", "device__pk")
        )
        PosDevice.objects.filter(pk__in=[till.pk for till in tills]).update(drawer=None)
        drawer.archived_at = now()
        drawer.save(update_fields=["archived_at"])
        return [till.device for till in tills]


def restore_drawer(drawer):
    """Offer an archived drawer again. Its tills are given back by hand."""
    with transaction.atomic():
        drawer = _lock(drawer)
        drawer.archived_at = None
        drawer.save(update_fields=["archived_at"])
        return drawer


def check_denominations(denominations, amount, currency):
    """
    What is wrong with a count given note by note, or ``None``.

    The breakdown has to name notes and coins of this currency, and add up to
    the amount it claims to be: the ledger keeps both, and two figures that
    disagree in an audit record are worse than one.
    """
    if not denominations:
        return None
    allowed = {row["value"] for row in denominations_for(currency)}
    total = ZERO
    for value, number in denominations.items():
        if value not in allowed:
            return _("“{value}” is not a note or a coin of this currency.").format(value=value)
        total += Decimal(value) * number
    if total != amount:
        return _("The notes and coins come to {total}, not {amount}.").format(
            total=total, amount=amount
        )
    return None
