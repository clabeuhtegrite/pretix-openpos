"""
Limiting a device to the categories its role covers.

The complaint: a volunteer at the door comes out of a scan, taps through to
sell somebody a ticket, and lands on the whole grid with the beer one row under
the entry. The grid being shorter is the visible half of the answer, and it is
the half that stops the mistake. The half tested hardest here is the other one:
the server refuses the same line, because a catalogue is a suggestion once the
request has left the tablet, and the app can be stale or edited.

The one place it does not refuse is a sale that has already been paid for. That
is not an oversight and it has its own tests below: the money is in the drawer
either way, and refusing would leave it there with no record at all.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import ItemCategory, Order

from pretix_openpos.models import PosCategory, PosDevice, PosSale

from .conftest import sell, staff


def categories_url(event):
    return f"/control/event/{event.organizer.slug}/{event.slug}/openpos/categories/"


@pytest.fixture
def bar(event, beer):
    """The bar's own category, with the beer in it."""
    category = ItemCategory.objects.create(event=event, name="Bar", position=1)
    beer.category = category
    beer.save()
    return category


@pytest.fixture
def entries(event, ticket):
    """The door's own category, with the ticket in it."""
    category = ItemCategory.objects.create(event=event, name="Entrées", position=0)
    ticket.category = category
    ticket.save()
    return category


@pytest.fixture
def split(bar, entries):
    """The setup Ad describes: each counter sells its own category."""
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)
    PosCategory.objects.create(category=entries, role=PosDevice.ROLE_DOOR)
    return bar, entries


def assign(device, role):
    return PosDevice.objects.create(device=device, role=role)


def catalog_names(till):
    """The categories a till is offered, in the order it is offered them."""
    return [c["name"] for c in till.get("catalog").json()["categories"]]


def offline_sale(till, positions, **kwargs):
    """A sale rung up with no network, arriving late."""
    total = sum((Decimal(p["price"]) * p["count"] for p in positions), Decimal("0.00"))
    return sell(
        till,
        positions,
        offline={
            "recorded_at": (now() - timedelta(hours=2)).isoformat(),
            "charged_total": str(total),
        },
        **kwargs,
    )


# -- what a device is offered -----------------------------------------------


@pytest.mark.django_db
def test_a_door_is_not_offered_the_bar(till, device, split):
    assign(device, PosDevice.ROLE_DOOR)

    assert catalog_names(till) == ["Entrées"]


@pytest.mark.django_db
def test_a_bar_till_is_not_offered_the_entries(till, device, split):
    assign(device, PosDevice.ROLE_TILL)

    assert catalog_names(till) == ["Bar"]


@pytest.mark.django_db
def test_an_unassigned_device_is_still_offered_everything(till, device, split):
    """
    Which is every device paired before this existed.

    Narrowing the grid on the strength of a role nobody has given would take
    products away from tills that are working today, on the first deploy, with
    nothing on any screen having been changed.
    """
    assert catalog_names(till) == ["Entrées", "Bar"]


@pytest.mark.django_db
def test_a_device_with_no_row_at_all_is_offered_everything(till, split):
    assert catalog_names(till) == ["Entrées", "Bar"]


@pytest.mark.django_db
def test_a_category_reserved_for_nobody_stays_on_both(till, device, bar, entries):
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)
    assign(device, PosDevice.ROLE_DOOR)

    # "Entrées" was never reserved, so it is not taken away from anyone.
    assert catalog_names(till) == ["Entrées"]


@pytest.mark.django_db
def test_a_product_in_no_category_stays_on_every_till(till, device, split, shirt):
    """
    There is no row to reserve it on, so it is reserved for nobody.

    Said out loud on the back-office screen too, because "I reserved everything
    and the door still shows the T-shirts" is exactly how it would be found.
    """
    assign(device, PosDevice.ROLE_DOOR)

    # A set, because where the uncategorised products sort is the catalogue's
    # own business and not what this is about.
    assert set(catalog_names(till)) == {"Entrées", "Uncategorised"}


# -- what the server refuses ------------------------------------------------


