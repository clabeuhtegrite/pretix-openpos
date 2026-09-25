"""
The two viewsets the till talks to.

:class:`OpenPosOrganizerViewSet` answers before an event is chosen, and
:class:`OpenPosViewSet` everything after it. The latter is assembled from the
actions of the modules beside this one — the card reader, the checkout,
cancellation, the cash drawer and the door — and keeps the configuration, the
catalogue and the takings here.
"""
from datetime import timezone as dt_timezone

from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Device
from rest_framework import viewsets
from rest_framework.decorators import action
from rest_framework.exceptions import PermissionDenied
from rest_framework.response import Response

from .. import __version__
from ..drawers import is_stale, open_session_of
from ..models import PosCategory, PosDevice, PosSale
from .cancellation import CancelActions
from .catalog import (
    checkin_list_for, custom_sale_item, deposit_item, for_date, get_pos_channel, quota_availability, resolve_price,
)
from .contact import note_contact, plugin_enabled, reachable_events, utc_timestamp
from .door import DoorActions
from .drawer_api import DrawerActions
from .evenings import evening_subevent, selling_subevent, start_of_business_day
from .sales import CheckoutActions
from .terminal import TerminalActions, card_mode
from .throttling import DeviceThrottleMixin


class OpenPosOrganizerViewSet(DeviceThrottleMixin, viewsets.ViewSet):
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

    def initial(self, request, *args, **kwargs):
        super().initial(request, *args, **kwargs)
        note_contact(request)

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

    @action(detail=False, methods=["post"], url_path="status", url_name="status")
    def device_status(self, request, **kwargs):
        """
        A till's own account of the sales it holds and has not sent yet.

        The server can count every sale that reached it and none that did not,
        and the ones that did not are exactly what an organizer needs to know
        about before counting a drawer: the amount the drawer should hold is
        computed from the journal, and a cash sale still queued on a tablet is
        not in it. So the app says so itself, and the back office shows it —
        as the app's word, with the time it was given.

        Organizer-level, like the device: a till holds sales for whichever
        events it sold for, and the report is about the tablet, not about one
        of them. A device only; nothing else has a queue.

        Answers with the server's clock, so the app can tell whether its own
        is wrong — the times it reports, and the ones it stamps its offline
        sales with, are read on that clock.
        """
        device = request.auth
        if not isinstance(device, Device):
            raise PermissionDenied(_("Only a paired device can report its status."))
        from .serializers import DeviceStatusSerializer

        serializer = DeviceStatusSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        reported = now()
        PosDevice.objects.update_or_create(
            device_id=device.pk,
            defaults={
                "status_reported_at": reported,
                "pending_sales": data["pending_sales"],
                # Nothing waiting has no oldest: a leftover time from an app
                # that did not clear it would read as a sale lost since then.
                "oldest_pending_at": data["oldest_pending_at"] if data["pending_sales"] else None,
                "last_sync_at": data["last_sync_at"],
                "app_version": data["version"],
                # A report is a contact, whatever the once-a-minute throttle
                # in note_contact decided.
                "last_seen_at": reported,
            },
        )
        return Response({"server_time": utc_timestamp(reported)})


class OpenPosViewSet(
    TerminalActions, CheckoutActions, CancelActions, DrawerActions, DoorActions,
    DeviceThrottleMixin, viewsets.ViewSet,
):
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
        note_contact(request)
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
        drawer = pos_device.drawer
        drawer_session = open_session_of(drawer)
        return Response(
            {
                # The plugin's version, which is also the version the bundle is
                # built with. A till that stays open across a deploy — a whole
                # festival weekend, routinely — compares this against its own
                # build on the idle refresh and offers a reload.
                "version": __version__,
                # The server's clock, in UTC, for the till to compare its own
                # with. A tablet whose clock is off dates every sale it queues
                # offline by it; the checkout corrects that on replay (see
                # ``offline.sent_at``), and this is how the till can say so to
                # whoever is holding it before it matters.
                "server_time": now().astimezone(dt_timezone.utc).isoformat(
                    timespec="milliseconds"
                ),
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
                # The cash drawer this device's cash goes into, and whether it
                # is open. Absent for a device with none, which takes cash the
                # way it always has. The app reads it to say, before anybody
                # taps a payment, that the drawer has to be opened first; the
                # checkout refuses cash into a closed drawer all the same.
                "drawer": None if drawer is None else {
                    "id": drawer.pk,
                    "name": drawer.name,
                    "open": drawer_session is not None,
                    "stale": drawer_session is not None and is_stale(drawer_session, event),
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
        What a drawer should hold is worked out by :mod:`..drawers`, and shown
        in the till's drawer panel, not here. This is the
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
