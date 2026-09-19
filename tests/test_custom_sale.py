"""
Selling a free amount.

This is the one thing the till is allowed to price, and therefore the one
place where "the client never sends a price" is deliberately suspended. What
holds it in is narrow and worth testing to the letter: the amount is only
accepted on the single product the organiser set aside for it, only with a
reason attached, and only above zero. Everything else is still the server's.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import Order

from pretix_openpos.models import PosSale

from .conftest import sell


def free_amount(item, price, reason, count=1):
    return {"item": item.pk, "count": count, "price": price, "description": reason}


@pytest.mark.django_db
def test_the_button_is_off_until_a_product_is_named(till, event, beer):
    body = till.get("config").json()

    assert body["custom_sale"] == {"enabled": False, "item": None, "name": None}


@pytest.mark.django_db
def test_naming_a_product_turns_it_on(till, event, misc):
    body = till.get("config").json()

    assert body["custom_sale"] == {"enabled": True, "item": misc.pk, "name": "Divers"}


@pytest.mark.django_db
def test_a_product_that_was_deleted_turns_it_back_off(till, event, misc):
    misc.delete()

    assert till.get("config").json()["custom_sale"]["enabled"] is False


@pytest.mark.django_db
def test_the_product_it_is_booked_against_is_not_a_tile(till, event, misc, beer):
    # Its price is a placeholder. A tile reading "Divers — 0,00 €" next to the
    # free-amount button is an invitation to sell nothing for nothing — and
    # the product cannot simply be taken off the channel, because that is what
    # the checkout resolves it against.
    names = [
        item["name"]
        for category in till.get("catalog").json()["categories"]
        for item in category["items"]
    ]

    assert "Bière" in names
    assert "Divers" not in names


@pytest.mark.django_db
def test_the_amount_the_cashier_typed_is_what_is_charged(till, event, misc):
    response = sell(till, [free_amount(misc, "12.50", "Verre cassé")])

    assert response.status_code == 201
    body = response.json()
    assert body["order"]["total"] == "12.50"
    order = Order.objects.get(event=event, code=body["order"]["code"])
    assert order.total == Decimal("12.50")


@pytest.mark.django_db
def test_the_reason_is_kept_in_the_journal(till, event, misc):
    sell(till, [free_amount(misc, "12.50", "Verre cassé")])

    line = PosSale.objects.get(event=event).positions[0]
    # On the line rather than beside it: the journal is the record that
    # outlives the order, and "1× Divers, 12.50" on its own answers nothing.
    assert line["description"] == "Verre cassé"
    assert line["unit_price"] == "12.50"


@pytest.mark.django_db
def test_the_reason_reaches_the_back_office_on_the_order(till, event, misc):
    body = sell(till, [free_amount(misc, "12.50", "Verre cassé", count=2)]).json()

    order = Order.objects.get(event=event, code=body["order"]["code"])
    assert "Verre cassé" in order.comment
    assert "2×" in order.comment


@pytest.mark.django_db
def test_a_free_amount_rides_alongside_ordinary_products(till, event, misc, beer):
    body = sell(
        till,
        [{"item": beer.pk, "count": 2}, free_amount(misc, "5.00", "Pourboire")],
    ).json()

    # 2 × 3 € priced by the server, 5 € priced by the till.
    assert body["order"]["total"] == "11.00"


@pytest.mark.django_db
def test_the_amount_is_refused_on_any_other_product(till, event, misc, ticket):
    response = sell(till, [free_amount(ticket, "0.10", "Copain du président")])

    # The whole guard: without it, naming any product and any price would be a
    # 10 € ticket sold for 10 cents with a note explaining why.
    assert response.status_code == 400
    assert "set aside" in str(response.json())
    assert not Order.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_the_amount_is_refused_when_the_button_is_off(till, event, beer):
    response = sell(till, [free_amount(beer, "1.00", "Pourquoi pas")])

    assert response.status_code == 400
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_a_price_with_no_reason_is_still_refused(till, event, misc):
    response = sell(till, [{"item": misc.pk, "count": 1, "price": "12.50"}])

    assert response.status_code == 400
    assert "reason" in str(response.json())


@pytest.mark.django_db
def test_a_reason_with_no_price_is_refused_too(till, event, misc):
    # Nothing to book: the product's own price is a placeholder and charging
    # it would quietly sell a nought-euro line with a story attached.
    response = sell(till, [{"item": misc.pk, "count": 1, "description": "Verre cassé"}])

    assert response.status_code == 400


@pytest.mark.django_db
@pytest.mark.parametrize("amount", ["0.00", "-5.00"])
def test_a_free_amount_has_to_be_more_than_nothing(till, event, misc, amount):
    response = sell(till, [free_amount(misc, amount, "Geste commercial")])

    assert response.status_code == 400
    assert not Order.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_the_expected_total_still_guards_the_basket(till, event, misc, ticket):
    # The figure read out to the customer covers the free amount too, so the
    # refusal has to survive a basket that is partly priced by the till.
    response = sell(
        till,
        [{"item": ticket.pk, "count": 1}, free_amount(misc, "5.00", "Don")],
        expected_total="99.00",
    )

    assert response.status_code == 400
    assert response.json()["total"] == "15.00"


@pytest.mark.django_db
def test_a_replay_from_a_till_that_was_offline_keeps_its_amount(till, event, misc):
    response = sell(
        till,
        [free_amount(misc, "7.00", "Assiette")],
        offline={
            "recorded_at": (now() - timedelta(hours=2)).isoformat(),
            "charged_total": "7.00",
        },
    )

    assert response.status_code == 201
    body = response.json()
    assert body["order"]["total"] == "7.00"
    # Not reported as off-tariff: a free amount has no tariff to diverge from,
    # and saying "charged 7.00, the tariff says 0.00" on every one of them
    # would bury the reports that mean something.
    assert body["off_tariff"] == []


@pytest.mark.django_db
def test_the_reason_reaches_the_csv_export(backoffice, till, event, misc, organizer):
    sell(till, [free_amount(misc, "12.50", "Verre cassé")])

    url = f"/control/event/{organizer.slug}/{event.slug}/openpos/sales/?export=csv"
    rows = b"".join(backoffice.get(url).streaming_content).decode("utf-8")

    assert "Verre cassé" in rows