@pytest.mark.django_db
def test_a_door_may_not_sell_the_bar_s_products(till, device, split, beer):
    """
    The rule the stored role exists for.

    Reached over HTTP with a basket the app would never have drawn, which is
    exactly how a stale tablet — one left open across the deploy that reserved
    the category — actually gets here.
    """
    assign(device, PosDevice.ROLE_DOOR)

    response = sell(till, [{"item": beer.pk, "count": 1}])

    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "category_not_sold"
    # Named, because "product 3 is not on sale" answers nothing to a volunteer.
    assert "Bar" in body["positions"][0]
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_the_same_door_still_sells_its_own_category(till, device, split, ticket):
    assign(device, PosDevice.ROLE_DOOR)

    assert sell(till, [{"item": ticket.pk, "count": 1}]).status_code == 201


@pytest.mark.django_db
def test_a_bar_till_may_not_sell_the_entries(till, device, split, ticket):
    assign(device, PosDevice.ROLE_TILL)

    response = sell(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 400
    assert "Entrées" in response.json()["positions"][0]


@pytest.mark.django_db
def test_an_unassigned_device_sells_whatever_it_likes(till, device, split, beer):
    assert sell(till, [{"item": beer.pk, "count": 1}]).status_code == 201


@pytest.mark.django_db
def test_nothing_is_refused_while_no_category_is_reserved(till, device, bar, entries, beer):
    assign(device, PosDevice.ROLE_DOOR)

    assert sell(till, [{"item": beer.pk, "count": 1}]).status_code == 201


@pytest.mark.django_db
def test_one_forbidden_line_refuses_the_whole_basket(till, device, split, ticket, beer):
    assign(device, PosDevice.ROLE_DOOR)

    response = sell(
        till, [{"item": ticket.pk, "count": 1}, {"item": beer.pk, "count": 1}]
    )

    assert response.status_code == 400
    assert not PosSale.objects.exists()
    assert not Order.objects.exists()


# -- what has already been paid for -----------------------------------------


@pytest.mark.django_db
def test_a_replayed_sale_from_outside_the_role_is_recorded(till, device, split, beer):
    """
    The money is in the drawer, and a refusal would not take it back out.

    The ordinary reading of this is dull: a tablet that sold beer before
    anybody gave it the door's role, replaying afterwards — which is what the
    first evening of this feature looks like. Refusing would lose a real sale
    to make a rule look tidy.
    """
    assign(device, PosDevice.ROLE_DOOR)

    response = offline_sale(till, [{"item": beer.pk, "count": 2, "price": "3.00"}])

    assert response.status_code == 201
    body = response.json()
    assert Decimal(body["order"]["total"]) == Decimal("6.00")


@pytest.mark.django_db
def test_a_replayed_sale_from_outside_the_role_is_reported(till, device, split, beer):
    assign(device, PosDevice.ROLE_DOOR)

    body = offline_sale(till, [{"item": beer.pk, "count": 2, "price": "3.00"}]).json()

    assert body["off_role"] == [
        {
            "item": beer.pk,
            "item_name": "Bière",
            "category": PosCategory.objects.get(role=PosDevice.ROLE_TILL).category_id,
            "category_name": "Bar",
            "count": 2,
        }
    ]


@pytest.mark.django_db
def test_the_journal_line_carries_the_mark(till, device, split, beer):
    """
    On the line, because the journal outlives both the order and the setting.

    The category may well be un-reserved next week, at which point nothing else
    would say this row was ever odd.
    """
    assign(device, PosDevice.ROLE_DOOR)

    body = offline_sale(till, [{"item": beer.pk, "count": 1, "price": "3.00"}]).json()

    sale = PosSale.objects.get(seq=body["journal_seq"])
    assert sale.positions[0]["outside_role"] is True


@pytest.mark.django_db
def test_the_order_s_own_history_says_which_till_and_which_category(
    till, device, split, beer
):
    assign(device, PosDevice.ROLE_DOOR)

    body = offline_sale(till, [{"item": beer.pk, "count": 1, "price": "3.00"}]).json()

    entry = (
        Order.objects.get(code=body["order"]["code"])
        .all_logentries()
        .get(action_type="pretix_openpos.order.off_role")
    )
    shown = entry.display()
    assert "Bière" in shown and "Bar" in shown
    # The till is named: with two tablets at the door, "a door device" is not
    # an answer anybody can act on.
    assert "Caisse bar" in shown


@pytest.mark.django_db
def test_an_ordinary_replay_reports_nothing(till, device, split, ticket):
    assign(device, PosDevice.ROLE_DOOR)

    body = offline_sale(till, [{"item": ticket.pk, "count": 1, "price": "10.00"}]).json()

    assert body["off_role"] == []
    sale = PosSale.objects.get(seq=body["journal_seq"])
    assert "outside_role" not in sale.positions[0]


@pytest.mark.django_db
def test_an_ordinary_sale_writes_no_history_entry(till, device, split, ticket):
    assign(device, PosDevice.ROLE_DOOR)

    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    assert not (
        Order.objects.get(code=body["order"]["code"])
        .all_logentries()
        .filter(action_type="pretix_openpos.order.off_role")
        .exists()
    )


# -- the two buttons that are not products ----------------------------------


@pytest.mark.django_db
def test_the_deposit_button_follows_its_category(till, device, bar, entries, deposit):
    """
    A door told to sell tickets only has no business handing a cup back.

    Offering the button and refusing the sale would put a volunteer in front of
    a refusal with a customer waiting, which is worse than not offering it.
    """
    deposit.category = bar
    deposit.save()
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)
    assign(device, PosDevice.ROLE_DOOR)

    assert till.get("config").json()["deposit"]["enabled"] is False


