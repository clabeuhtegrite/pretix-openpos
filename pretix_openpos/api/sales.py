"""
The checkout: a basket become a pretix order and a line in the journal.

Recorded once however many times a till sends it — the idempotency key, and the
lock that queues a second attempt behind the first — booked at what was charged
when the money has already moved, and finished with its invoice and its
check-ins. :class:`CheckoutActions` holds the action and its steps.
"""
import copy
import hashlib
import logging
from datetime import timedelta
from decimal import Decimal

from django.db import OperationalError, connection, transaction
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from pretix.api.serializers.order import OrderCreateSerializer, OrderPositionCreateSerializer
from pretix.base.models import Checkin, Device, Order
from pretix.base.models.orders import OrderPayment
from pretix.base.services.checkin import CheckInError, RequiredMediaExchangeError, perform_checkin
from pretix.base.services.invoices import generate_invoice, invoice_qualified
from pretix.base.signals import order_paid, order_placed
from pretix.helpers import OF_SELF
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.response import Response

from ..invoicing import pos_invoices_enabled
from ..models import PosCategory, PosDevice, PosSale, PosTerminalPayment, refund_key
from ..payment import CARD, CASH
from .catalog import (
    checkin_list_for, custom_sale_item, deposit_item, get_pos_channel, refuse_oversized, resolve_line, sellable_items,
)
from .drawer_api import drawer_session_for, hold_drawer_session
from .evenings import selling_subevent

logger = logging.getLogger(__name__)


def walk_in(position, clist, *, auth, user, offline_at=None):
    """
    Check in a ticket the till has just sold, the way pretix would record it.

    The customer is standing right here having paid, so they are let in
    whatever the list says — but only a check-in that actually needed
    overriding is recorded as one. pretix reads ``force`` as "this comes from a
    device that was offline": every forced row is shown as an offline scan in
    its check-in history and exported as one. A till that forced every sale
    made each ticket it sold look like a scan that had waited in a phone, and
    the one mark that could single out a door's real offline scans meant
    nothing. So a plain check-in first, and force only when pretix refuses —
    a rule on the list, a product it does not take — which then shows as the
    override it is.

    A sale rung up with no network is the exception, forced from the start: it
    did happen offline, and ``offline_at`` puts the entry at the moment the
    customer walked in rather than when the till found the network again.
    """
    common = dict(
        op=position,
        clist=clist,
        given_answers={},
        # A mandatory question must not hold up a customer who has just paid.
        questions_supported=False,
        auth=auth,
        user=user,
        type=Checkin.TYPE_ENTRY,
    )
    if offline_at is not None:
        perform_checkin(force=True, datetime=offline_at, **common)
        return
    try:
        perform_checkin(**common)
    except (CheckInError, RequiredMediaExchangeError):
        perform_checkin(force=True, **common)


def deposit_fee(refund_total, sale_total, item):
    """
    The deposits handed back with a sale, as a line on the order.

    ``refund_total`` is negative — money leaving — and ``sale_total`` is what
    the products came to. The order then totals what the customer actually
    paid, which is the figure the card was charged, the figure the drawer took
    and the figure a cancellation has to give back. It used to total the
    products alone, so every deposit returned inflated pretix' takings against
    both SumUp and the drawer at once.

    Capped at the sale, never below zero: pretix cannot hold a negative order
    and a basket that nets out that way is money leaving the drawer with
    nothing sold. The remainder stays where a return with no sale at all
    already lives — a journal row of its own, outside any order, which is the
    only place it can go. That case is cash by definition; the till refuses a
    card basket at or below zero because SumUp can only refund against one of
    its own transactions.
    """
    given_back = -refund_total
    if given_back <= 0 or item is None:
        return []
    return [
        {
            "fee_type": "other",
            "value": str(-min(given_back, sale_total)),
            "description": str(item.name),
        }
    ]


class _PaidPositionSerializer(OrderPositionCreateSerializer):
    def validate_item(self, item):
        # pretix refuses a product that is switched off, force or no force,
        # and that is the one refusal a sale already paid for cannot satisfy:
        # the organiser switched the product off after the evening — as one
        # does — and the till that sold it that evening replays the next
        # morning. Judged as it would be if it were still on, so that every
        # other check pretix makes of an item still applies.
        if not item.active:
            switched_on = copy.copy(item)
            switched_on.active = True
            super().validate_item(switched_on)
            return item
        return super().validate_item(item)


class PaidOrderSerializer(OrderCreateSerializer):
    """
    pretix' own order serializer, for a sale whose money has already moved.

    Replayed from a till that was cut off, or paid on the card reader before
    the order could be written. It differs in one respect only — see
    :class:`_PaidPositionSerializer` — and is otherwise exactly what a sale
    being rung up now goes through, ``force`` included.
    """

    positions = _PaidPositionSerializer(many=True, required=True)


