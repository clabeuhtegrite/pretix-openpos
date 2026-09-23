import logging
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.db import IntegrityError, transaction
from django.db.models import Count, Exists, F, OuterRef, Q
from django.utils.timezone import make_aware, now
from django.utils.translation import gettext_lazy as _
from django_scopes import scopes_disabled
from i18nfield.strings import LazyI18nString
from pretix.api.serializers.order import OrderCreateSerializer
from pretix.base.models import Checkin, Device, Order, Quota, TeamAPIToken
from pretix.base.models.orders import OrderPayment, OrderRefund
from pretix.base.services.checkin import CheckInError, RequiredMediaExchangeError, perform_checkin
from pretix.base.services.invoices import generate_invoice, invoice_qualified
from pretix.base.services.orders import OrderError, cancel_order
from pretix.base.signals import order_paid, order_placed
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from .. import __version__
from ..backoffice import till_cancelling
from ..channels import POS_CHANNEL, PosSalesChannelType
from ..invoicing import pos_invoices_enabled
from ..models import PosCategory, PosDevice, PosSale, PosTerminalPayment, refund_key, reversed_positions
from ..payment import CARD, CASH
from ..sumup import CHECKOUT_CLOSED, SumUpAccount, SumUpError, still_running, succeeded
from ..webhook import webhook_url

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


def get_pos_channel(organizer):
    """
    Return the organizer's POS sales channel, creating it if needed.

    pretix only calls ``create_default_sales_channels()`` when an organizer is
    created, so organizers that predate the plugin would otherwise never get one.
    """
    channel, _created = organizer.sales_channels.get_or_create(
        identifier=POS_CHANNEL,
        defaults={
            "label": LazyI18nString.from_gettext(PosSalesChannelType.verbose_name),
            "type": POS_CHANNEL,
            "position": 100,
        },
    )
    return channel


def resolve_price(item, variation=None, subevent=None) -> Decimal:
    """
    What a product costs, priced by pretix and by nothing else.

    The date's own price, then the variation price, then the item price: pretix'
    own resolution order, with nothing layered on top. The till used to carry a
    price list of its own, so that one product could be worth one thing online
    and another at the door. That is exactly what made the takings impossible to
    read afterwards — the same product, two prices, no way to tell from a line
    which one was charged.

    A door that charges more than the webshop sells a *different* product: one
    limited to the ``openpos`` sales channel and priced in pretix like
    everything else. Then a product is worth what pretix says it is worth,
    whichever counter rang it up, and the two figures reconcile by themselves.
    """
    if variation is not None:
        if subevent is not None:
            per_date = subevent.var_price_overrides.get(variation.pk)
            if per_date is not None:
                return per_date
        if variation.default_price is not None:
            return variation.default_price
        return item.default_price
    if subevent is not None:
        per_date = subevent.item_price_overrides.get(item.pk)
        if per_date is not None:
            return per_date
    return item.default_price


def for_date(quotas, subevent):
    """
    The quotas that apply on the date being sold.

    A series keeps one set of quotas per date, so counting them all together
    would report the whole season's remaining places at a door selling one
    evening. ``None`` means the event is not a series and every quota applies.
    """
    if subevent is None:
        return quotas
    return [quota for quota in quotas if quota.subevent_id == subevent.pk]


def quota_availability(quotas, cache):
    """
    Remaining places across a set of quotas, or ``None`` when unlimited.

    Returns 0 as soon as any quota reports something other than "available",
    because a position needs every one of its quotas to have room — and 0 for
    a product attached to no quota at all. pretix' own shop treats that as
    unavailable and its order pipeline refuses it ("not assigned to a quota"),
    so a till showing it as unlimited would let it into a basket only to be
    refused at payment, in front of the customer. Sold out is what the
    organiser sees at once; a quota, unlimited if need be, is the fix.
    """
    quotas = list(quotas)
    if not quotas:
        return 0
    remaining = None
    for quota in quotas:
        state, available = quota.availability(_cache=cache)
        if state != Quota.AVAILABILITY_OK:
            return 0
        if available is None:
            continue
        remaining = available if remaining is None else min(remaining, available)
    return remaining


#: Longest run of transactions a till shows itself.
#:
#: The history covers the whole event, not the calendar day, so a till that has
#: run a multi-day festival can have more than this — hence the ``truncated``
#: flag rather than a silent cut. Reading a whole event is the back office's job.
HISTORY_LIMIT = 100

#: Most tickets a till will carry for offline scanning.
#:
#: The whole point is to survive a dropout at a door, and the doors this runs at
#: sell in the hundreds. Well past that the snapshot stops being something to
#: hold in a browser, and saying so beats a silently partial guest list.
OFFLINE_SNAPSHOT_LIMIT = 20000


#: Where one till day ends and the next begins, in the event's timezone.
#:
#: Six in the morning, not midnight: a till serves an evening, and an evening
#: crosses midnight. At 01:30 the drawer still holds everything taken since the
#: doors opened, so the figure it reconciles against must not have reset at
#: 00:00 — which is exactly the mistake the history screen used to make. Six is
#: late enough that any night has ended, early enough that none has begun.
#: (Chosen safely clear of DST switches, which happen at 2–3 am.)
BUSINESS_DAY_STARTS_AT = time(6, 0)


def start_of_business_day(event, at=None):
    """
    The start of the night ``at`` belongs to: 6 am on the day that night began.

    What sorts the takings into evenings, and a series' sales into its dates.
    ``at`` is the moment being asked about, defaulting to this one. A sale
    replayed the next morning has to be placed in the night it was rung up in,
    not the one it arrives in.
    """
    local = (at or now()).astimezone(event.timezone)
    day = local.date()
    if local.time() < BUSINESS_DAY_STARTS_AT:
        day -= timedelta(days=1)
    return make_aware(datetime.combine(day, BUSINESS_DAY_STARTS_AT), event.timezone)


#: How late a scan may reach the server and still be taken for a live one.
#:
#: pretix' own threshold, from ``Checkin.is_late_upload``. It matters for the
#: scans that were queued with no network before this plugin sent them the way
#: pretix expects offline scans to be sent: those carry no offline flag, and
#: the gap between the moment of the scan and the moment it arrived is the only
#: trace that they waited on a device.
LATE_UPLOAD = timedelta(minutes=2)

#: A scan made with no network, then sent: flagged by the device that sent it,
#: or visibly late.
SENT_AFTER_THE_FACT = Q(force_sent=True) | Q(created__gt=F("datetime") + LATE_UPLOAD)