@pytest.mark.django_db
def test_the_free_amount_button_follows_its_category(till, device, bar, entries, misc):
    misc.category = bar
    misc.save()
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)
    assign(device, PosDevice.ROLE_DOOR)

    assert till.get("config").json()["custom_sale"]["enabled"] is False


@pytest.mark.django_db
def test_the_bar_keeps_both_buttons(till, device, bar, entries, deposit, misc):
    deposit.category = bar
    misc.category = bar
    deposit.save()
    misc.save()
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)
    assign(device, PosDevice.ROLE_TILL)

    config = till.get("config").json()
    assert config["deposit"]["enabled"] is True
    assert config["custom_sale"]["enabled"] is True


@pytest.mark.django_db
def test_an_unreserved_deposit_stays_on_the_door(till, device, bar, entries, deposit):
    deposit.category = bar
    deposit.save()
    assign(device, PosDevice.ROLE_DOOR)

    assert till.get("config").json()["deposit"]["enabled"] is True


# -- the back-office screen -------------------------------------------------


@pytest.mark.django_db
def test_the_screen_lists_the_categories(backoffice, event, bar, entries):
    page = backoffice.get(categories_url(event)).content.decode()

    assert "Bar" in page and "Entrées" in page


@pytest.mark.django_db
def test_the_screen_says_what_each_role_ends_up_selling(backoffice, event, split):
    """
    The dropdowns say who may sell a category; this says what a tablet shows.

    Not the same sentence read backwards, and it is the one being decided.
    """
    page = backoffice.get(categories_url(event)).content.decode()

    assert "A till device sells" in page
    assert "A door device sells" in page


@pytest.mark.django_db
def test_saving_a_role_stores_it(backoffice, event, bar, entries):
    backoffice.post(
        categories_url(event),
        {f"role_{bar.pk}": PosDevice.ROLE_TILL, f"role_{entries.pk}": ""},
    )

    assert PosCategory.objects.get(category=bar).role == PosDevice.ROLE_TILL
    # "Every till" is the absence of a row, not a row saying nothing: it is the
    # state a category starts in and the two want to look the same.
    assert not PosCategory.objects.filter(category=entries).exists()


@pytest.mark.django_db
def test_clearing_a_role_removes_the_row(backoffice, event, bar, entries):
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)

    backoffice.post(
        categories_url(event), {f"role_{bar.pk}": "", f"role_{entries.pk}": ""}
    )

    assert not PosCategory.objects.filter(category=bar).exists()


