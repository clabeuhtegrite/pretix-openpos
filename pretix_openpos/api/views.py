import logging
from datetime import datetime, time, timedelta
from decimal import Decimal

from django.db import transaction
from django.db.models import Count, Exists, OuterRef, Sum
from django.utils.timezone import make_aware, now
from django.utils.translation import gettext_lazy as _
from django_scopes import scopes_disabled
from i18nfield.strings import LazyI18nString
from pretix.api.serializers.order import OrderCreateSerializer
from pretix.base.models import Checkin, Device, Order, Quota
from pretix.base.models.orders import OrderPayment, OrderRefund
from pretix.base.services.checkin import CheckInError, perform_checkin
from pretix.base.services.invoices import generate_invoice, invoice_qualified
from pretix.base.services.orders import OrderError, cancel_order
from pretix.base.signals import order_paid, order_placed
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from .. import __version__
from ..channels import POS_CHANNEL, PosSalesChannelType
from ..invoicing import pos_invoices_enabled
from ..models import PosPrice, PosSale
from ..payment import CARD, CASH

logger = logging.getLogger(__name__)


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


def pos_price_overrides(event):
    """Map of ``(item_id, variation_id)`` to the on-site price."""
    return {
        (p.item_id, p.variation_id): p.price
        for p in PosPrice.objects.filter(event=event)
    }


def resolve_price(overrides, item, variation=None) -> Decimal:
    """
    On-site price for a product, falling back to the webshop price.

    Mirrors pretix' own resolution order (variation price, then item price) and
    layers the till tariff on top of it.
    """
    if variation is not None:
        if (item.pk, variation.pk) in overrides:
            return overrides[(item.pk, variation.pk)]
        if variation.default_price is not None:
            return variation.default_price
        return item.default_price
    if (item.pk, None) in overrides:
        return overrides[(item.pk, None)]
    return item.default_price


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


def start_of_business_day(event):
    """The moment the takings count from: 6 am on the day the current night began."""
    local = now().astimezone(event.timezone)
    day = local.date()
    if local.time() < BUSINESS_DAY_STARTS_AT:
        day -= timedelta(days=1)
    return make_aware(datetime.combine(day, BUSINESS_DAY_STARTS_AT), event.timezone)


def checkin_list_for(event):
    pk = event.settings.get("openpos_checkin_list", as_type=int)
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
    pk = event.settings.get(setting, as_type=int)
    if not pk:
        return None
    return event.items.filter(pk=pk).first()


def custom_sale_item(event):
    """The product every free-amount sale is booked against, if enabled."""
    return configured_item(event, "openpos_custom_item")


def deposit_item(event):
    """The product a cup deposit is sold as, if enabled."""
    return configured_item(event, "openpos_deposit_item")


def refund_key(idempotency_key: str) -> str:
    """
    The key of the payout row that goes with a sale.

    One customer can produce two journal rows — the sale, and the deposit
    handed back with it — and the journal's idempotency is per row. Derived
    rather than sent, so a retry of the whole transaction still recognises both
    halves of what it already committed.
    """
    return f"{idempotency_key}:refund"


def plugin_enabled(event) -> bool:
    return "pretix_openpos" in event.get_plugins()


