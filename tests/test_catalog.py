"""
What the till is told it may sell, and what it is told about the event.

The catalogue is the one thing the app caches and goes on selling from when the
network is gone, so what it contains — and what it deliberately does not — is
part of the contract.
"""
from decimal import Decimal

import pytest
from pretix.base.models import Item, Quota

from pretix_openpos.models import PosPrice


def catalogue(till):
    body = till.get("catalog").json()
    return {
        item["name"]: item
        for category in body["categories"]
        for item in category["items"]
    }


@pytest.mark.django_db
def test_a_product_kept_off_the_till_is_not_offered(till, event, ticket, organizer):
    webshop = organizer.sales_channels.get(identifier="web")
    online_only = Item.objects.create(
        event=event, name="Adhésion en ligne", default_price=20, all_sales_channels=False
    )
    online_only.limit_sales_channels.add(webshop)

    names = catalogue(till)

    assert "Entrée" in names
    # The native pretix way of separating the on-site catalogue from the webshop.
    assert "Adhésion en ligne" not in names


@pytest.mark.django_db
def test_a_product_on_every_channel_is_on_sale_at_the_till_too(till, event):
    # pretix' own default, and worth pinning because it is what an organiser
    # meets first: a product is on sale everywhere until it is limited, so the
    # till offers it without anything having to be ticked.
    Item.objects.create(event=event, name="Café", default_price=1)

    assert "Café" in catalogue(till)


@pytest.mark.django_db
def test_a_product_can_exist_only_on_site(till, event, channel):
    only_here = Item.objects.create(
        event=event, name="Consigne", default_price=1, all_sales_channels=False
    )
    only_here.limit_sales_channels.add(channel)

    assert "Consigne" in catalogue(till)


@pytest.mark.django_db
def test_the_price_shown_is_the_on_site_tariff(till, event, ticket):
    PosPrice.objects.create(event=event, item=ticket, price=Decimal("8.00"))

    assert catalogue(till)["Entrée"]["price"] == "8.00"


@pytest.mark.django_db
def test_an_inactive_product_is_not_offered(till, ticket):
    ticket.active = False
    ticket.save()

    assert "Entrée" not in catalogue(till)


@pytest.mark.django_db
def test_a_product_with_options_carries_no_price_of_its_own(till, shirt):
    item, small, large = shirt

    entry = catalogue(till)["T-shirt"]

    assert entry["price"] is None
    assert entry["available"] is None
    assert [(v["name"], v["price"]) for v in entry["variations"]] == [
        ("S", "15.00"), ("L", "18.00"),
    ]


@pytest.mark.django_db
def test_remaining_places_are_reported_so_the_till_can_grey_a_button_out(
    till, event, ticket
):
    assert catalogue(till)["Entrée"]["available"] == 100

    Quota.objects.filter(items=ticket).update(size=0)

    assert catalogue(till)["Entrée"]["available"] == 0


@pytest.mark.django_db
def test_an_unlimited_product_says_so_rather_than_naming_a_number(till, beer):
    assert catalogue(till)["Bière"]["available"] is None


@pytest.mark.django_db
def test_the_configuration_names_the_products_that_admit_somebody(
    till, event, ticket, beer
):
    body = till.get("config").json()

    # Every item of the event, not just the sellable ones: the app has to judge
    # tickets sold online too, and one missing from this list would be announced
    # at the door as something that lets nobody in.
    assert ticket.pk in body["admission_items"]
    assert beer.pk not in body["admission_items"]


@pytest.mark.django_db
def test_the_configuration_carries_the_version_the_bundle_is_built_with(till):
    from pretix_openpos import __version__

    # What a till that stayed open across a deploy compares itself against.
    assert till.get("config").json()["version"] == __version__


@pytest.mark.django_db
def test_the_configuration_lists_every_check_in_list(till, event, checkin_list):
    other = event.checkin_lists.create(name="Bar", all_products=True)
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    checkin = till.get("config").json()["checkin"]

    assert checkin["enabled"] is True
    assert checkin["list_id"] == checkin_list.pk
    assert {entry["id"] for entry in checkin["lists"]} == {checkin_list.pk, other.pk}


@pytest.mark.django_db
def test_the_till_is_told_which_events_it_may_sell_for(till, event, organizer):
    from datetime import timedelta

    from django.utils.timezone import now
    from pretix.base.models import Event

    Event.objects.create(
        organizer=organizer, name="Sans caisse", slug="sans-caisse",
        date_from=now() + timedelta(days=2), plugins="", live=True, currency="EUR",
    )

    results = till.client.get(
        f"/api/v1/organizers/{organizer.slug}/openpos/",
        HTTP_AUTHORIZATION=f"Device {till.device.api_token}",
    ).json()["results"]

    # Access to an event is not the same thing as the organizer having opened a
    # till on it; offering one would pair the device onto endpoints that refuse it.
    assert [entry["slug"] for entry in results] == [event.slug]