@pytest.mark.django_db
def test_an_invented_role_is_refused_and_nothing_is_written(backoffice, event, bar, entries):
    backoffice.post(
        categories_url(event),
        {f"role_{bar.pk}": "cellar", f"role_{entries.pk}": PosDevice.ROLE_DOOR},
    )

    assert not PosCategory.objects.exists()


@pytest.mark.django_db
def test_the_history_names_both_sides(backoffice, event, bar, entries):
    backoffice.post(
        categories_url(event),
        {f"role_{bar.pk}": PosDevice.ROLE_TILL, f"role_{entries.pk}": ""},
    )

    entry = event.logentry_set.get(action_type="pretix_openpos.categories.changed")
    assert entry.parsed_data["changed"] == [
        {
            "category": bar.pk,
            "category_name": "Bar",
            "role": PosDevice.ROLE_TILL,
            "role_before": "",
        }
    ]
    shown = entry.display()
    assert "Bar" in shown and "every till" in shown and "the bar till only" in shown


@pytest.mark.django_db
def test_saving_what_is_already_stored_changes_nothing(backoffice, event, bar, entries):
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)

    backoffice.post(
        categories_url(event),
        {f"role_{bar.pk}": PosDevice.ROLE_TILL, f"role_{entries.pk}": ""},
    )

    entry = event.logentry_set.get(action_type="pretix_openpos.categories.changed")
    assert entry.parsed_data["changed"] == []
    assert "nothing changed" in entry.display()


@pytest.mark.django_db
def test_an_event_with_no_categories_says_so(backoffice, event):
    page = backoffice.get(categories_url(event)).content.decode()

    assert "no product categories yet" in page


@pytest.mark.django_db
def test_someone_who_may_not_change_products_cannot_reach_the_screen(
    organizer, event, bar
):
    """
    Guarded by the permission on the products themselves.

    A namespaced string, not a legacy ``can_*`` attribute: an unknown one is
    simply never in the permission set, so a plausible-looking typo locks out
    every team that is not all-powerful while still working for an admin.
    """
    client = staff(organizer, event, "benevole@example.org", ["event.orders:read"])

    assert client.get(categories_url(event)).status_code in (403, 404)


# -- the model itself -------------------------------------------------------


@pytest.mark.django_db
def test_an_unassigned_device_has_nothing_off_limits(event, device, split):
    assert PosCategory.off_limits(event, PosDevice.for_device(device)) == set()


@pytest.mark.django_db
def test_a_row_names_the_category_and_who_sells_it(bar):
    assert str(PosCategory(category=bar, role=PosDevice.ROLE_TILL)) == "Bar: pos"
    assert str(PosCategory(category=bar)) == "Bar: all"


# -- the card reader --------------------------------------------------------


@pytest.mark.django_db
def test_a_forbidden_line_never_reaches_the_reader(till, device, bar, entries, ticket, reader_till, sumup):
    """
    The refusal that matters most, because the checkout behind it will not.

    Once the reader has charged a card, the sale arrives at ``/checkout/``
    already paid for and is recorded rather than refused — which is right, and
    which is exactly why a forbidden line has to be turned away *here*, before
    a cardholder is ever asked. Nothing has moved at this point and refusing
    costs a tap.
    """
    PosCategory.objects.create(category=entries, role=PosDevice.ROLE_DOOR)

    response = till.post(
        "terminal/start",
        {"idempotency_key": "reader-0001", "positions": [{"item": ticket.pk, "count": 1}]},
    )

    assert response.status_code == 400
    assert response.json()["code"] == "category_not_sold"
    assert sumup.started == []


@pytest.mark.django_db
def test_the_reader_still_takes_the_till_s_own_categories(till, device, bar, entries, beer, reader_till, sumup):
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)

    response = till.post(
        "terminal/start",
        {"idempotency_key": "reader-0002", "positions": [{"item": beer.pk, "count": 1}]},
    )

    assert response.status_code == 201
