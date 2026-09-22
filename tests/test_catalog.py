"""
What the till is told it may sell, and what it is told about the event.

The catalogue is the one thing the app caches and goes on selling from when the
network is gone, so what it contains — and what it deliberately does not — is
part of the contract.
"""
from decimal import Decimal

import pytest
from pretix.base.models import Item, Quota


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
def test_the_price_shown_is_the_one_pretix_carries(till, event, ticket):
    """The till displays what the server priced, never a figure of its own."""
    ticket.default_price = Decimal("8.00")
    ticket.save(update_fields=["default_price"])

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
def test_an_option_with_no_price_of_its_own_inherits_the_product_s(till, event, channel):
    # pretix' own resolution order, which the till has to mirror or the door
    # quotes a different figure from the webshop.
    item = Item.objects.create(
        event=event, name="Badge", default_price=Decimal("7.00"), all_sales_channels=False
    )
    item.limit_sales_channels.add(channel)
    plain = item.variations.create(value="Standard", default_price=None)
    quota = Quota.objects.create(event=event, name="Badges", size=10)
    quota.items.add(item)
    quota.variations.add(plain)

    badge = catalogue(till)["Badge"]

    assert badge["variations"][0]["price"] == "7.00"


@pytest.mark.django_db
def test_an_option_priced_on_its_own_beats_the_product(till, event, channel, shirt):
    item, _small, _large = shirt
    small = item.variations.get(value="S")
    small.default_price = Decimal("12.00")
    small.save(update_fields=["default_price"])

    options = {v["name"]: v for v in catalogue(till)["T-shirt"]["variations"]}

    assert options["S"]["price"] == "12.00"
    # The other option is untouched: two options of one product move apart.
    assert options["L"]["price"] == "18.00"


@pytest.mark.django_db
def test_an_option_that_is_switched_off_is_not_offered(till, shirt):
    item, small, _large = shirt
    small.active = False
    small.save()

    options = {v["name"] for v in catalogue(till)["T-shirt"]["variations"]}

    assert options == {"L"}


@pytest.mark.django_db
def test_a_product_whose_every_option_is_off_disappears_with_them(till, shirt):
    # Not a button that cannot be pressed: a button that is not there. An empty
    # product on a grid is a tap that does nothing, mid-queue.
    item, small, large = shirt
    item.variations.update(active=False)

    assert "T-shirt" not in catalogue(till)


@pytest.mark.django_db
def test_a_product_with_no_quota_at_all_is_shown_as_sold_out(till, event):
    # pretix' own shop treats a product attached to no quota as unavailable,
    # and its order pipeline refuses it outright. Shown as unlimited, the till
    # would let it into a basket and only be refused at payment, in front of
    # the customer; shown as sold out, it is a configuration mistake the
    # organiser sees at once — and a quota, unlimited if need be, is the fix.
    Item.objects.create(event=event, name="Tombola", default_price=2)

    assert catalogue(till)["Tombola"]["available"] == 0


@pytest.mark.django_db
def test_an_option_left_out_of_every_quota_is_shown_as_sold_out(till, shirt):
    item, small, large = shirt
    Quota.objects.get(items=item).variations.remove(large)

    variations = {v["name"]: v for v in catalogue(till)["T-shirt"]["variations"]}

    assert variations["S"]["available"] == 50
    assert variations["L"]["available"] == 0
