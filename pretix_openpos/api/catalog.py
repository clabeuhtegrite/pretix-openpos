"""
What a till may sell, and at what price.

The Open POS sales channel, pretix' own price and quota resolution for the date
being sold, the products and the check-in list an organiser named in the till's
settings, and :func:`resolve_line`, the one place a basket line is priced and
refused — shared by the catalogue, the card reader and the checkout.
"""
from decimal import Decimal

from django.db.models import Q
from django.utils.translation import gettext_lazy as _
from i18nfield.strings import LazyI18nString
from pretix.base.models import Quota
from rest_framework.exceptions import ValidationError

from ..channels import POS_CHANNEL, PosSalesChannelType


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
    off_limits=frozenset(), pinned=False,
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

    ``pinned`` says the basket was priced by this server, when the card reader
    was asked for the money: the lines are its own, read back. A settled line
    that is *not* pinned is a till's word — a sale it rang up with no network —
    and that word is bounded to what a till could genuinely have produced: a
    product it could have shown (see :func:`sellable_items`), nothing below
    zero but a deposit handed back, a reason only on the free-amount product.
    Everything else it is taken at, and anything off the tariff is reported.
    """
    item = sellable.get(line["item"])
    if item is None:
        raise ValidationError(
            {
                "positions": [
                    _("Product {id} is not on sale at the till.").format(id=line["item"])
                ],
                "code": "item_not_sold",
            }
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
    replayed = settled and not pinned
    if replayed and not is_refund and sent_price is not None and sent_price < Decimal("0.00"):
        # Only a deposit handed back takes money out of the drawer, and it
        # says so with its own flag. A product line below zero is a till
        # inventing a refund, which no screen of the app can produce.
        raise ValidationError(
            {
                "positions": [
                    _("{name} cannot be sold for less than nothing.").format(
                        name=str(item.name)
                    )
                ],
                "code": "negative_price",
            }
        )
    if is_refund:
        # A deposit handed back is worth exactly what the deposit costs,
        # negated here rather than sent: the till names the product, the server
        # prices it, as everywhere else.
        tariff = -tariff
        if not settled and (deposit is None or item.pk != deposit.pk):
            raise ValidationError(
                {"positions": [_("This product is not the one deposits are taken on.")]}
            )
    elif description:
        free_amount = custom_item is not None and item.pk == custom_item.pk
        # A reason is what marks a free amount, and the free-amount product is
        # the one place a till decides a price. On any other line it used to
        # be a way to charge anything and have it pass unreported — so it is
        # refused, from a replayed queue as well as live. Only a basket the
        # reader was paid for keeps it, since that one was checked when the
        # amount went on the reader; it is then reported like any other line
        # whose price is not the tariff, below.
        if not free_amount and not pinned:
            raise ValidationError(
                {
                    "positions": [
                        _("Free amounts can only be sold on the product set aside for them.")
                    ],
                    "code": "free_amount_elsewhere",
                }
            )
        if not settled and (sent_price is None or sent_price <= Decimal("0.00")):
            raise ValidationError(
                {"positions": [_("A free amount has to be more than nothing.")]}
            )
        if free_amount:
            # The one price the till decides. It is not compared with the
            # tariff and never reported as off-tariff: the product's own price
            # is a placeholder that no free-amount sale is charged at.
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


def refuse_oversized(positions):
    """
    Refuse a basket of more than MAX_ITEMS items, all lines together.

    Raised from the view rather than from the serializer, where the ``code``
    would come back wrapped in a list. Live and replayed sales alike: a till
    whose queue holds a sale this size recorded it wrongly, and a queued sale
    refused goes to the list of refusals the operator is shown, with this
    sentence — it is not lost. A basket the card reader has already been paid
    for is never asked: it was capped by ``terminal/start`` before any card
    came near it.
    """
    from .serializers import MAX_ITEMS

    if sum(line["count"] for line in positions) > MAX_ITEMS:
        raise ValidationError(
            {
                "positions": [
                    _("A sale can hold at most {max} items. Split it into several sales.").format(
                        max=MAX_ITEMS
                    )
                ],
                "code": "too_many_items",
            }
        )


def sellable_items(event, channel, *, settled, pinned=False):
    """
    What may be sold — and, for a sale already paid for, what may be recorded.

    An online sale is refused unless the product is on the till's channel right
    now: nothing has been taken, so refusing costs a tap. A sale that has
    already been paid for is a different question — the catalogue may well have
    moved since, and refusing then does not undo the sale.

    Moved, but not beyond what a till could ever have offered. A sale replayed
    from a till that was cut off is the till's word, and a till only ever sells
    from the grid it was served: products on the Open POS channel, that pretix
    would show without a voucher, sold on their own. Whether one of them is
    still switched on, or still within its sale period, is exactly what may
    have changed since the evening, and is not asked. Anything outside that
    set is something no till could have rung up — a tablet that only claims to
    have been offline — and is refused. A basket the card reader has been paid
    for (``pinned``) was priced here, from this very list, when the reader was
    asked; it is recorded whatever has happened to the catalogue since.
    """
    items = event.items.all()
    if not settled:
        items = items.filter_available(channel=channel)
    elif not pinned:
        # pretix' own filter_available, less the conditions that change in
        # the course of an evening: switched on, available from, available
        # until. What is left describes the product rather than the moment.
        items = items.filter(
            Q(all_sales_channels=True) | Q(limit_sales_channels=channel),
            Q(category__isnull=True) | Q(category__is_addon=False),
            Q(category__isnull=True) | ~Q(category__cross_selling_mode="only"),
            require_bundling=False,
            hide_without_voucher=False,
        )
    # The category rides along because every line is now asked which one it is
    # in, and naming it in a refusal is the difference between "this till does
    # not sell Bar" and a product id.
    return {
        item.pk: item
        for item in items.select_related("category").prefetch_related("variations")
    }