def door_scans(event, device, subevent=None):
    """
    What the doors have scanned for this event, per device and in all.

    Read from pretix' own check-in rows rather than counted by the app: a count
    kept in a browser is gone whenever iOS reloads the page, and that is what a
    door found out on its first evening — the figure on the scanner went back
    to zero every time somebody stepped out of the app for a while. The rows
    are there anyway; counting them is the figure that cannot be lost.

    A scan is a check-in that came through the check-in API with a code in it:
    a scanning app, this one or pretixSCAN. The check-in written at the till
    with a sale is not one — nobody scanned anything — and neither is an
    automatic or a back-office one, which is exactly the set of rows that
    carries no ``raw_source_type``. Entries only: a door counts people coming
    in.

    The whole event, whenever the scan was made. It used to be tonight only,
    from six in the morning like the takings, so a phone that had let seventy
    people in read zero on every day after, on that very event. In a series,
    ``subevent`` narrows it to one date: its doors, and its tickets at doors
    kept for every date.
    """
    scope = Q(list__event=event, type=Checkin.TYPE_ENTRY, raw_source_type__isnull=False)
    if subevent is not None:
        scope &= Q(list__subevent=subevent) | Q(
            list__subevent__isnull=True, position__subevent=subevent
        )
    admitted = Q(successful=True, position__item__admission=True)
    with scopes_disabled():
        rows = list(
            Checkin.all.filter(scope)
            .order_by()
            .values("device_id")
            .annotate(
                admitted=Count("pk", filter=admitted),
                # Recorded, but for a product that lets nobody in: the T-shirt
                # scanned at a list that takes every product.
                other=Count("pk", filter=Q(successful=True, position__item__admission=False)),
                refused=Count("pk", filter=Q(successful=False)),
                offline=Count("pk", filter=admitted & SENT_AFTER_THE_FACT),
            )
        )
        names = dict(
            Device.objects.filter(
                pk__in=[row["device_id"] for row in rows if row["device_id"]]
            ).values_list("pk", "name")
        )

    fields = ("admitted", "refused", "other", "offline")

    def figures(row):
        return {field: row[field] if row else 0 for field in fields}

    by_device = {row["device_id"]: row for row in rows}
    devices = [
        {
            # None for scans made from the back office, which have no device.
            "name": names.get(pk) if pk else None,
            "current": device is not None and pk == device.pk,
            **figures(row),
        }
        for pk, row in by_device.items()
    ]
    devices.sort(key=lambda d: (-d["admitted"], d["name"] is None, d["name"] or ""))
    return {
        "device": figures(by_device.get(device.pk)) if device else None,
        "event": {field: sum(row[field] for row in rows) for field in fields},
        "devices": devices,
    }


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


def selling_subevent(event, at=None, *, settled=False):
    """
    Which date of a series the till is selling for, or ``None`` for a plain event.

    A door till sells for tonight and nothing else. Whoever is standing at it
    has one queue in front of them and no business picking a date off a list
    between customers, so the server picks it — the same way it picks every
    price. The app has never sent either, and this does not change that.

    "Tonight" is the business day the rest of this system runs on: six in the
    morning to six the next. A door still selling at one o'clock is selling
    for the evening that is still going on, not for the next one. Within that
    window the date that has already started wins over one still to come, and
    a date that runs past the window — a festival day with no end time, or one
    ending in the small hours — still counts while it is on.

    ``at`` is the moment the money moved, so a sale replayed the next morning
    is booked against the night it was rung up in rather than the one it
    arrives in. ``settled`` says that money has already changed hands: nothing
    is refused then, because refusing does not give it back, it only strands
    the sale outside pretix. The nearest date is used instead.

    Otherwise this raises, and the refusal belongs at the catalogue, where a
    volunteer meets it while setting up. pretix used to raise it at the payment
    instead, in front of a customer, in the form "the product is not assigned
    to a quota" — which names the wrong cause entirely.
    """
    if not event.has_subevents:
        return None

    moment = at or now()
    opened = start_of_business_day(event, moment)
    closes = opened + timedelta(days=1)
    # Bounded because a season can hold hundreds of dates and only the ones
    # around this evening can win. Ordered so the last to have started is the
    # first considered.
    candidates = list(
        event.subevents.filter(active=True, date_from__lt=closes)
        .order_by("-date_from")[:20]
    )

    def ends(subevent):
        # A date with no end time runs to the end of its own night, not to the
        # instant it started. Most organisers never fill the end in, and
        # treating the date as over the moment the doors open would send every
        # sale after that to the next evening in the series.
        if subevent.date_to:
            return subevent.date_to
        return start_of_business_day(event, subevent.date_from) + timedelta(days=1)

    # Started already and not over: the one the queue outside is for. The most
    # recently started, so two dates overlapping resolve to the later.
    for subevent in candidates:
        if subevent.date_from <= moment and ends(subevent) >= moment:
            return subevent
    # Otherwise the next one tonight — a door sells before it opens.
    upcoming = [s for s in candidates if s.date_from > moment and s.date_from >= opened]
    if upcoming:
        return upcoming[-1]

    if settled:
        # Whatever is closest to when the money moved. A guess, and said to be
        # one — but a sale that cannot be booked at all is worse than one
        # booked against the neighbouring date, which somebody can move.
        nearest = min(
            event.subevents.filter(active=True),
            key=lambda s: abs(s.date_from - moment),
            default=None,
        )
        if nearest is not None:
            return nearest

    raise ValidationError(
        {
            "detail": [
                _("Nothing is on tonight. This event is a series, and the till "
                  "sells for the date that is on — add one for tonight, or "
                  "check that it is switched on.")
            ],
            "code": "series_closed",
        }
    )


def evening_subevent(event):
    """
    The date of a series that the evening's figures are about, or ``None``.

    ``None`` for a plain event: its figures are the whole event's. In a series,
    the date the till sells for tonight, or failing that the nearest one, as for
    a sale already paid: a figure has to be about some date, and nothing is
    refused for it. ``None`` too for a series with no date switched on, whose
    figures are then the whole series'.
    """
    if not event.has_subevents:
        return None
    try:
        return selling_subevent(event, settled=True)
    except ValidationError:
        return None


def setting_row_id(event, setting):
    """
    The id of the row one of the till's settings names, or ``None``.

    Read as text and parsed here rather than asked for ``as_type=int``: the
    settings screen stores its "none" choice as an empty string, not as an
    absent setting, and hierarkey turns ``""`` into a ValueError. Every till
    request reads these, so saving that screen with a button switched off —
    or with the check-in list left on "Do not check in automatically" —
    answered every one of them with a server error.
    """
    try:
        return int(event.settings.get(setting))
    except (TypeError, ValueError):
        return None


def checkin_list_for(event):
    pk = setting_row_id(event, "openpos_checkin_list")
    if not pk:
        return None
    return event.checkin_lists.filter(pk=pk).first()


def configured_item(event, setting):
    """
    The product an organiser set aside for one of the till's extra buttons.

    ``None`` when the setting is empty, and equally when it names a product
    that has since been deleted — which is what keeps the button off rather
    than pointing at nothing.
    """
    pk = setting_row_id(event, setting)
    if not pk:
        return None
    return event.items.filter(pk=pk).first()


def custom_sale_item(event):
    """The product every free-amount sale is booked against, if enabled."""
    return configured_item(event, "openpos_custom_item")


def deposit_item(event):
    """The product a cup deposit is sold as, if enabled."""
    return configured_item(event, "openpos_deposit_item")


class ResolvedLine:
    """One basket line, priced, with everything the caller needs downstream."""

    __slots__ = (
        "item", "variation", "price", "tariff", "count", "description", "refund",
        "outside_role",
    )

    def __init__(
        self, *, item, variation, price, tariff, count, description, refund,
        outside_role=False,
    ):
        self.item = item
        self.variation = variation
        #: What the customer is charged for one of these.
        self.price = price
        #: What the catalogue says one costs, for the two to be compared.
        self.tariff = tariff
        self.count = count
        self.description = description
        self.refund = refund
        #: Sold by a device whose role does not cover this category. Only ever
        #: true on a sale already paid for: a live one is refused outright.
        self.outside_role = outside_role


