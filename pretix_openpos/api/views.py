import logging
from datetime import datetime, time
from decimal import Decimal

from django.db import transaction
from django.utils.timezone import make_aware, now
from django.utils.translation import gettext_lazy as _
from i18nfield.strings import LazyI18nString
from pretix.api.serializers.order import OrderCreateSerializer
from pretix.base.models import Checkin, Device, Order, Quota
from pretix.base.models.orders import OrderPayment
from pretix.base.services.checkin import CheckInError, perform_checkin
from pretix.base.services.invoices import generate_invoice, invoice_qualified
from pretix.base.signals import order_paid, order_placed
from rest_framework import status, viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied, ValidationError
from rest_framework.response import Response

from ..channels import POS_CHANNEL, PosSalesChannelType
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
    because a position needs every one of its quotas to have room.
    """
    remaining = None
    for quota in quotas:
        state, available = quota.availability(_cache=cache)
        if state != Quota.AVAILABILITY_OK:
            return 0
        if available is None:
            continue
        remaining = available if remaining is None else min(remaining, available)
    return remaining


def checkin_list_for(event):
    pk = event.settings.get("openpos_checkin_list", as_type=int)
    if not pk:
        return None
    return event.checkin_lists.filter(pk=pk).first()


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
        return Response(
            {
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
                # Quick-tender buttons on the cash keypad.
                "cash_denominations": ["5.00", "10.00", "20.00", "50.00"],
            }
        )

    # -- catalogue ---------------------------------------------------------

    @action(detail=False, methods=["get"], url_path="catalog", url_name="catalog")
    def catalog(self, request, **kwargs):
        event = request.event
        channel = get_pos_channel(event.organizer)
        overrides = pos_price_overrides(event)
        quota_cache = {}

        items = (
            event.items.all()
            .filter_available(channel=channel)
            .select_related("category")
            .prefetch_related("variations", "quotas", "variations__quotas")
            .order_by("category__position", "category_id", "position", "pk")
        )

        categories = {}
        for item in items:
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
            return Response(self._sale_payload(replay, replayed=True), status=status.HTTP_200_OK)

        channel = get_pos_channel(event.organizer)
        overrides = pos_price_overrides(event)
        sellable = {
            item.pk: item
            for item in event.items.all()
            .filter_available(channel=channel)
            .prefetch_related("variations")
        }

        api_positions = []
        journal_positions = []
        total = Decimal("0.00")

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
                if variation is None or not variation.active:
                    raise ValidationError(
                        {"positions": [_("Unknown option for product {name}.").format(name=str(item.name))]}
                    )
            elif variations:
                raise ValidationError(
                    {"positions": [_("Product {name} requires an option to be chosen.").format(name=str(item.name))]}
                )

            price = resolve_price(overrides, item, variation)
            count = line["count"]
            total += price * count

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

            journal_positions.append(
                {
                    "item": item.pk,
                    "item_name": str(item.name),
                    "variation": variation.pk if variation else None,
                    "variation_name": str(variation.value) if variation else None,
                    "count": count,
                    "unit_price": str(price),
                    "line_total": str(price * count),
                }
            )

        expected = data["expected_total"]
        if expected is not None and expected != total:
            # Refuse rather than charge a different amount than the one the
            # customer was told. The app reloads its catalogue and shows the new
            # basket; nothing has been taken at this point.
            raise ValidationError(
                {
                    "expected_total": [
                        _("Prices changed: this basket now comes to {total}, not {expected}.").format(
                            total=total, expected=expected
                        )
                    ],
                    "code": "price_changed",
                    "total": str(total),
                }
            )

        cash_given = data["cash_given"]
        cash_change = None
        if data["payment_type"] == PosSale.PAYMENT_CASH and cash_given is not None:
            if cash_given < total:
                raise ValidationError(
                    {"cash_given": _("The amount received is less than the total due.")}
                )
            cash_change = cash_given - total

        payment_info = {
            "cashier": data["cashier"],
            "device": device.unique_serial if device else "",
            "cash_given": None if cash_given is None else str(cash_given),
            "cash_change": None if cash_change is None else str(cash_change),
        }

        payload = {
            "status": "p",
            "testmode": event.testmode,
            "payment_provider": CASH if data["payment_type"] == PosSale.PAYMENT_CASH else CARD,
            "payment_date": now().isoformat(),
            "payment_info": payment_info,
            "send_email": False,
            "sales_channel": channel.identifier,
            "locale": event.settings.locale,
            "positions": api_positions,
            "fees": [],
        }

        with transaction.atomic():
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
                total=total,
                positions=journal_positions,
                idempotency_key=idempotency_key,
                cash_given=cash_given,
                cash_change=cash_change,
                testmode=event.testmode,
            )

            # Cross-reference the journal entry from the payment so the backend
            # order view can point at it.
            payment = order.payments.last()
            if payment:
                info = payment.info_data or {}
                info["journal_seq"] = sale.seq
                payment.info_data = info
                payment.save(update_fields=["info"])

        # Everything below runs after the sale is durably committed: a failure
        # here must never undo an order the customer has already paid for.
        self._post_commit(request, order)
        checked_in, checkin_errors = self._check_in(request, order)

        body = self._sale_payload(sale, replayed=False)
        body["checked_in"] = checked_in
        body["checkin_errors"] = checkin_errors
        return Response(body, status=status.HTTP_201_CREATED)

    # -- takings -----------------------------------------------------------

    @action(detail=False, methods=["get"], url_path="summary", url_name="summary")
    def summary(self, request, **kwargs):
        """
        Running total for the current day, for the calling till and overall.

        This is the lightweight alternative to a full cash session: no opening
        float, no blind count, just what has gone through since midnight so a
        volunteer can reconcile the drawer at the end of the night.
        """
        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None

        start_of_day = make_aware(
            datetime.combine(now().astimezone(event.timezone).date(), time.min),
            event.timezone,
        )
        sales = PosSale.objects.filter(event=event, datetime__gte=start_of_day)

        def totals(qs):
            result = {"count": qs.count(), "cash": "0.00", "card": "0.00", "total": "0.00"}
            grand = Decimal("0.00")
            for payment_type in (PosSale.PAYMENT_CASH, PosSale.PAYMENT_CARD):
                amount = sum(
                    (s.total for s in qs.filter(payment_type=payment_type)), Decimal("0.00")
                )
                result[payment_type] = str(amount)
                grand += amount
            result["total"] = str(grand)
            return result

        # Test-mode money never existed, so it must not be in the figure a
        # volunteer reconciles the drawer against. It stays in the journal —
        # which is append-only and survives the orders being purged — and is
        # reported separately rather than silently dropped.
        real = sales.filter(testmode=False)
        test = sales.filter(testmode=True)

        return Response(
            {
                "since": start_of_day.isoformat(),
                "device": totals(real.filter(device=device)) if device else None,
                "event": totals(real),
                "testmode": totals(test) if test.exists() else None,
            }
        )

    # -- helpers -----------------------------------------------------------

    def _sale_payload(self, sale, replayed):
        return {
            "order": {
                "code": sale.order_code,
                "total": str(sale.total),
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

        settings = request.event.settings
        wants_invoice = invoice_qualified(order) and (
            settings.get("invoice_generate") == "True"
            or (
                settings.get("invoice_generate") == "paid"
                and order.status == Order.STATUS_PAID
            )
        )
        if wants_invoice and not order.invoices.last():
            try:
                generate_invoice(order, trigger_pdf=True)
            except Exception as e:
                logger.exception("Could not generate invoice for POS order %s", order.code)
                order.log_action(
                    "pretix.event.order.invoice.failed", data={"exception": str(e)}
                )

    def _check_in(self, request, order):
        """
        Walk the customer straight in.

        Deliberately best-effort: the money is already in the drawer, so a
        check-in that fails is reported back to the app for the operator to sort
        out, never a reason to fail the sale.
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