#: How long an attempt at a sale waits for another attempt at the same sale.
#:
#: The other one is creating an order, which takes a fraction of a second; one
#: still holding the key after this is stuck rather than busy, and the till is
#: better off told to come back than kept waiting on it — which a 503 does,
#: because the app retries anything the server could not take, under the same
#: key, and that retry is a replay once the first attempt has committed.
KEY_WAIT_SECONDS = 5

#: The first half of every advisory lock taken on an idempotency key.
#:
#: PostgreSQL has two kinds of advisory lock key: one 64-bit number, which is
#: what pretix' own quota and event locks use, and a pair of 32-bit numbers,
#: which is a separate space entirely. The pair is used here so that no key of
#: ours can ever collide with one of pretix' — a collision would not be wrong,
#: only slow, but it would be slow in the middle of somebody's order. The
#: number itself is "OPOS" in ASCII, so it names itself in ``pg_locks``.
KEY_LOCK_CLASS = 0x4F504F53


class SaleInProgress(APIException):
    """Another attempt at this very sale is still being written."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    def __init__(self):
        super().__init__(
            {
                "detail": _("This sale is still being recorded. Try again in a moment."),
                "code": "sale_in_progress",
            }
        )
        # Sent as Retry-After. The 503 itself is what makes the app treat this
        # as "not now" rather than "no": it retries a 5xx under the same key,
        # and lists a 4xx among the refusals.
        self.wait = 2


def recorded_sale(event, idempotency_key):
    """The journal row a till's transaction was recorded under, or ``None``."""
    return PosSale.objects.filter(event=event, idempotency_key=idempotency_key).first()


def hold_idempotency_key(event, idempotency_key):
    """
    Queue behind any other attempt at the same sale, then look for it again.

    Called first thing inside the transaction that writes a sale. A key looked
    up before that transaction only says nobody had *finished* this sale: two
    attempts overlapping on two workers — a till whose request timed out while
    the server was still working, polls stacking up behind a slow SumUp and
    confirming twice — both passed that look-up, both created an order, and
    the second found out only when the journal refused its row. By then its
    order existed, paid, with a ticket in it and no line in the journal.

    So the second attempt waits here until the first has committed or given
    up, and then reads again. Under PostgreSQL's default isolation that read
    sees the first attempt's row, and the caller answers as a replay without
    having written anything — not even the quota check, which would otherwise
    refuse a paid customer because the first attempt had just taken the last
    place. Returns that row, or ``None`` when this attempt is the one to write.

    A transaction-scoped lock rather than a session one, so it can never
    outlive the request that took it: connections are pooled and reused, and
    a session lock left on one would hold that key against every later
    attempt. Only PostgreSQL has advisory locks; the database pretix runs on in
    production does, and SQLite, which the tests run on, lets one writer in
    at a time anyway. On any backend the journal's unique key stays the last
    word — see ``existing_ok`` in :meth:`PosSale.record`.
    """
    if connection.vendor == "postgresql":
        _lock_idempotency_key(event, idempotency_key)
    return recorded_sale(event, idempotency_key)


def _lock_idempotency_key(event, idempotency_key):
    # Stable across processes and restarts, unlike hash(): every worker has to
    # arrive at the same number for the same key. Four bytes because that is
    # the size of the second half of the lock key; two different keys landing
    # on the same number only ever makes one wait for the other.
    digest = hashlib.blake2b(
        f"{event.pk}:{idempotency_key}".encode(), digest_size=4
    ).digest()
    try:
        # A savepoint of its own, so that giving up on the wait leaves the
        # surrounding transaction usable for the rollback — and the lock
        # outlives it: a transaction-level lock taken in a savepoint that is
        # released belongs to the transaction until it ends.
        with transaction.atomic(), connection.cursor() as cursor:
            cursor.execute(f"SET LOCAL lock_timeout = '{KEY_WAIT_SECONDS}s'")
            cursor.execute(
                "SELECT pg_advisory_xact_lock(%s, %s)",
                [KEY_LOCK_CLASS, int.from_bytes(digest, "big", signed=True)],
            )
            cursor.execute("SET LOCAL lock_timeout TO DEFAULT")
    except OperationalError as exc:
        raise SaleInProgress() from exc