def resolve_line(
    line, *, sellable, custom_item, deposit, settled, subevent=None,
    off_limits=frozenset(),
):
    """
    Price one line of a basket, and refuse the ones that may not be sold.

    The single place a line's price is decided, and it has to stay that way:
    the card reader is charged from here at the moment the cardholder is asked,
    and the order is booked from here afterwards. Two implementations of these
    rules would eventually charge one figure and book another.

    ``settled`` says the money has already changed hands — a sale replayed from
    a till that was cut off, or one the card reader has already taken. It buys
    two things. Prices come from the line rather than from the catalogue,
    because what was charged is a fact and not a proposal; and a catalogue that
    has moved since stops being a reason to refuse, because refusing does not
    give the money back, it only strands the sale outside pretix.

    ``off_limits`` is the categories this device is not the one to sell. A line
    from one of them is refused outright while nothing has been taken, and only
    reported once something has — see :func:`_outside_role`.
    """
    item = sellable.get(line["item"])
    if item is None:
        raise ValidationError(
            {"positions": [_("Product {id} is not on sale at the till.").format(id=line["item"])]}
        )

    # What this till is for, before what it costs. Checked here rather than
    # left to the grid the app drew, which is the whole reason the answer is
    # stored on the server: a volunteer coming out of the scanner is one tap
    # from the beer, and a catalogue is only a suggestion once the request has
    # left the tablet.
    outside_role = item.category_id in off_limits
    if outside_role and not settled:
        raise ValidationError(
            {
                "positions": [
                    _("This till does not sell {category}.").format(
                        category=str(item.category.name) if item.category else ""
                    )
                ],
                "code": "category_not_sold",
            }
        )

    variations = list(item.variations.all())
    variation = None
    if line["variation"] is not None:
        variation = next((v for v in variations if v.pk == line["variation"]), None)
        if variation is None or (not variation.active and not settled):
            raise ValidationError(
                {"positions": [_("Unknown option for product {name}.").format(name=str(item.name))]}
            )
    elif variations:
        raise ValidationError(
            {"positions": [_("Product {name} requires an option to be chosen.").format(name=str(item.name))]}
        )

    description = line["description"].strip()
    is_refund = line["refund"]
    sent_price = line["price"]
    if sent_price is not None and not isinstance(sent_price, Decimal):
        # A line the serializer validated arrives as a Decimal; one read back
        # out of a pinned basket arrives as the string JSON stored. Everything
        # below does arithmetic with it, so the conversion belongs here — the
        # one place a line's price is decided — rather than at each caller.
        sent_price = Decimal(str(sent_price))

    tariff = resolve_price(item, variation, subevent)
    if is_refund:
        # A deposit handed back is worth exactly what the deposit costs,
        # negated here rather than sent: the till names the product, the server
        # prices it, as everywhere else.
        tariff = -tariff
        if not settled and (deposit is None or item.pk != deposit.pk):
            raise ValidationError(
                {"positions": [_("This product is not the one deposits are taken on.")]}
            )
    elif description and not settled:
        if custom_item is None or item.pk != custom_item.pk:
            raise ValidationError(
                {"positions": [_("Free amounts can only be sold on the product set aside for them.")]}
            )
        if sent_price is None or sent_price <= Decimal("0.00"):
            raise ValidationError(
                {"positions": [_("A free amount has to be more than nothing.")]}
            )
        # The one price the till decides. It is not compared with the tariff and
        # never reported as off-tariff: the product's own price is a placeholder
        # that no free-amount sale is charged at.
        tariff = sent_price

    # A settled line always has one: an offline sale is refused whole by
    # CheckoutSerializer unless every line carries what was charged, and a
    # basket pinned for the card reader was priced here in the first place.
    price = sent_price if settled else tariff

    return ResolvedLine(
        item=item,
        variation=variation,
        price=price,
        tariff=tariff,
        count=line["count"],
        description=description,
        refund=is_refund,
        outside_role=outside_role,
    )


def sellable_items(event, channel, *, settled):
    """
    What may be sold — and, for a sale already paid for, what may be recorded.

    An online sale is refused unless the product is on the till's channel right
    now: nothing has been taken, so refusing costs a tap. A sale that has
    already been paid for is a different question — the catalogue may well have
    moved since, and refusing then does not undo the sale.
    """
    items = event.items.all()
    if not settled:
        items = items.filter_available(channel=channel)
    # The category rides along because every line is now asked which one it is
    # in, and naming it in a refusal is the difference between "this till does
    # not sell Bar" and a product id.
    return {
        item.pk: item
        for item in items.select_related("category").prefetch_related("variations")
    }


def settle_terminal_payment(payment, account):
    """
    Ask SumUp what became of a reader payment, and write it down.

    The only place a payment is allowed to become successful, and the reason
    the unsigned callback is harmless: that callback causes this to run, and
    this asks the Transactions API over an authenticated connection. The till
    polls into the same function on a timer, so an installation SumUp cannot
    reach settles every payment anyway, a second or two later.
    """
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
        if exc.retryable:
            # Nothing is written. "We could not ask" is not "it failed", and
            # writing the latter would lose a payment that went through while
            # a cable was out — money taken, no sale, and nothing to point at.
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


def plugin_enabled(event) -> bool:
    return "pretix_openpos" in event.get_plugins()


class OpenPosOrganizerViewSet(viewsets.ViewSet):
    """
    Organizer-level endpoint, so a till can find out which events it may sell for.

    Needed because the device token grants access to events, not to the POS:
    an organizer can perfectly well run Open POS on one event and not another.
    Listing them server-side keeps the app from offering an event whose
    endpoints would then refuse it.

    Every event the caller may reach is in the answer, one way or the other.
    ``results`` are the ones the till can switch to; ``unavailable`` are the
    ones it cannot, each with the reason. Leaving those out altogether is what
    made a device with access to two events look as if it had only one: the
    switcher only appears once there is a choice, so the event somebody was
    looking for was simply absent, and nothing on the till said why.

    Whether the shop is live is not a condition, and used to be. It says
    whether the public can buy online, which is not the till's business, and
    none of the till's endpoints ever asked: an event still being prepared, or
    one that only ever sells at the door and never put its shop online, is
    exactly the kind of event a till gets taken to.
    """

    def list(self, request, **kwargs):
        results = []
        unavailable = []
        for event in reachable_events(request).select_related("organizer").order_by("date_from"):
            entry = {
                "slug": event.slug,
                "organizer": event.organizer.slug,
                "name": str(event.name),
                "currency": event.currency,
                "testmode": event.testmode,
                "date_from": event.date_from.isoformat() if event.date_from else None,
            }
            if plugin_enabled(event):
                results.append(entry)
            else:
                # A code rather than a sentence: the till words it, in its own
                # language, with the back-office path that fixes it.
                unavailable.append({**entry, "reason": "plugin_disabled"})
        # A separate list rather than a flag on each entry, so a till still
        # running an older build — which offers every result it is given —
        # never offers one its endpoints would refuse.
        return Response({"results": results, "unavailable": unavailable})


def reachable_events(request):
    """
    The events this caller may see at all, decided the way pretix decides it.

    Mirrors pretix' own event list: a device or a team token by its own
    access, anybody else by their teams. The answer now names events that
    are not on sale yet, so it must not name one the caller has no access to.
    """
    if isinstance(request.auth, (Device, TeamAPIToken)):
        return request.auth.get_events_with_any_permission()
    return request.user.get_events_with_any_permission(request).filter(
        organizer=request.organizer
    )