class OpenPosOrganizerViewSet(viewsets.ViewSet):
    """
    Organizer-level endpoint, so a till can find out which events it may sell for.

    Needed because the device token grants access to events, not to the POS:
    an organizer can perfectly well run Open POS on one event and not another.
    Listing them server-side keeps the app from offering an event whose
    endpoints would then refuse it.
    """

    def list(self, request, **kwargs):
        device = request.auth if isinstance(request.auth, Device) else None
        if device is not None:
            events = device.get_events_with_any_permission()
        else:
            events = request.organizer.events.all()

        results = []
        for event in events.filter(live=True).order_by("date_from"):
            if not plugin_enabled(event):
                continue
            results.append(
                {
                    "slug": event.slug,
                    "organizer": event.organizer.slug,
                    "name": str(event.name),
                    "currency": event.currency,
                    "testmode": event.testmode,
                    "date_from": event.date_from.isoformat() if event.date_from else None,
                }
            )
        return Response({"results": results})


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
        clist = checkin_list_for(event)
        custom = custom_sale_item(event)
        deposit = deposit_item(event)
        # Only when there is something to price: the tariff is one query, and
        # most events run neither button.
        deposit_price = (
            resolve_price(pos_price_overrides(event), deposit) if deposit else None
        )
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
        channel = get_pos_channel(event.organizer)
        overrides = pos_price_overrides(event)
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
                            "price": str(resolve_price(overrides, item, variation)),
                            "available": quota_availability(
                                variation.quotas.all(), quota_cache
                            ),
                        }
                    )
                if not entry["variations"]:
                    continue
            else:
                entry["price"] = str(resolve_price(overrides, item))
                entry["available"] = quota_availability(item.quotas.all(), quota_cache)

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
                    request, replay.order, only_missing=True
                )
                body["checked_in"] = checked_in
                body["checkin_errors"] = checkin_errors
            return Response(body, status=status.HTTP_200_OK)

        channel = get_pos_channel(event.organizer)
        overrides = pos_price_overrides(event)
        offline = data.get("offline")
        custom_item = custom_sale_item(event)
        deposit = deposit_item(event)

        # What may be sold — and, for a replay, what may be *recorded*, which is
        # not the same question.
        #
        # An online sale is refused unless the product is on the till's channel
        # right now: nothing has been taken, so refusing costs a tap. A sale
        # replayed from a till that was cut off has already been paid for and
        # the ticket is in somebody's hand; the catalogue may well have moved in
        # the meantime — the product pulled from the channel at the end of the
        # evening, an option deactivated. Refusing then does not undo the sale,
        # it strands it in a browser, outside pretix and outside the journal.
        # So a replay is resolved against everything the event still knows.
        items = event.items.all()
        if not offline:
            items = items.filter_available(channel=channel)
        sellable = {item.pk: item for item in items.prefetch_related("variations")}

        api_positions = []
        journal_positions = []
        refund_positions = []
        #: What the pretix order is worth: everything but the deposits handed back.
        sale_total = Decimal("0.00")
        #: Negative, and outside any order — see PosSale.KIND_DEPOSIT_REFUND.
        refund_total = Decimal("0.00")
        off_tariff = []
        #: Free-amount reasons, for the order's comment in the back office.
        notes = []

        for line in data["positions"]:
            item = sellable.get(line["item"])
            if item is None:
                raise ValidationError(
                    {"positions": [_("Product {id} is not on sale at the till.").format(id=line["item"])]}
                )

            variations = list(item.variations.all())
            variation = None
            if line["variation"] is not None:
                variation = next((v for v in variations if v.pk == line["variation"]), None)
                # Same reasoning as the catalogue above: an option that has been
                # switched off since the sale was rung up is still the option the
                # customer paid for.
                if variation is None or (not variation.active and not offline):
                    raise ValidationError(
                        {"positions": [_("Unknown option for product {name}.").format(name=str(item.name))]}
                    )
            elif variations:
                raise ValidationError(
                    {"positions": [_("Product {name} requires an option to be chosen.").format(name=str(item.name))]}
                )

            description = line["description"].strip()
            is_refund = line["refund"]

            # The tariff, and then the three ways a line can end up costing
            # something else. Everything below still resolves the tariff first,
            # because it is what an offline replay is compared against.
            tariff = resolve_price(overrides, item, variation)
            if is_refund:
                # A deposit handed back is worth exactly what the deposit
                # costs, negated here rather than sent: the till names the
                # product, the server prices it, as everywhere else.
                tariff = -tariff
                if not offline and (deposit is None or item.pk != deposit.pk):
                    # Not the product the organiser set aside for this. Refused
                    # online, where nothing has been taken yet; a replay from a
                    # till that was cut off is past arguing about — see below.
                    raise ValidationError(
                        {"positions": [_("This product is not the one deposits are taken on.")]}
                    )
            elif description and not offline:
                if custom_item is None or item.pk != custom_item.pk:
                    raise ValidationError(
                        {"positions": [_("Free amounts can only be sold on the product set aside for them.")]}
                    )
                if line["price"] <= Decimal("0.00"):
                    raise ValidationError(
                        {"positions": [_("A free amount has to be more than nothing.")]}
                    )
                # The one price the till decides. It is not compared with the
                # tariff and never reported as off-tariff: the product's own
                # price is a placeholder that no free-amount sale is charged at.
                tariff = line["price"]

            # A sale rung up offline was priced by the app from the tariff it had
            # cached, and the customer has already paid that. The order is
            # therefore created at what was charged — anything else would print
            # an invoice for a sum nobody handed over — and the divergence is
            # reported rather than smoothed away. A free amount offline is the
            # same story with no tariff to diverge from, so it is left out of
            # the comparison.
            price = line["price"] if offline else tariff
            if offline and price != tariff and not description:
                off_tariff.append(
                    {
                        "item": item.pk,
                        "item_name": str(item.name),
                        "charged": str(price),
                        "tariff": str(tariff),
                    }
                )
            count = line["count"]

            journal_line = {
                "item": item.pk,
                "item_name": str(item.name),
                "variation": variation.pk if variation else None,
                "variation_name": str(variation.value) if variation else None,
                "count": count,
                "unit_price": str(price),
                "line_total": str(price * count),
            }
            if description:
                # What the money was actually for. In the journal because that
                # is the record that outlives the order, and on the order too,
                # a few lines further down.
                journal_line["description"] = description
                notes.append(f"{count}× {item.name} — {description}")
            if offline and price != tariff and not description:
                # Kept on the line itself, so the divergence survives in the
                # journal even after the tariff has been edited again.
                journal_line["tariff_price"] = str(tariff)

            if is_refund:
                refund_total += price * count
                refund_positions.append(journal_line)
                # Deliberately no order position: this is money leaving the
                # drawer, and pretix has nowhere to put it.
                continue

            sale_total += price * count
            journal_positions.append(journal_line)
            for _n in range(count):
                api_positions.append(
                    {
                        "item": item.pk,
                        "variation": variation.pk if variation else None,
                        "price": str(price),
                        "attendee_name_parts": {},
                        "answers": [],
                    }
                )

        # What actually changes hands: the order, less the deposits given back
        # with it. Every figure the customer is quoted is this one.
        net_total = sale_total + refund_total

        expected = data["expected_total"]
        if expected is not None and expected != net_total:
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
            "force": bool(offline),
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
            "fees": [],
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
            checked_in, checkin_errors = self._check_in(request, order)

        body = self._checkout_payload(event, sale or refund, replayed=False)
        body["checked_in"] = checked_in
        body["checkin_errors"] = checkin_errors
        # Empty on every online sale. When it is not, an operator has to be told:
        # a price moved while the till could not hear about it.
        body["off_tariff"] = off_tariff
        return Response(body, status=status.HTTP_201_CREATED)

    # -- offline snapshot ---------------------------------------------------

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
                clist.positions.only("secret", "item_id", "attendee_name_cached")
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
            return Response(
                self._cancellation_payload(replay, original, replayed=True),
                status=status.HTTP_200_OK,
            )

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
            refund = self._record_refund(request, order, sale, data["reason"])

            cancellation = PosSale.record(
                event=event,
                order=order,
                device=device,
                cashier=data["cashier"],
                payment_type=sale.payment_type,
                # Negative, so the takings stay the plain sum of the column and
                # the drawer reconciles against the journal without arithmetic.
                total=-sale.total,
                positions=self._reversed_positions(sale.positions),
                idempotency_key=data["idempotency_key"],
                testmode=sale.testmode,
                kind=PosSale.KIND_CANCELLATION,
                cancels_seq=sale.seq,
                reason=data["reason"],
            )

        body = self._cancellation_payload(cancellation, sale, replayed=False)
        body["credit_note"] = self._credit_note_number(order)
        body["refunded"] = refund is not None
        return Response(body, status=status.HTTP_201_CREATED)

    # -- takings -----------------------------------------------------------

    @action(detail=False, methods=["get"], url_path="summary", url_name="summary")
    def summary(self, request, **kwargs):
        """
        Running total for the current till day, for the calling till and overall.

        This is the lightweight alternative to a full cash session: no opening
        float, no blind count, just what has gone through since the day began —
        at six in the morning, so a night that crosses midnight stays one figure
        — for a volunteer to reconcile the drawer at the end of it.
        """
        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None

        since = start_of_business_day(event)
        sales = PosSale.objects.filter(event=event, datetime__gte=since)

        def totals(qs):
            # Two aggregate queries per bucket, instead of fetching every row
            # of the night to add it up in Python.
            kinds = {
                row["kind"]: row["n"]
                for row in qs.order_by().values("kind").annotate(n=Count("pk"))
            }
            amounts = {
                # Quantized because SQLite hands Sum() back with the trailing
                # zeros gone — "50" where PostgreSQL says "50.00" — and this
                # string is API surface.
                row["payment_type"]: (row["amount"] or Decimal("0.00")).quantize(Decimal("0.01"))
                for row in qs.order_by().values("payment_type").annotate(amount=Sum("total"))
            }
            result = {
                # Sales, not journal lines: a cancellation is not a sale, and
                # counting it as one would say six when four customers were
                # served. Its money is another matter — see below.
                "count": kinds.get(PosSale.KIND_SALE, 0),
                "cancellations": kinds.get(PosSale.KIND_CANCELLATION, 0),
                # Same reasoning: a returned cup is not a sale, and the money
                # it took out of the drawer is already netted off below.
                "deposit_refunds": kinds.get(PosSale.KIND_DEPOSIT_REFUND, 0),
            }
            grand = Decimal("0.00")
            for payment_type in (PosSale.PAYMENT_CASH, PosSale.PAYMENT_CARD):
                # Cancellations and deposit refunds carry a negative total, so
                # the amounts net out here on their own: this is what the
                # drawer should hold.
                amount = amounts.get(payment_type, Decimal("0.00"))
                result[payment_type] = str(amount)
                grand += amount
            result["total"] = str(grand)
            return result

        # Test-mode money never existed, so it must not be in the figure a
        # volunteer reconciles the drawer against. It stays in the journal —
        # which is append-only and survives the orders being purged — and is
        # reported separately rather than silently dropped.
        real = sales.filter(testmode=False)
        # Computed rather than probed with a prior exists(): totals() already
        # counts the rows per kind, so the emptiness is in the answer it hands
        # back and a second round trip to ask about it buys nothing.
        test = totals(sales.filter(testmode=True))
        had_test = bool(
            test["count"] or test["cancellations"] or test["deposit_refunds"]
        )

        return Response(
            {
                "since": since.isoformat(),
                "device": totals(real.filter(device=device)) if device else None,
                "event": totals(real),
                "testmode": test if had_test else None,
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

    def _reversed_positions(self, positions):
        """The sold lines, negated, so the journal reads as a credit note."""
        reversed_lines = []
        for line in positions:
            entry = dict(line)
            for field in ("count", "line_total"):
                value = entry.get(field)
                if value is None:
                    continue
                entry[field] = -value if isinstance(value, int) else str(-Decimal(str(value)))
            reversed_lines.append(entry)
        return reversed_lines

    def _record_refund(self, request, order, sale, reason):
        """
        Record that the money went back out.

        Cancelling an order does not by itself say the customer was paid back —
        pretix would keep showing the payment as taken. The refund is what makes
        the books agree with the drawer. It is marked done immediately because
        it is: cash out of the till, or an operator who has just refunded on the
        card terminal standing in front of the customer.
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
        refund.done(
            user=request.user if request.user.is_authenticated else None,
            auth=request.auth,
        )
        return refund

    def _credit_note_number(self, order):
        invoice = order.invoices.filter(is_cancellation=True).order_by("-pk").first()
        return invoice.number if invoice else None

    def _sale_payload(self, sale, replayed):
        # A deposit refund is a journal row with no order behind it. Its own
        # total is money going out, so reporting it as an order total would
        # have the till announce a sale worth minus three euros; the figures
        # that describe the transaction are added by _checkout_payload.
        orderless = sale.kind == PosSale.KIND_DEPOSIT_REFUND
        return {
            "order": {
                "code": sale.order_code,
                "total": "0.00" if orderless else str(sale.total),
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

    def _check_in(self, request, order, only_missing=False):
        """
        Walk the customer straight in.

        Deliberately best-effort: the money is already in the drawer, so a
        check-in that fails is reported back to the app for the operator to sort
        out, never a reason to fail the sale.

        With ``only_missing`` — the replay-repair case — positions that already
        have an entry on the list are left alone. The customer may have walked
        to the door and been scanned there in the meantime, and forcing a second
        entry would count one person twice.
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
                perform_checkin(
                    op=position,
                    clist=clist,
                    given_answers={},
                    # The customer is standing right here having just paid; a
                    # mandatory question must not hold up the door.
                    force=True,
                    questions_supported=False,
                    auth=request.auth,
                    user=request.user if request.user.is_authenticated else None,
                    type=Checkin.TYPE_ENTRY,
                )
                checked_in += 1
            except CheckInError as e:
                errors.append(str(e))
            except Exception as e:
                logger.exception("Unexpected error checking in POS order %s", order.code)
                errors.append(str(e))
        return checked_in, errors