class CheckoutActions:
    """The checkout, and what finishes a sale once it is recorded."""

    # -- checkout ----------------------------------------------------------

    @action(detail=False, methods=["post"], url_path="checkout", url_name="checkout")
    def checkout(self, request, **kwargs):
        from .serializers import KeySerializer

        event = request.event

        # The key, and only the key, before anything else is judged. A retry
        # of a sale already recorded has to get that sale back whatever the
        # rest of it says now: the tariff may have moved since, the last place
        # may have gone to this very sale, the date may be over — and a retry
        # answered with any of those refusals told the till that a sale which
        # went through had not, so the cashier took the money a second time.
        keyed = KeySerializer(data=request.data)
        keyed.is_valid(raise_exception=True)
        idempotency_key = keyed.validated_data["idempotency_key"]

        replay = recorded_sale(event, idempotency_key)
        if replay is not None:
            return self._replay(request, replay)

        try:
            return self._checkout(request, idempotency_key)
        except PosSale.AlreadyRecorded:
            # Another attempt at this sale committed while this one was being
            # written, and everything this one wrote has been rolled back with
            # the exception — its order included. What is left to do is what a
            # retry arriving a second later would have got.
            replay = recorded_sale(event, idempotency_key)
            if replay is None:
                # The row in the way held a key derived from this one rather
                # than this one. Nothing written here survived, which is the
                # part that matters; the rest is a fault to look at.
                raise
            return self._replay(request, replay)
        except ValidationError:
            # A refusal is an answer only for a sale nobody recorded. One
            # decided while another attempt was committing this same sale —
            # judged before the transaction, against a catalogue the first
            # attempt had just moved — would tell the till "not sold" about a
            # sale that was.
            replay = recorded_sale(event, idempotency_key)
            if replay is None:
                raise
            return self._replay(request, replay)

    def _replay(self, request, replay):
        """
        The answer to a sale already recorded: the original one, finished.

        The original attempt may have died between committing the order and
        the best-effort tail: the connection that carried this very retry is
        proof that connections die at the worst moment. Whatever is missing —
        the invoice, the check-ins, and nothing else — is done now. Idempotent:
        a second retry finds nothing left to do.
        """
        body = self._checkout_payload(request.event, replay, replayed=True)
        if replay.kind == PosSale.KIND_SALE and replay.order is not None:
            checked_in, checkin_errors = self._finish(
                request,
                replay.order,
                offline_at=replay.datetime if replay.offline else None,
                replayed=True,
            )
            body["checked_in"] = checked_in
            body["checkin_errors"] = checkin_errors
        return Response(body, status=status.HTTP_200_OK)

    def _checkout(self, request, idempotency_key):
        from .serializers import CheckoutSerializer

        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None

        # The reader payment this key names, when this till's reader has been
        # paid for it. Looked up before the request is judged, because it
        # changes what there is to judge: its basket is the one booked, so the
        # lines of a sale queued after the reader said "paid" are not read.
        pos_device = PosDevice.for_device(device)
        paid_on_reader = None
        if pos_device.drives_terminal:
            paid_on_reader = PosTerminalPayment.objects.filter(
                event=event,
                idempotency_key=idempotency_key,
                status=PosTerminalPayment.STATUS_SUCCESSFUL,
            ).first()
            if paid_on_reader is not None and not paid_on_reader.belongs_to(device):
                paid_on_reader = None

        serializer = CheckoutSerializer(
            data=request.data, context={"pinned": paid_on_reader is not None}
        )
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # A till that drives a card reader may not record a card payment the
        # reader did not validate.
        #
        # Checked here rather than left to the app, and that is the whole point
        # of the rule: the app is a page in a browser on a tablet that lives on
        # a counter, and it can be stale — a till left open across the deploy
        # that assigned the reader is stale by definition — or simply edited.
        # Whatever it believes it is allowed to do, this is what decides.
        #
        # It applies to a replayed sale as well as to one being rung up now,
        # which is the one place this departs from the rule of thumb elsewhere
        # in this endpoint that a sale already paid for is recorded whatever the
        # catalogue has since done. The difference is what the two refusals
        # cost: there, refusing strands money that genuinely changed hands;
        # here, accepting writes down a card payment nobody can point at. And a
        # reader payment cannot happen while the till is cut off anyway — the
        # reader is driven through SumUp's cloud, so a till with no network
        # cannot start one.
        terminal = None
        if (
            data["payment_type"] == PosSale.PAYMENT_CARD
            and pos_device.drives_terminal
        ):
            terminal = paid_on_reader
            if terminal is None:
                raise ValidationError(
                    {
                        "payment_type": [
                            _(
                                "This till has a card reader assigned, so a card "
                                "payment has to be validated by the reader. Take "
                                "this payment on the reader, or in cash."
                            )
                        ],
                        "code": "terminal_required",
                    }
                )
        if terminal is None:
            refuse_oversized(data["positions"])

        offline = data.get("offline")
        drawer_session = drawer_session_for(
            event,
            pos_device.drawer,
            data["payment_type"],
            offline["recorded_at"] if offline else None,
        )

        channel = get_pos_channel(event.organizer)
        # The money is already out of the customer's hands: replayed from a
        # till that was cut off, or taken by the card reader a moment ago.
        settled = bool(offline) or terminal is not None
        if terminal is not None:
            # The basket comes from the row written when the cardholder was
            # asked for the money, not from what the app sends now. Anything
            # else would let the order drift from the card charge — through a
            # tariff edited in between, or through an app sending one basket to
            # the reader and another to the journal.
            data["positions"] = terminal.positions
        custom_item = custom_sale_item(event)
        deposit = deposit_item(event)
        # A series sells for the date that is on. For a sale already paid for,
        # that is the date it was on when the money moved — a replay arriving
        # the next morning belongs to the night it was rung up in, which is
        # precisely when replays arrive — and nothing is refused, because
        # refusing does not give the money back.
        subevent = selling_subevent(
            event,
            offline["recorded_at"] if offline else None,
            settled=settled,
        )

        sellable = sellable_items(event, channel, settled=settled, pinned=terminal is not None)
        # The same answer the catalogue was drawn from, asked again here
        # because that is the only place it binds. A live line from one of
        # these categories is refused; a line whose money has already changed
        # hands is written down and reported — see off_role below.
        off_limits = PosCategory.off_limits(event, pos_device)

        api_positions = []
        journal_positions = []
        refund_positions = []
        #: What the pretix order is worth: everything but the deposits handed back.
        sale_total = Decimal("0.00")
        #: Negative, and outside any order — see PosSale.KIND_DEPOSIT_REFUND.
        refund_total = Decimal("0.00")
        off_tariff = []
        #: Lines a till sold outside the categories its role covers.
        #:
        #: Only ever filled by a sale that was already paid for, because a live
        #: one never gets this far. Refusing a replay would be the tidier rule
        #: and the wrong one: the money is in the drawer either way, and a
        #: refusal would leave it there with no record at all — which is the
        #: state this whole journal exists to prevent. It is also the ordinary
        #: case rather than a suspicious one the first evening this is set up,
        #: since a tablet that sold beer before it was given the door's role
        #: replays afterwards. So it is written down, marked, and said out loud.
        off_role = []
        #: Free-amount reasons, for the order's comment in the back office.
        notes = []

        for line in data["positions"]:
            resolved = resolve_line(
                line,
                sellable=sellable,
                custom_item=custom_item,
                deposit=deposit,
                settled=settled,
                subevent=subevent,
                off_limits=off_limits,
                pinned=terminal is not None,
            )
            item = resolved.item
            variation = resolved.variation
            price = resolved.price
            tariff = resolved.tariff
            count = resolved.count
            description = resolved.description
            is_refund = resolved.refund

            # A sale rung up offline was priced by the app from the tariff it had
            # cached, and the customer has already paid that. The order is
            # therefore created at what was charged — anything else would print
            # an invoice for a sum nobody handed over — and the divergence is
            # reported rather than smoothed away. A free amount on its own
            # product has no tariff to diverge from (resolve_line makes its
            # tariff the amount itself); a reason on any other line hides
            # nothing any more, and used to hide everything. A card payment
            # the reader has already taken is priced from the row written when
            # the cardholder was asked, so it can diverge the same way and is
            # reported the same way.
            if settled and price != tariff:
                off_tariff.append(
                    {
                        "item": item.pk,
                        "item_name": str(item.name),
                        # Two variations of one item move independently, so the
                        # name alone would name the wrong thing half the time.
                        "variation": variation.pk if variation else None,
                        "variation_name": str(variation.value) if variation else None,
                        "charged": str(price),
                        "tariff": str(tariff),
                    }
                )

            if resolved.outside_role:
                off_role.append(
                    {
                        "item": item.pk,
                        "item_name": str(item.name),
                        "category": item.category_id,
                        "category_name": str(item.category.name) if item.category else "",
                        "count": count,
                    }
                )

            journal_line = {
                "item": item.pk,
                "item_name": str(item.name),
                "variation": variation.pk if variation else None,
                "variation_name": str(variation.value) if variation else None,
                "count": count,
                "unit_price": str(price),
                "line_total": str(price * count),
            }
            if subevent is not None:
                # Which date of a series this was sold for, named as it was
                # called at the time. The journal outlives the order and the
                # date alike, and a row that says only "Entrée × 2" answers
                # nothing about a season that ran twelve evenings.
                journal_line["subevent"] = subevent.pk
                journal_line["subevent_name"] = str(subevent.name or subevent)
            if description:
                # What the money was actually for. In the journal because that
                # is the record that outlives the order, and on the order too,
                # a few lines further down.
                journal_line["description"] = description
                notes.append(f"{count}× {item.name} — {description}")
            if settled and price != tariff:
                # Kept on the line itself, so the divergence survives in the
                # journal even after the tariff has been edited again.
                journal_line["tariff_price"] = str(tariff)
            if resolved.outside_role:
                # On the line for the same reason: the journal outlives the
                # order, and the category may well be un-reserved next week,
                # at which point nothing else would say this row was odd.
                journal_line["outside_role"] = True

            if is_refund:
                refund_total += price * count
                refund_positions.append(journal_line)
                # Deliberately no order position: this is money leaving the
                # drawer, and pretix has nowhere to put it.
                continue

            sale_total += price * count
            journal_positions.append(journal_line)
            for _n in range(count):
                position = {
                    "item": item.pk,
                    "variation": variation.pk if variation else None,
                    "price": str(price),
                    "attendee_name_parts": {},
                    "answers": [],
                }
                if subevent is not None:
                    # Required on every position of a series, and the reason a
                    # till used to sell from a catalogue that loaded cleanly and
                    # then fail at the payment: pretix refused the order with
                    # "the product is not assigned to a quota", which is true
                    # of no date in particular and names the wrong cause.
                    position["subevent"] = subevent.pk
                api_positions.append(position)

        # What actually changes hands: the order, less the deposits given back
        # with it. Every figure the customer is quoted is this one.
        net_total = sale_total + refund_total

        expected = data["expected_total"]
        # Not checked once the reader has the money: the basket being priced
        # here *is* the one the card paid for, pinned when the cardholder was
        # asked, so the two cannot disagree. If they somehow did, refusing
        # would leave a charged card with no order behind it — which is the one
        # outcome worth more than a mismatched figure.
        if terminal is None and expected is not None and expected != net_total:
            # Refuse rather than charge a different amount than the one the
            # customer was told. The app reloads its catalogue and shows the new
            # basket; nothing has been taken at this point.
            raise ValidationError(
                {
                    "expected_total": [
                        _("Prices changed: this basket now comes to {total}, not {expected}.").format(
                            total=net_total, expected=expected
                        )
                    ],
                    "code": "price_changed",
                    "total": str(net_total),
                }
            )

        cash_given = data["cash_given"]
        cash_change = None
        if data["payment_type"] == PosSale.PAYMENT_CASH and cash_given is not None:
            if net_total < Decimal("0.00"):
                # Nothing was tendered: the drawer is the one paying out. The
                # till has nothing to record here and the operator counts out
                # the net, which the answer below names.
                raise ValidationError(
                    {"cash_given": [_("Nothing is due: this transaction pays money out.")]}
                )
            if cash_given < net_total:
                raise ValidationError(
                    {"cash_given": [_("The amount received is less than the total due.")]}
                )
            # Against the net, not against the order: with a deposit handed
            # back, the order is worth more than the customer put on the
            # counter, and the change is counted out of what they did.
            cash_change = cash_given - net_total

        payment_info = {
            "cashier": data["cashier"],
            "device": device.unique_serial if device else "",
            "cash_given": None if cash_given is None else str(cash_given),
            "cash_change": None if cash_change is None else str(cash_change),
        }

        payload = {
            "status": "p",
            "testmode": event.testmode,
            # Quota is checked for a sale being rung up now — that is what stops
            # a till overselling the room — and deliberately not for one being
            # replayed. The money is in the drawer and the holder is already
            # inside; a quota that ran out while the till was cut off is a fact
            # to reconcile afterwards, not a reason to leave a paid sale with no
            # order behind it. The journal marks the row `offline`, so exactly
            # these sales can be found again.
            "force": settled,
            "payment_provider": CASH if data["payment_type"] == PosSale.PAYMENT_CASH else CARD,
            # When the money was taken. For a sale replayed from a till that was
            # offline that is not now — the order is created late, but it was
            # paid at the door, and the payment date is what reports read.
            # (The order's own creation date stays honest: it really was created
            # at replay time; the journal carries the moment of the sale.)
            "payment_date": (offline["recorded_at"] if offline else now()).isoformat(),
            "payment_info": payment_info,
            "send_email": False,
            "sales_channel": channel.identifier,
            "locale": event.settings.locale,
            "positions": api_positions,
            # Deposits handed back, as a negative fee, so the order is worth
            # what the customer actually paid for it. Without this the order
            # said 12.00 while 9.00 reached the card, every deposit returned
            # inflated pretix' own takings against SumUp and against the
            # drawer, and cancelling gave back the inflated figure — which the
            # card cannot honour, so the customer left short of their cups.
            #
            # A fee rather than a position, because a returned cup is not a
            # thing being sold: it settles a deposit taken on some earlier
            # order, and pretix has no position that can carry a negative
            # price. It is the shape pretix uses for a redeemed gift card, for
            # the same reason.
            "fees": deposit_fee(refund_total, sale_total, deposit),
        }
        if notes:
            # So a free amount is readable in the back office as well as in the
            # journal: the order is otherwise n× a product called "Misc".
            payload["comment"] = "\n".join(notes)

        order = None
        sale = None
        refund = None
        recorded_at = offline["recorded_at"] if offline else None
        #: What the till's clock was off by, already taken out of recorded_at.
        correction = offline["clock_correction"] if offline else timedelta(0)
        correction_seconds = round(correction.total_seconds())
        if correction_seconds:
            logger.info(
                "Offline sale %s from %s dated by the server's clock: the till's was %+d s out",
                idempotency_key, device.name if device else "?", -correction_seconds,
            )

        with transaction.atomic():
            # Before anything is locked or written: an attempt that finds this
            # sale recorded meanwhile leaves with nothing to undo.
            earlier = hold_idempotency_key(event, idempotency_key)
            if earlier is not None:
                raise PosSale.AlreadyRecorded(earlier)

            if not offline:
                drawer_session = hold_drawer_session(drawer_session, data["payment_type"])

            # No order when the basket is nothing but returned cups, which is
            # the whole of the queue at the end of an evening. There is nothing
            # for pretix to hold: an order cannot be worth less than nothing.
            if api_positions:
                order_serializer = (PaidOrderSerializer if settled else OrderCreateSerializer)(
                    data=payload,
                    context={
                        "event": event,
                        "auth": request.auth,
                        "request": request,
                        "pdf_data": False,
                    },
                )
                order_serializer.is_valid(raise_exception=True)
                order = order_serializer.save()

                order.log_action(
                    "pretix.event.order.placed",
                    user=request.user if request.user.is_authenticated else None,
                    auth=request.auth,
                )

                if off_tariff:
                    # Told to the till at resync, and until now told to nobody
                    # else. The volunteer who happens to be holding the tablet
                    # sees it once, in a panel they then dismiss; the person
                    # reconciling the evening two days later sees an order at a
                    # price the tariff does not explain and has nothing to go
                    # on. The order's own history is where pretix keeps "what
                    # happened to this order", so it goes there — the journal
                    # line already carries the same figures, but the journal is
                    # not what anybody opens when a single order looks odd.
                    order.log_action(
                        "pretix_openpos.order.off_tariff",
                        data={"lines": off_tariff},
                        user=request.user if request.user.is_authenticated else None,
                        auth=request.auth,
                    )

                if off_role:
                    # The one trace an organiser will ever look at. It is not a
                    # refusal and it is not an accusation: the ordinary reading
                    # is a till that sold before its role was given to it, and
                    # the useful thing is that the order says which till and
                    # which category rather than nothing at all.
                    order.log_action(
                        "pretix_openpos.order.off_role",
                        data={"lines": off_role, "device": device.name if device else ""},
                        user=request.user if request.user.is_authenticated else None,
                        auth=request.auth,
                    )

                if correction_seconds:
                    # The order and the journal carry the corrected moment and
                    # nothing else would ever say it was corrected: the till's
                    # own figure is gone by the time anybody wonders why a sale
                    # is dated two minutes before the one rung up after it.
                    # Both clocks' readings are kept, so the entry explains
                    # itself without the till.
                    order.log_action(
                        "pretix_openpos.order.clock_corrected",
                        data={
                            "seconds": correction_seconds,
                            "recorded_at": offline["recorded_at"].isoformat(),
                            "claimed_at": offline["claimed_at"].isoformat(),
                            "sent_at": offline["sent_at"].isoformat(),
                            "device": device.name if device else "",
                        },
                        user=request.user if request.user.is_authenticated else None,
                        auth=request.auth,
                    )

                sale = PosSale.record(
                    event=event,
                    order=order,
                    device=device,
                    cashier=data["cashier"],
                    payment_type=data["payment_type"],
                    total=sale_total,
                    positions=journal_positions,
                    idempotency_key=idempotency_key,
                    cash_given=cash_given,
                    cash_change=cash_change,
                    testmode=event.testmode,
                    offline=bool(offline),
                    recorded_at=recorded_at,
                    drawer_session=drawer_session,
                    # A row under this key that this transaction did not write
                    # belongs to another attempt at the same sale, and keeping
                    # the order just created beside it would sell the tickets
                    # twice. Raised instead, which undoes that order.
                    existing_ok=False,
                )

                # Cross-reference the journal entry from the payment so the
                # backend order view can point at it.
                payment = order.payments.last()
                if payment:
                    info = payment.info_data or {}
                    info["journal_seq"] = sale.seq
                    payment.info_data = info
                    payment.save(update_fields=["info"])

            if refund_positions:
                refund = PosSale.record(
                    event=event,
                    order=None,
                    device=device,
                    cashier=data["cashier"],
                    payment_type=data["payment_type"],
                    total=refund_total,
                    positions=refund_positions,
                    # Its own key, derived from the transaction's, so a retry
                    # recognises this half too. The sale, when there is one,
                    # keeps the key the till sent.
                    idempotency_key=(
                        refund_key(idempotency_key) if api_positions else idempotency_key
                    ),
                    # The cash figures belong to the transaction as a whole and
                    # are recorded once, on the sale. Here they would claim a
                    # note was handed over for money going the other way.
                    testmode=event.testmode,
                    kind=PosSale.KIND_DEPOSIT_REFUND,
                    offline=bool(offline),
                    recorded_at=recorded_at,
                    drawer_session=drawer_session,
                    # Either half, for the same reason as the sale's.
                    existing_ok=False,
                )

        # Everything below runs after the sale is durably committed: a failure
        # here must never undo an order the customer has already paid for.
        checked_in, checkin_errors = None, []
        if order is not None:
            self._post_commit(request, order)
            checked_in, checkin_errors = self._finish(
                request, order, offline_at=recorded_at
            )

        body = self._checkout_payload(event, sale or refund, replayed=False)
        body["checked_in"] = checked_in
        body["checkin_errors"] = checkin_errors
        # Empty on every online sale. When it is not, an operator has to be told:
        # a price moved while the till could not hear about it.
        body["off_tariff"] = off_tariff
        # Empty on everything the app could have rung up from the grid it was
        # served. When it is not, a till has replayed a sale from outside what
        # its role covers, and the resync panel is where the operator holding
        # the tablet finds out.
        body["off_role"] = off_role
        # Seconds added to the moment the till said the sale was rung up, to
        # put it on the server's clock: negative when the till's clock runs
        # fast. Zero on everything but an offline sale from a till whose clock
        # was more than a minute out — which the till can then say out loud.
        body["clock_correction_seconds"] = correction_seconds
        return Response(body, status=status.HTTP_201_CREATED)

    # -- helpers -----------------------------------------------------------

    def _sale_payload(self, sale, replayed):
        # A deposit refund is a journal row with no order behind it. Its own
        # total is money going out, so reporting it as an order total would
        # have the till announce a sale worth minus three euros; the figures
        # that describe the transaction are added by _checkout_payload.
        orderless = sale.kind == PosSale.KIND_DEPOSIT_REFUND
        # The order's own total, not the journal row's, whenever there is an
        # order to read it from. The two part company on a basket with a
        # deposit handed back: the row is what the beer came to, the order is
        # what was paid for it. This line sits next to the order code on the
        # till's last screen, so somebody who opens that order has to find the
        # same figure there.
        total = (
            str(sale.order.total) if sale.order is not None
            else "0.00" if orderless
            else str(sale.total)
        )
        return {
            # No link to the order. It used to be here, built from the order's
            # secret: the customer's own page, tickets and invoice included,
            # handed to every device that could replay a key. The till never
            # read it, and a till has no business holding what the customer
            # alone should.
            "order": {"code": sale.order_code, "total": total},
            "journal_seq": sale.seq,
            "payment_type": sale.payment_type,
            "cash_given": None if sale.cash_given is None else str(sale.cash_given),
            "cash_change": None if sale.cash_change is None else str(sale.cash_change),
            "datetime": sale.datetime.isoformat(),
            "replayed": replayed,
            "checked_in": None,
            "checkin_errors": [],
        }

    def _checkout_payload(self, event, primary, replayed):
        """
        One customer, one answer — even when it took two journal rows.

        A basket that both sells and hands a deposit back is a sale in pretix
        and a payout in the journal, and the till has to be told about both:
        what the order is worth, what went back out, and the difference, which
        is the only figure the customer ever hears.

        ``primary`` is whichever row the transaction is keyed on — the sale if
        there is one, else the payout. The other half is looked up from it, so
        a retry answers exactly as the first attempt did.
        """
        if primary.kind == PosSale.KIND_DEPOSIT_REFUND:
            sale, refund = None, primary
        else:
            sale = primary
            refund = PosSale.objects.filter(
                event=event, idempotency_key=refund_key(primary.idempotency_key)
            ).first()

        body = self._sale_payload(primary, replayed)
        # Positive, because it is an amount handed back and reads as one.
        body["deposit_refund"] = str(-refund.total) if refund else None
        body["deposit_refund_seq"] = refund.seq if refund else None
        # What changed hands. Negative when the drawer is the one paying out.
        body["net_total"] = str(
            (sale.total if sale else Decimal("0.00"))
            + (refund.total if refund else Decimal("0.00"))
        )
        return body

    def _post_commit(self, request, order):
        """
        Fire the signals pretix' own order API fires, once, for a new order.

        Only ever for the attempt that created the order. The invoice pretix'
        API would also issue here is left to :meth:`_finish`, which every
        request for this sale goes through, retries included.
        """
        payment = order.payments.last()
        if payment and payment.state == OrderPayment.PAYMENT_STATE_CONFIRMED:
            order.log_action(
                "pretix.event.order.payment.confirmed",
                {"local_id": payment.local_id, "provider": payment.provider},
                user=request.user if request.user.is_authenticated else None,
                auth=request.auth,
            )

        order_placed.send(request.event, order=order, bulk=False)
        if order.status == Order.STATUS_PAID:
            order_paid.send(request.event, order=order)
            order.log_action(
                "pretix.event.order.paid",
                {
                    "provider": payment.provider if payment else None,
                    "info": {},
                    "date": now().isoformat(),
                    "force": False,
                },
                user=request.user if request.user.is_authenticated else None,
                auth=request.auth,
            )

    def _finish(self, request, order, *, offline_at=None, replayed=False):
        """
        What is left once a sale is committed: its invoice and its check-ins.

        Run by the attempt that recorded the sale, and again by every request
        that finds it recorded — a retry, or a second attempt that overlapped
        the first and lost — because the first may have died between its
        commit and this. Each part looks at what exists before doing anything,
        and the order's row is held while it does: the attempt that lost the
        race gets here at the same moment as the one that won, and without the
        lock both saw no invoice and no entry, and wrote one each — two
        invoices for one sale, and one customer counted in twice.

        A transaction of its own, never the sale's: nothing here may undo an
        order the customer has paid for. A step that fails is rolled back to
        its own savepoint and reported, and the steps after it still run.
        """
        with transaction.atomic():
            # Only the order's own row: pretix' order manager joins the event
            # for its scope, and a plain FOR UPDATE would lock the event row
            # too — every till's tail waiting on every other's.
            order = Order.objects.select_for_update(of=OF_SELF).get(pk=order.pk)
            self._ensure_invoice(request, order)
            return self._check_in(
                request, order, offline_at=offline_at, replayed=replayed
            )

    def _ensure_invoice(self, request, order):
        """
        Generate the invoice this order should have but does not yet.

        Called on the first attempt, and again on a replay: it checks what
        exists before doing anything, so running it twice costs a query, never
        a second invoice — and never both at once, see :meth:`_finish`.
        """
        settings = request.event.settings
        # The plugin answers for its own channel. An event set to invoice "by
        # hand" — a reasonable webshop policy — would otherwise leave every till
        # sale without an invoice, and a cancellation from the till without a
        # credit note to issue. The event-wide modes still apply on top, so an
        # organiser who invoices everything keeps invoicing everything.
        wants_invoice = (
            pos_invoices_enabled(request.event)
            or (
                invoice_qualified(order)
                and (
                    settings.get("invoice_generate") == "True"
                    or (
                        settings.get("invoice_generate") == "paid"
                        and order.status == Order.STATUS_PAID
                    )
                )
            )
        )
        # A zero-total order is not invoiceable anywhere, whatever the switch says.
        if wants_invoice and order.total and not order.invoices.last():
            try:
                # Its own savepoint, so that a database error on the way leaves
                # the check-ins after it a transaction they can still use.
                with transaction.atomic():
                    generate_invoice(order, trigger_pdf=True)
            except Exception as e:
                logger.exception("Could not generate invoice for POS order %s", order.code)
                order.log_action(
                    "pretix.event.order.invoice.failed", data={"exception": str(e)}
                )

    def _check_in(self, request, order, *, offline_at=None, replayed=False):
        """
        Walk the customer straight in.

        Deliberately best-effort: the money is already in the drawer, so a
        check-in that fails is reported back to the app for the operator to sort
        out, never a reason to fail the sale.

        Positions that already have an entry on the list are left alone,
        whoever made it. On a replay the customer may have walked to the door
        and been scanned there in the meantime; on the first attempt, a retry
        that overlapped it may have finished the tail first. Forcing a second
        entry would count one person twice either way.

        The count answered is what the till announces. The first attempt says
        how many of the order's tickets are in, whoever let them in, so a till
        whose own retry got there first still says "let them in". A replay
        says only what it did itself — nothing, when nothing was missing.

        ``offline_at`` is when a sale rung up with no network happened: the
        customer walked in then, not when the till found the network again.
        """
        clist = checkin_list_for(request.event)
        if not clist:
            return None, []

        # Only admission products. A check-in list with all_products=True happily
        # accepts a keyring or a T-shirt, and pretix will dutifully record it —
        # but "checked in" means the holder walked through the door, and a merch
        # line has no door. Left unfiltered it also made the till announce
        # "let them in" after a pure shop sale.
        positions = [p for p in order.positions.select_related("item") if p.item.admission]
        already = set(
            Checkin.objects.filter(
                position__in=positions, list=clist, type=Checkin.TYPE_ENTRY
            ).values_list("position_id", flat=True)
        ) if positions else set()
        missing = [p for p in positions if p.pk not in already]

        checked_in = 0 if replayed else len(already)
        errors = []
        for position in missing:
            try:
                # A savepoint per ticket: one that fails in the database rolls
                # back alone, and the next customer's ticket is still tried.
                with transaction.atomic():
                    walk_in(
                        position,
                        clist,
                        auth=request.auth,
                        user=request.user if request.user.is_authenticated else None,
                        offline_at=offline_at,
                    )
                checked_in += 1
            except CheckInError as e:
                errors.append(str(e))
            except Exception as e:
                logger.exception("Unexpected error checking in POS order %s", order.code)
                errors.append(str(e))
        return checked_in, errors