def offline_restrictions(position):
    """
    What pretix refuses this ticket for at every door, for a guest list to carry.

    A ticket blocked in the back office, or only valid from or until a given
    moment, is refused online — and was let in with no network, since the guest
    list said nothing about it. The moments are sent rather than applied here:
    the app checks them against its own clock at the time of the scan, so a
    ticket that becomes valid in the middle of a dropout walks in when it does.

    Only when set, which is almost never, so that the list a phone downloads
    does not grow by three empty keys per ticket.
    """
    restrictions = {}
    if position.blocked:
        restrictions["blocked"] = True
    if position.valid_from:
        restrictions["valid_from"] = position.valid_from.isoformat()
    if position.valid_until:
        restrictions["valid_until"] = position.valid_until.isoformat()
    return restrictions


class OpenPosViewSet(viewsets.ViewSet):
    """
    Everything the till needs, and nothing else.

    Authentication is by pretix device token, so each tablet carries its own
    revocable credential. The matching security profile narrows a paired device
    down to exactly these four endpoints.
    """

    permission = "event.orders:read"
    write_permission = "event.orders:write"

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        # A device may well have access to events that do not run the POS.
        # Refusing here is what keeps a stale app from selling on an event the
        # organizer never opened a till for.
        if not plugin_enabled(request.event):
            raise PermissionDenied(
                _("Open POS is not enabled for the event {slug}.").format(
                    slug=request.event.slug
                )
            )

    # -- config ------------------------------------------------------------

    @action(detail=False, methods=["get"], url_path="config", url_name="config")
    def config(self, request, **kwargs):
        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None
        pos_device = PosDevice.for_device(device)
        clist = checkin_list_for(event)
        # The two extra buttons follow their product's category like any other
        # tile. A door told to sell tickets only has no business handing a cup
        # deposit back over the counter, and offering the button anyway would
        # put a volunteer in front of a refusal with a customer waiting.
        off_limits = PosCategory.off_limits(event, pos_device)
        custom = custom_sale_item(event)
        if custom is not None and custom.category_id in off_limits:
            custom = None
        deposit = deposit_item(event)
        if deposit is not None and deposit.category_id in off_limits:
            deposit = None
        # The till is told the figure rather than working one out: the deposit
        # is an ordinary product, and its return has to be worth exactly what
        # taking it was worth.
        deposit_price = resolve_price(deposit) if deposit else None
        return Response(
            {
                # The plugin's version, which is also the version the bundle is
                # built with. A till that stays open across a deploy — a whole
                # festival weekend, routinely — compares this against its own
                # build on the idle refresh and offers a reload.
                "version": __version__,
                "event": {
                    "slug": event.slug,
                    "organizer": event.organizer.slug,
                    "name": str(event.name),
                    "currency": event.currency,
                    "testmode": event.testmode,
                    "timezone": str(event.timezone),
                },
                "device": {
                    "serial": device.unique_serial if device else None,
                    "name": device.name if device else None,
                    # What this device is for. Empty means nobody has said, and
                    # the app then behaves as it always has — the till, with the
                    # door one tap away. See PosDevice.
                    "role": pos_device.role,
                    # Whether a card payment here has to come from a reader this
                    # device drives. The app reads it to decide what the payment
                    # panel offers; the server does not take the app's word for
                    # it and checks the same thing again at checkout.
                    "card": card_mode(pos_device),
                },
                "checkin": {
                    # The list tickets are checked in on when they are sold.
                    "enabled": clist is not None,
                    "list_id": clist.pk if clist else None,
                    "list_name": str(clist.name) if clist else None,
                    # Every list of the event, so the door-scanning mode can
                    # offer a choice when there is more than one.
                    "lists": [
                        {
                            "id": cl.pk,
                            "name": str(cl.name),
                            "all_products": cl.all_products,
                            "include_pending": cl.include_pending,
                        }
                        for cl in event.checkin_lists.order_by("name", "pk")
                    ],
                },
                # Which products actually admit somebody.
                #
                # Every item of the event, not just the ones sellable at the
                # till: the app has to judge tickets sold online too, and a
                # ticket missing from this list would be announced at the door
                # as something that lets nobody in. A check-in list set to
                # "all products" happily accepts a T-shirt, and pretix records
                # it — but a merch line has no door, and the scanning screen
                # should not answer it with a green "let them in".
                "admission_items": list(
                    event.items.filter(admission=True).values_list("pk", flat=True)
                ),
                # Quick-tender buttons on the cash keypad.
                "cash_denominations": ["5.00", "10.00", "20.00", "50.00"],
                # The two buttons that only exist when an organiser has named a
                # product for them. Absent a product, the till shows nothing —
                # which is also what a till running an older build does.
                "custom_sale": {
                    "enabled": custom is not None,
                    "item": custom.pk if custom else None,
                    "name": str(custom.name) if custom else None,
                },
                "deposit": {
                    "enabled": deposit is not None,
                    "item": deposit.pk if deposit else None,
                    "name": str(deposit.name) if deposit else None,
                    # So the till can show what a return takes off the basket,
                    # and price one while it is cut off from the network.
                    "price": str(deposit_price) if deposit else None,
                },
            }
        )

    # -- catalogue ---------------------------------------------------------

    @action(detail=False, methods=["get"], url_path="catalog", url_name="catalog")
    def catalog(self, request, **kwargs):
        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None
        # What this device is for, narrowing what it is offered. The grid is
        # only the polite half of the rule — the checkout refuses the same
        # lines — but it is the half that stops a volunteer coming out of the
        # scanner from tapping a beer by mistake, which is what it is for.
        off_limits = PosCategory.off_limits(event, PosDevice.for_device(device))
        channel = get_pos_channel(event.organizer)
        # Raises for a series with nothing on, which is a 400 here rather than
        # a refusal at the payment: the volunteer meets it while setting up.
        subevent = selling_subevent(event)
        quota_cache = {}
        custom = custom_sale_item(event)

        items = (
            event.items.all()
            .filter_available(channel=channel)
            .select_related("category")
            .prefetch_related("variations", "quotas", "variations__quotas")
            .order_by("category__position", "category_id", "position", "pk")
        )

        categories = {}
        for item in items:
            # The product free amounts are booked against is not a product
            # anyone taps: its price is a placeholder, and a tile reading
            # "Misc — 0.00" beside the free-amount button is an invitation to
            # sell nothing for nothing. It has to stay on the channel all the
            # same, because that is what the checkout resolves it against, so
            # hiding it is this line rather than the organiser's problem.
            if custom is not None and item.pk == custom.pk:
                continue
            if item.category_id in off_limits:
                continue
            variations = list(item.variations.all())
            entry = {
                "id": item.pk,
                "name": str(item.name),
                "admission": item.admission,
                "picture": request.build_absolute_uri(item.picture.url) if item.picture else None,
                "variations": [],
            }

            if variations:
                # A product with variations is never sold on its own.
                entry["price"] = None
                entry["available"] = None
                for variation in variations:
                    if not variation.active:
                        continue
                    entry["variations"].append(
                        {
                            "id": variation.pk,
                            "name": str(variation.value),
                            "price": str(resolve_price(item, variation, subevent)),
                            "available": quota_availability(
                                for_date(variation.quotas.all(), subevent), quota_cache
                            ),
                        }
                    )
                if not entry["variations"]:
                    continue
            else:
                entry["price"] = str(resolve_price(item, None, subevent))
                entry["available"] = quota_availability(
                    for_date(item.quotas.all(), subevent), quota_cache
                )

            category_id = item.category_id or 0
            if category_id not in categories:
                categories[category_id] = {
                    "id": item.category_id,
                    "name": str(item.category.name) if item.category else str(_("Uncategorised")),
                    "items": [],
                }
            categories[category_id]["items"].append(entry)

        return Response({"categories": list(categories.values())})

    # -- checkout ----------------------------------------------------------

    @action(detail=False, methods=["post"], url_path="checkout", url_name="checkout")
    def checkout(self, request, **kwargs):
        from .serializers import CheckoutSerializer

        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None

        serializer = CheckoutSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        idempotency_key = data["idempotency_key"]

        # A retry of a sale we already committed must hand back the original
        # rather than sell a second set of tickets.
        replay = PosSale.objects.filter(
            event=event, idempotency_key=idempotency_key
        ).first()
        if replay:
            body = self._checkout_payload(event, replay, replayed=True)
            # The original attempt may have died between committing the order
            # and the best-effort tail: the connection that carried this very
            # retry is proof that connections die at the worst moment. Whatever
            # is missing — the invoice, the check-ins, and nothing else — is
            # done now. Idempotent: a second retry finds nothing left to do.
            if replay.kind == PosSale.KIND_SALE and replay.order is not None:
                self._ensure_invoice(request, replay.order)
                checked_in, checkin_errors = self._check_in(
                    request,
                    replay.order,
                    only_missing=True,
                    offline_at=replay.datetime if replay.offline else None,
                )
                body["checked_in"] = checked_in
                body["checkin_errors"] = checkin_errors
            return Response(body, status=status.HTTP_200_OK)

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
        pos_device = PosDevice.for_device(device)
        terminal = None
        if (
            data["payment_type"] == PosSale.PAYMENT_CARD
            and pos_device.drives_terminal
        ):
            terminal = PosTerminalPayment.objects.filter(
                event=event, idempotency_key=idempotency_key
            ).first()
            if (
                terminal is None
                or terminal.status != PosTerminalPayment.STATUS_SUCCESSFUL
                or not terminal.belongs_to(device)
            ):
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

        channel = get_pos_channel(event.organizer)
        offline = data.get("offline")
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

        sellable = sellable_items(event, channel, settled=settled)
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
            # reported rather than smoothed away. A free amount is the same
            # story with no tariff to diverge from, so it is left out of the
            # comparison. A card payment the reader has already taken is priced
            # from the row written when the cardholder was asked, so it can
            # diverge the same way and is reported the same way.
            if settled and price != tariff and not description:
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
            if settled and price != tariff and not description:
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

        with transaction.atomic():
            # No order when the basket is nothing but returned cups, which is
            # the whole of the queue at the end of an evening. There is nothing
            # for pretix to hold: an order cannot be worth less than nothing.
            if api_positions:
                order_serializer = OrderCreateSerializer(
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
                )

        # Everything below runs after the sale is durably committed: a failure
        # here must never undo an order the customer has already paid for.
        checked_in, checkin_errors = None, []
        if order is not None:
            self._post_commit(request, order)
            checked_in, checkin_errors = self._check_in(
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
        return Response(body, status=status.HTTP_201_CREATED)

    # -- offline snapshot ---------------------------------------------------

    # -- the card reader ---------------------------------------------------

    def _terminal_context(self, request):
        """The reader this till drives, refusing every till that drives none."""
        device = request.auth if isinstance(request.auth, Device) else None
        pos_device = PosDevice.for_device(device)
        if not pos_device.drives_terminal:
            raise ValidationError(
                {"detail": [_("No card reader is assigned to this till.")],
                 "code": "no_terminal"}
            )
        return device, pos_device, SumUpAccount(request.event.organizer)

    def _terminal_payload(self, payment):
        return {
            "status": payment.status,
            "amount": str(payment.amount),
            "currency": payment.currency,
            "failure": payment.failure,
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
        held = settle_terminal_payment(held, account)
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
        """Where a payment has got to. Polled by the till while it waits."""
        device, _pos_device, account = self._terminal_context(request)
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
        return Response(self._terminal_payload(settle_terminal_payment(payment, account)))

    @action(detail=False, methods=["post"], url_path="terminal/cancel", url_name="terminal-cancel")
    def terminal_cancel(self, request, **kwargs):
        """
        Take the amount back off the reader.

        Best-effort, and honestly so: SumUp confirms nothing, and the device
        only obeys while it is still waiting for the cardholder. So the answer
        is whatever the payment turns out to be afterwards, not whatever was
        asked for — a card tapped in the same second is a payment, and the till
        has to be told that rather than a cancellation that did not happen.
        """
        device, _pos_device, account = self._terminal_context(request)
        payment = PosTerminalPayment.objects.filter(
            event=request.event,
            idempotency_key=request.data.get("idempotency_key", ""),
        ).first()
        if payment is None or not payment.belongs_to(device):
            raise ValidationError(
                {"detail": [_("No card payment was started for this basket.")],
                 "code": "no_payment"}
            )
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
        return Response(self._terminal_payload(settle_terminal_payment(payment, account)))

    @action(detail=False, methods=["get"], url_path="offline", url_name="offline")
    def offline(self, request, **kwargs):
        """
        Everything a till needs to keep working with the network gone.

        Two halves. The tariff is already in the catalogue the app caches, so
        what is missing is the door: which secrets are valid on this list, what
        they admit, and who they belong to. Downloaded while the connection is
        there so that a dropout is survivable rather than merely detectable.

        This is the guest list, and it leaves the server: the payload is
        therefore the narrowest one that still answers a scan — no e-mail, no
        order code, no price. A device token already reaches the same data one
        scan at a time through pretix' own search endpoint; this only makes it
        usable when there is nothing to ask.
        """
        clist = self._requested_checkin_list(request)
        if clist is None:
            raise ValidationError({"list": [_("Unknown check-in list.")]})

        with scopes_disabled():
            positions = (
                clist.positions.only(
                    "secret", "item_id", "attendee_name_cached",
                    "blocked", "valid_from", "valid_until",
                )
                .order_by("pk")[: OFFLINE_SNAPSHOT_LIMIT + 1]
            )
            rows = list(positions)
            truncated = len(rows) > OFFLINE_SNAPSHOT_LIMIT
            rows = rows[:OFFLINE_SNAPSHOT_LIMIT]
            entered = self._entry_scans_between(clist, rows)
            tickets = [
                {
                    "secret": p.secret,
                    "item": p.item_id,
                    # The cached column, never the `attendee_name` property:
                    # that one reads `attendee_name_parts` and, failing a name
                    # scheme in it, the event's settings — both deferred here,
                    # so every ticket would cost two extra queries and a full
                    # guest list would cost forty thousand. pretix rewrites this
                    # column on every save of the position, so it is the same
                    # string, fetched with the row.
                    "name": p.attendee_name_cached or "",
                    # So a second scan of the same ticket is refused offline too,
                    # rather than discovered hours later at reconciliation.
                    "used": p.pk in entered,
                    **offline_restrictions(p),
                }
                for p in rows
            ]

        return Response(
            {
                "list": {"id": clist.pk, "name": str(clist.name)},
                "generated": now().isoformat(),
                "tickets": tickets,
                # An event too big to carry offline says so, instead of letting a
                # till believe it holds the whole guest list.
                "truncated": truncated,
            }
        )

    # -- history and cancellation ------------------------------------------

    @action(detail=False, methods=["get"], url_path="history", url_name="history")
    def history(self, request, **kwargs):
        """
        What this till has recorded for this event, newest first.

        Scoped to the calling device, and to the whole event rather than to the
        calendar day. A till serves an evening, and an evening crosses midnight:
        cutting the history at 00:00 would empty the screen in the middle of
        service, exactly when a correction is most likely to be needed.

        Device-scoped on purpose, though. An operator correcting a mistake is
        correcting *their* mistake, made minutes ago on the tablet in their
        hand; handing every till the power to reverse every other till's
        takings is a different feature with different consequences, and the back
        office already covers it.
        """
        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None
        if device is None:
            # No device, no till history: this is per-device by design, and
            # answering with the whole event's journal would quietly widen it.
            return Response({"device": None, "results": [], "truncated": False})

        window = list(
            PosSale.objects.filter(event=event, device=device)
            .select_related("order")
            .order_by("-seq")[: HISTORY_LIMIT + 1]
        )
        sales = window[:HISTORY_LIMIT]
        cancelled = PosSale.cancelled_seqs(event, [s.seq for s in sales])

        return Response(
            {
                "device": device.unique_serial,
                "results": [self._journal_payload(s, cancelled) for s in sales],
                # Said rather than implied: a till that has run a whole festival
                # is not looking at everything it ever sold.
                "truncated": len(window) > HISTORY_LIMIT,
            }
        )

    @action(detail=False, methods=["post"], url_path="cancel", url_name="cancel")
    def cancel(self, request, **kwargs):
        """
        Reverse a sale: cancel the order, credit it, refund it, journal it.

        Nothing is ever edited or removed. The order is cancelled through
        pretix' own service, which issues the credit note for the invoice it
        had; the money is recorded as an ``OrderRefund`` so the payment stops
        counting as taken; and the journal gains a *new* line carrying the
        negative amount. The sale it reverses stays exactly as it was written,
        which is the entire point of keeping the journal append-only — the
        takings for the evening remain recomputable from it alone.

        Correcting an order is therefore three documents, not one edit: the
        sale, the credit note, and whatever new sale the operator rings up
        afterwards.
        """
        from .serializers import CancelSerializer

        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None

        serializer = CancelSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # A retry of a cancellation we already committed hands back the same
        # answer rather than trying to cancel an order that is already gone.
        replay = PosSale.objects.filter(
            event=event, idempotency_key=data["idempotency_key"]
        ).first()
        if replay:
            original = PosSale.objects.filter(event=event, seq=replay.cancels_seq).first()
            body = self._cancellation_payload(replay, original, replayed=True)
            # Asked again rather than remembered, and for a reason: the first
            # attempt may have committed the cancellation and then lost the
            # connection before it refunded the card. This is what finishes the
            # job — and when it did run, it answers "already" rather than
            # sending the money a second time.
            body["card_refund"] = (
                self._refund_card(event, original) if original else "none"
            )
            # And the books are brought in line with what just happened. A
            # cancellation whose card refund was refused the first time leaves a
            # failed refund on the order; succeeding on the retry has to clear
            # it, or the order page keeps saying the customer was never paid
            # back long after they were.
            if original is not None and original.order_id:
                self._settle_refund(
                    request,
                    original.order.refunds.order_by("-local_id").first(),
                    body["card_refund"],
                )
            return Response(body, status=status.HTTP_200_OK)

        sale = PosSale.objects.filter(event=event, seq=data["seq"]).select_related("order").first()
        if sale is None:
            raise ValidationError({"seq": [_("No such entry in this event's journal.")]})
        if device is None or sale.device_id != device.pk:
            # Deliberately not a 403: it is not a permission the operator can be
            # granted, it is somebody else's till.
            raise ValidationError(
                {"seq": [_("This sale was made on another till and can only be corrected there.")]}
            )
        if sale.kind != PosSale.KIND_SALE:
            raise ValidationError({"seq": [_("This journal entry is not a sale.")]})
        if PosSale.cancelled_seqs(event, [sale.seq]):
            raise ValidationError({"seq": [_("This sale has already been cancelled.")]})
        if sale.order is None:
            raise ValidationError({"seq": [_("The order behind this sale no longer exists.")]})

        order = sale.order
        if not order.cancel_allowed():
            raise ValidationError(
                {"seq": [_("pretix will not let this order be cancelled: {status}.").format(
                    status=order.get_status_display()
                )]}
            )

        with transaction.atomic():
            try:
                # pretix' own cancellation, so the credit note, the invalidated
                # ticket secrets and the log entry are the ones the back office
                # would have produced. send_mail is off: at a till the customer
                # is standing right there, and the address is usually the
                # organiser's own placeholder for an on-site sale.
                #
                # Said to be the till's own doing, because pretix tells the
                # plugin about every cancellation and one made anywhere else
                # is written to the journal from there. This one is written
                # below, with the till and the cashier it belongs to.
                with till_cancelling():
                    cancel_order(
                        order,
                        device=device,
                        send_mail=False,
                        cancel_invoice=True,
                        email_comment=data["reason"] or None,
                    )
            except OrderError as e:
                raise ValidationError({"seq": [str(e)]})

            order.refresh_from_db()
            refund = self._record_refund(
                request, order, sale, data["reason"],
                # A reader is about to be asked, after this transaction, and it
                # can refuse. Nothing may claim the money is back until it has
                # answered.
                settle_now=PosTerminalPayment.settling(sale) is None,
            )

            cancellation = PosSale.record(
                event=event,
                order=order,
                device=device,
                cashier=data["cashier"],
                payment_type=sale.payment_type,
                # Negative, so the takings stay the plain sum of the column and
                # the drawer reconciles against the journal without arithmetic.
                total=-sale.total,
                positions=reversed_positions(sale.positions),
                idempotency_key=data["idempotency_key"],
                testmode=sale.testmode,
                kind=PosSale.KIND_CANCELLATION,
                cancels_seq=sale.seq,
                reason=data["reason"],
            )

            # The deposit handed back with this sale is a journal row of its
            # own, and reversing only the sale leaves the takings short by its
            # amount for the rest of the evening. The customer put the *net* on
            # the counter — the cups came off the bill — so the net is what
            # goes back, and both halves have to be reversed for the column to
            # return to where it started. Found by the key the sale's own key
            # derives, which is how the two were written together in the first
            # place.
            deposit_refund = PosSale.objects.filter(
                event=event,
                idempotency_key=refund_key(sale.idempotency_key),
                kind=PosSale.KIND_DEPOSIT_REFUND,
            ).first()
            if deposit_refund is not None and not PosSale.cancelled_seqs(
                event, [deposit_refund.seq]
            ):
                PosSale.record(
                    event=event,
                    order=None,
                    device=device,
                    cashier=data["cashier"],
                    payment_type=deposit_refund.payment_type,
                    # Its total is negative — money that left the drawer — so
                    # negating it puts the same amount back.
                    total=-deposit_refund.total,
                    positions=reversed_positions(deposit_refund.positions),
                    # Derived from the cancellation's key exactly as the payout
                    # row derived from the sale's, so a retried cancellation
                    # recognises this half too instead of writing it twice.
                    idempotency_key=refund_key(data["idempotency_key"]),
                    testmode=deposit_refund.testmode,
                    kind=PosSale.KIND_CANCELLATION,
                    cancels_seq=deposit_refund.seq,
                    reason=data["reason"],
                )

        body = self._cancellation_payload(cancellation, sale, replayed=False)
        body["credit_note"] = self._credit_note_number(order)
        body["refunded"] = refund is not None
        # Deliberately after the transaction has committed. Sending money back
        # is a call to somebody else's server: holding a database transaction
        # open across it would keep a row locked for as long as SumUp takes,
        # and rolling the cancellation back afterwards could not un-send it.
        # So the cancellation stands first, and the card is a separate step
        # whose outcome is reported rather than assumed.
        body["card_refund"] = self._refund_card(event, sale)
        self._settle_refund(request, refund, body["card_refund"])
        return Response(body, status=status.HTTP_201_CREATED)

    def _refund_card(self, event, sale):
        """
        Give a card sale's money back through SumUp, when there is a card to
        give it back to.

        Returns what the till should tell the operator:

        ``none``
            Nothing to do here — a cash sale, or a card taken on somebody's
            phone rather than on a reader this server drove. The operator
            refunds those the way they took them.
        ``done``
            SumUp accepted the refund.
        ``already``
            It had been refunded before. Not an error, and not a second refund.
        ``failed``
            The money is still on the customer's card. The operator has to
            refund it from the SumUp app, and has to be told so plainly rather
            than shown a cancellation that looks complete.
        """
        payment = PosTerminalPayment.settling(sale)
        if payment is None:
            return "none"
        if payment.refunded:
            return "already"

        try:
            # In full, and without naming an amount: what goes back is what the
            # card was charged, which is not always what the order is worth — a
            # basket with a deposit handed back in it charges the net. SumUp
            # refunds the transaction, so the transaction's own figure is the
            # right one and the only one that cannot be got wrong here.
            SumUpAccount(event.organizer).refund(payment.transaction_id)
        except SumUpError as exc:
            logger.warning(
                "POS card refund failed for journal #%s: %s", sale.seq, exc.detail
            )
            return "failed"

        payment.refunded = now()
        payment.save(update_fields=["refunded", "updated"])
        return "done"

    # -- takings -----------------------------------------------------------

    @action(detail=False, methods=["get"], url_path="summary", url_name="summary")
    def summary(self, request, **kwargs):
        """
        What the event has taken, for the calling till and overall, in detail.

        The event, not the day. A till day that began at six in the morning
        was the first answer to an evening crossing midnight, and it was still
        the wrong unit: the question at closing time is what the evening took,
        and the evening is the event — or, in a series, the date the till is
        selling, which :func:`evening_subevent` picks exactly as every sale
        does. A reversal lands on the evening of the sale it reverses, since it
        copies that sale's lines, so correcting last week's order corrects last
        week's figures and leaves tonight's alone.

        Figures only, and not a cash session: no float, no count, no drawer.
        What each drawer should hold is the till session's job. This is the
        event as a whole, broken down every way it is read — by payment type,
        by category and product, with the deposits apart, by device, and by
        evening when the event spans several — from one pass over the journal.
        """
        from ..takings import journal_rows, summarise

        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None
        subevent = evening_subevent(event)

        report = summarise(
            event,
            journal_rows(PosSale.objects.filter(event=event), subevent),
            device=device,
            night_of=lambda moment: start_of_business_day(event, moment).date(),
        )

        return Response(
            {
                "scope": {
                    "event": str(event.name),
                    "series": event.has_subevents,
                    "subevent": (
                        {
                            "id": subevent.pk,
                            "name": str(subevent.name),
                            "date_from": subevent.date_from.isoformat(),
                        }
                        if subevent is not None
                        else None
                    ),
                },
                # Kept for a till still running the build before this one,
                # until it is next opened: it prints this as "since".
                "since": report["first"] or now().isoformat(),
                "computed_at": now().isoformat(),
                **report,
            }
        )

    # -- attendance --------------------------------------------------------

    @action(detail=False, methods=["get"], url_path="attendance", url_name="attendance")
    def attendance(self, request, **kwargs):
        """
        How many people are inside right now, and how the room filled up.

        Counts admission products only. A check-in list with ``all_products``
        happily accepts a T-shirt and pretix will dutifully record the scan, but
        a merch line has no door: counting those would answer "how many things
        were scanned" when the question at the door is "how many people are in
        the room". Everything on the screen is derived from that same
        population, so the figures always add up.

        Entry and exit scans are resolved by pretix itself, so a list that scans
        people back out reports the room rather than the turnstile.

        ``scans`` rides along for the scanner's own counter: what this device
        and every door have scanned for the event, on every list of it. It is
        here rather than behind an endpoint of its own because the door screen
        already asks for this after every scan and every minute, and the two
        figures are read side by side.
        """
        event = request.event
        clist = self._requested_checkin_list(request)
        if clist is None:
            raise ValidationError({"list": [_("Unknown check-in list.")]})

        # Scopes off for the counting, as pretix does for its own check-in
        # figures: the extra organizer filter inside the EXISTS() subquery
        # tricks PostgreSQL into sequentially scanning every event. Every
        # queryset below is already bounded to this list, hence to this event.
        with scopes_disabled():
            admissions = clist.positions.filter(item__admission=True)
            entered = self._with_entry_scan(admissions, clist)
            inside = clist.positions_inside_query().filter(item__admission=True)

            def by_item(qs):
                return {
                    row["item"]: row["cnt"]
                    for row in qs.order_by().values("item").annotate(cnt=Count("id"))
                }

            expected_by_item = by_item(admissions)
            entered_by_item = by_item(entered)
            inside_by_item = by_item(inside)

            items = [
                {
                    "id": item.pk,
                    "name": str(item.name),
                    "inside": inside_by_item.get(item.pk, 0),
                    "entered": entered_by_item.get(item.pk, 0),
                    "expected": expected_by_item.get(item.pk, 0),
                }
                for item in event.items.filter(pk__in=list(expected_by_item)).order_by(
                    "category__position", "category_id", "position", "pk"
                )
            ]

            # Reported rather than hidden: it is the one thing that explains a
            # figure here differing from the count pretix' own back-office shows.
            non_admission = self._with_entry_scan(
                clist.positions.filter(item__admission=False), clist
            ).count()

        expected = sum(expected_by_item.values())
        entered_count = sum(entered_by_item.values())
        inside_count = sum(inside_by_item.values())

        return Response(
            {
                "list": {"id": clist.pk, "name": str(clist.name)},
                "computed_at": now().isoformat(),
                "inside": inside_count,
                # Everyone who was let in at least once, whether or not they
                # have since been scanned back out.
                "entered": entered_count,
                "exited": entered_count - inside_count,
                "expected": expected,
                "not_arrived": expected - entered_count,
                "non_admission_entered": non_admission,
                "items": items,
                # In a series, the date this door's list is kept for, as its
                # own figures are; on a list for every date, tonight's rather
                # than the whole season's.
                "scans": door_scans(
                    event,
                    request.auth if isinstance(request.auth, Device) else None,
                    clist.subevent or evening_subevent(event),
                ),
            }
        )

    # -- helpers -----------------------------------------------------------

    def _requested_checkin_list(self, request):
        """
        The list the app is scanning on, defaulting to the one sales check into.

        Returns ``None`` for an unknown or malformed id rather than falling back
        to another list: a door count is only worth anything if the operator
        knows which door it is counting.
        """
        raw = request.query_params.get("list")
        if not raw:
            return checkin_list_for(request.event)
        try:
            pk = int(raw)
        except (TypeError, ValueError):
            return None
        return request.event.checkin_lists.filter(pk=pk).first()

    def _entry_scans_between(self, clist, rows):
        """
        Which of ``rows`` already carry an entry scan on ``clist``.

        Bounded by primary key rather than by an ``IN`` over the rows: the
        snapshot carries up to twenty thousand of them, and naming each one
        would send a query with twenty thousand bound parameters — well past
        what older SQLite builds accept at all, and a needlessly large plan
        everywhere else. ``rows`` is the first N positions of the list in ``pk``
        order, so every position it contains lies inside that range and none is
        missed.

        The result may name a position outside ``rows``; that is harmless, since
        it is only ever asked whether a given row is in the set.
        """
        if not rows:
            return set()
        return set(
            Checkin.objects.filter(
                list=clist,
                type=Checkin.TYPE_ENTRY,
                position_id__gte=rows[0].pk,
                position_id__lte=rows[-1].pk,
            ).values_list("position_id", flat=True)
        )

    def _with_entry_scan(self, positions, clist):
        """Narrow a position queryset to the ones let in through ``clist``."""
        return positions.annotate(
            checked_in=Exists(
                Checkin.objects.filter(
                    list_id=clist.pk,
                    position=OuterRef("pk"),
                    type=Checkin.TYPE_ENTRY,
                )
            )
        ).filter(checked_in=True)

    def _journal_payload(self, sale, cancelled_seqs=()):
        """One journal line as the till displays it."""
        return {
            "seq": sale.seq,
            "kind": sale.kind,
            "datetime": sale.datetime.isoformat(),
            "order": sale.order_code,
            "total": str(sale.total),
            "payment_type": sale.payment_type,
            "cashier": sale.cashier,
            "testmode": sale.testmode,
            "positions": sale.positions,
            "reason": sale.reason,
            "cancels_seq": sale.cancels_seq,
            "cancelled": sale.seq in cancelled_seqs,
            # What the app may still offer. The real decision is taken again,
            # server-side, when the cancellation is actually asked for.
            "can_cancel": (
                sale.kind == PosSale.KIND_SALE
                and sale.seq not in cancelled_seqs
                and sale.order is not None
                and sale.order.status in (Order.STATUS_PAID, Order.STATUS_PENDING)
            ),
        }

    def _cancellation_payload(self, cancellation, sale, replayed):
        return {
            "cancellation": self._journal_payload(cancellation),
            # The lines of the sale that was reversed, so the till can put them
            # straight back in the basket for the operator to correct.
            "sale": self._journal_payload(sale, {sale.seq}) if sale else None,
            "replayed": replayed,
            "credit_note": None,
            "refunded": False,
        }

    def _record_refund(self, request, order, sale, reason, *, settle_now):
        """
        Record that the money went back out.

        Cancelling an order does not by itself say the customer was paid back —
        pretix would keep showing the payment as taken. The refund is what makes
        the books agree with the drawer.

        ``settle_now`` is whether it can be marked done here. It can when the
        money moves in the same breath as this call: cash out of the till, or a
        card taken on somebody's phone and given back the same way. It cannot
        when a reader is about to be asked, because that call is made after this
        transaction commits and it can be refused. Marking it done first was a
        real hole: a refusal left pretix showing a completed refund while the
        money was still on the customer's card, which is the one state where the
        books and the customer disagree and nothing records which is right.
        """
        payment = order.payments.filter(
            state=OrderPayment.PAYMENT_STATE_CONFIRMED
        ).order_by("-local_id").first()
        if payment is None:
            logger.warning("POS cancellation of %s has no confirmed payment to refund", order.code)
            return None

        refund = order.refunds.create(
            state=OrderRefund.REFUND_STATE_CREATED,
            # Not the buyer's own doing: an operator corrected the till.
            source=OrderRefund.REFUND_SOURCE_ADMIN,
            amount=payment.amount,
            payment=payment,
            provider=payment.provider,
            info_data={
                "journal_seq": sale.seq,
                "device": sale.device_serial,
                "cashier": sale.cashier,
                "reason": reason,
            },
        )
        # What pretix writes itself whenever it creates a refund, in its API
        # and in its own refund dialog alike. Without it, the order's history
        # showed a refund done — or failed — that had never been created, and
        # pretix' own "refund created" webhook never fired for a till's.
        order.log_action(
            "pretix.event.order.refund.created",
            {"local_id": refund.local_id, "provider": refund.provider},
            user=request.user if request.user.is_authenticated else None,
            auth=request.auth,
        )
        if settle_now:
            self._mark_refund_done(request, refund)
        return refund

    @staticmethod
    def _mark_refund_done(request, refund):
        refund.done(
            user=request.user if request.user.is_authenticated else None,
            auth=request.auth,
        )

    def _settle_refund(self, request, refund, outcome):
        """
        Write down what SumUp actually did with the money.

        Called once the card has been asked, outside the transaction. Anything
        other than a refusal means the amount is on its way back and the refund
        stands; a refusal leaves it failed, which is what makes the order page
        say the money was *not* returned. Without this the operator is the only
        record that it was not, and they are at a bar.
        """
        if refund is None or refund.state == OrderRefund.REFUND_STATE_DONE:
            return
        if outcome == "failed":
            refund.state = OrderRefund.REFUND_STATE_FAILED
            refund.save(update_fields=["state"])
            # In pretix' own log, on the order, where somebody reconciling the
            # evening will be looking.
            refund.order.log_action(
                "pretix.event.order.refund.failed",
                {"local_id": refund.local_id, "provider": refund.provider},
                user=request.user if request.user.is_authenticated else None,
                auth=request.auth,
            )
            return
        self._mark_refund_done(request, refund)

    def _credit_note_number(self, order):
        invoice = order.invoices.filter(is_cancellation=True).order_by("-pk").first()
        return invoice.number if invoice else None

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
            "order": {
                "code": sale.order_code,
                "total": total,
                "url": (
                    f"/{sale.event.organizer.slug}/{sale.event.slug}/order/"
                    f"{sale.order_code}/{sale.order.secret}/"
                    if sale.order
                    else None
                ),
            },
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
        """Fire the signals and invoicing that pretix' own order API fires."""
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

        self._ensure_invoice(request, order)

    def _ensure_invoice(self, request, order):
        """
        Generate the invoice this order should have but does not yet.

        Called on the first attempt, and again on a replay: it checks what
        exists before doing anything, so running it twice costs a query, never
        a second invoice.
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
                generate_invoice(order, trigger_pdf=True)
            except Exception as e:
                logger.exception("Could not generate invoice for POS order %s", order.code)
                order.log_action(
                    "pretix.event.order.invoice.failed", data={"exception": str(e)}
                )

    def _check_in(self, request, order, only_missing=False, offline_at=None):
        """
        Walk the customer straight in.

        Deliberately best-effort: the money is already in the drawer, so a
        check-in that fails is reported back to the app for the operator to sort
        out, never a reason to fail the sale.

        With ``only_missing`` — the replay-repair case — positions that already
        have an entry on the list are left alone. The customer may have walked
        to the door and been scanned there in the meantime, and forcing a second
        entry would count one person twice.

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
        if only_missing and positions:
            already = set(
                Checkin.objects.filter(
                    position__in=positions, list=clist, type=Checkin.TYPE_ENTRY
                ).values_list("position_id", flat=True)
            )
            positions = [p for p in positions if p.pk not in already]
        if not positions:
            return 0, []

        checked_in = 0
        errors = []
        for position in positions:
            try:
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
