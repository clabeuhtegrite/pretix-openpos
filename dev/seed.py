"""
Seed a demo organizer, event and till for local development.

    docker compose exec pretix python -m pretix shell < dev/seed.py

Idempotent: running it twice leaves you with the same demo data.
"""
import datetime
from decimal import Decimal

from django.utils.timezone import now
from django_scopes import scopes_disabled
from pretix.base.models import (
    CheckinList, Device, Event, Item, ItemCategory, ItemVariation, Organizer,
    Quota, Team, User,
)

ORG_SLUG = "demo"
EVENT_SLUG = "festival"

with scopes_disabled():
    organizer, _ = Organizer.objects.get_or_create(
        slug=ORG_SLUG, defaults={"name": "Demo Organizer"}
    )
    # Makes sure the openpos channel exists even for organizers that predate the
    # plugin being installed.
    organizer.create_default_sales_channels()

    event, created = Event.objects.get_or_create(
        organizer=organizer,
        slug=EVENT_SLUG,
        defaults={
            "name": "Festival Demo",
            "date_from": now() + datetime.timedelta(days=30),
            "currency": "EUR",
            "live": True,
            "plugins": "pretix_openpos",
        },
    )
    if "pretix_openpos" not in (event.plugins or ""):
        event.plugins = ",".join(filter(None, [event.plugins, "pretix_openpos"]))
        event.save(update_fields=["plugins"])
    event.settings.set("timezone", "Europe/Paris")
    # Deliberately left as an ordinary event would be — invoices by hand, web
    # channel only. Till sales are invoiced anyway, by the plugin, and the smoke
    # test proves it from here rather than from a fixture that helped it along.

    pos_channel = organizer.sales_channels.get(identifier="openpos")
    web_channel = organizer.sales_channels.get(identifier="web")

    # Give every staff user access to the demo event.
    team, _ = Team.objects.get_or_create(
        organizer=organizer,
        name="Demo team",
        defaults={
            "all_events": True,
            "all_event_permissions": True,
            "all_organizer_permissions": True,
        },
    )
    for user in User.objects.filter(is_staff=True):
        team.members.add(user)

    tickets, _ = ItemCategory.objects.get_or_create(
        event=event, name="Billetterie", defaults={"position": 0}
    )
    bar, _ = ItemCategory.objects.get_or_create(
        event=event, name="Bar", defaults={"position": 1}
    )
    merch, _ = ItemCategory.objects.get_or_create(
        event=event, name="Merch", defaults={"position": 2}
    )

    def make_item(category, name, price, admission=False, all_channels=True, pos_only=False):
        item, was_created = Item.objects.get_or_create(
            event=event,
            name=name,
            defaults={
                "category": category,
                "default_price": Decimal(price),
                "admission": admission,
                "active": True,
                "all_sales_channels": all_channels and not pos_only,
            },
        )
        if pos_only:
            item.all_sales_channels = False
            item.save(update_fields=["all_sales_channels"])
            item.limit_sales_channels.set([pos_channel])
        elif not all_channels:
            item.all_sales_channels = False
            item.save(update_fields=["all_sales_channels"])
            item.limit_sales_channels.set([web_channel, pos_channel])
        return item

    full = make_item(tickets, "Plein tarif", "12.00", admission=True)
    reduced = make_item(tickets, "Tarif réduit", "8.00", admission=True)
    # Only sellable at the door: exactly the case a POS-specific channel is for.
    door = make_item(tickets, "Entrée sur place", "15.00", admission=True, pos_only=True)

    beer = make_item(bar, "Bière", "3.00")
    soft = make_item(bar, "Soft", "2.00")

    tshirt = make_item(merch, "T-shirt", "18.00")
    for size in ("S", "M", "L"):
        ItemVariation.objects.get_or_create(
            item=tshirt, value=size, defaults={"active": True}
        )

    quota, _ = Quota.objects.get_or_create(
        event=event, name="Général", defaults={"size": 500}
    )
    quota.items.set([full, reduced, door, beer, soft, tshirt])
    quota.variations.set(list(tshirt.variations.all()))

    # On-site tariff: pricier at the door than in advance, which is the whole
    # reason the plugin carries its own price table.
    from pretix_openpos.models import PosPrice

    PosPrice.objects.update_or_create(
        event=event, item=full, variation=None, defaults={"price": Decimal("14.00")}
    )
    PosPrice.objects.update_or_create(
        event=event, item=reduced, variation=None, defaults={"price": Decimal("10.00")}
    )

    checkin_list, _ = CheckinList.objects.get_or_create(
        event=event, name="Entrée", defaults={"all_products": True}
    )
    event.settings.set("openpos_checkin_list", str(checkin_list.pk))

    device, device_created = Device.objects.get_or_create(
        organizer=organizer,
        name="Caisse 1",
        defaults={"all_events": True, "security_profile": "openpos"},
    )
    if not device_created:
        device.security_profile = "openpos"
        device.all_events = True
        device.save(update_fields=["security_profile", "all_events"])

    print("=" * 60)
    print(f"organizer          : {organizer.slug}")
    print(f"event              : {event.slug}  ({event.name})")
    print(f"checkin list       : {checkin_list.pk} ({checkin_list.name})")
    print(f"device             : {device.name}")
    print(f"device initialized : {bool(device.api_token)}")
    print(f"init token         : {device.initialization_token}")
    print("=" * 60)
