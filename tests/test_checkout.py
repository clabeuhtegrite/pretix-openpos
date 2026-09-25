"""
Ringing up a sale.

The two properties everything else hangs off: the till never decides what
something costs, and a request that is sent twice sells one set of tickets.
"""
from decimal import Decimal

import pytest
from pretix.base.models import Checkin, Order

from pretix_openpos.models import PosSale
from pretix_openpos.payment import CARD, CASH

from .conftest import sell


@pytest.mark.django_db
def test_the_server_decides_the_price(till, event, ticket):
    response = sell(till, [{"item": ticket.pk, "count": 2}])

    assert response.status_code == 201
    body = response.json()
    assert body["order"]["total"] == "20.00"
    order = Order.objects.get(event=event, code=body["order"]["code"])
    assert order.total == Decimal("20.00")
    assert order.status == Order.STATUS_PAID


@pytest.mark.django_db
def test_a_till_cannot_name_its_own_price(till, ticket):
    response = sell(till, [{"item": ticket.pk, "count": 1, "price": "0.10"}])

    # The whole point of the client sending identifiers and nothing else: a
    # tampered-with or simply outdated app cannot sell a 10 € ticket for 10 ¢.
    assert response.status_code == 400
    assert "server" in str(response.json()).lower()


@pytest.mark.django_db
def test_a_retry_under_the_same_key_hands_back_the_first_sale(till, event, ticket):
    first = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="steady-key-1")
    second = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="steady-key-1")

    assert first.status_code == 201
    # 200, not 201: nothing new was created, and the till is told so.
    assert second.status_code == 200
    assert second.json()["replayed"] is True
    assert second.json()["order"]["code"] == first.json()["order"]["code"]
    # The single most common way a homegrown POS loses money.
    assert Order.objects.filter(event=event).count() == 1
    assert PosSale.objects.filter(event=event).count() == 1


@pytest.mark.django_db
def test_the_answer_carries_no_way_into_the_customer_s_order(till, event, ticket):
    """
    The order's secret opens the customer's own page — tickets, invoice, the
    lot. The till never needed it, and a key is not a secret: anybody holding
    one could have it replayed back to them.
    """
    first = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="no-secret-1")
    again = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="no-secret-1")
    order = Order.objects.get(event=event)

    for response in (first, again):
        assert response.json()["order"] == {"code": order.code, "total": "10.00"}
        assert order.secret not in response.content.decode()


@pytest.mark.django_db
def test_a_different_key_is_a_different_sale(till, event, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="first-sale-1")
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="second-sale")

    assert Order.objects.filter(event=event).count() == 2


@pytest.mark.django_db
def test_a_price_that_moved_under_the_basket_stops_the_sale(till, event, ticket):
    ticket.default_price = Decimal("12.00")
    ticket.save(update_fields=["default_price"])

    response = sell(till, [{"item": ticket.pk, "count": 1}], expected_total="10.00")

    assert response.status_code == 400
    body = response.json()
    assert body["code"] == "price_changed"
    assert body["total"] == "12.00"
    # Nothing has been taken at this point, which is the entire reason to refuse
    # rather than charge a figure the customer was never told.
    assert not Order.objects.filter(event=event).exists()
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_a_matching_expected_total_goes_through(till, ticket):
    response = sell(till, [{"item": ticket.pk, "count": 2}], expected_total="20.00")

    assert response.status_code == 201


@pytest.mark.django_db
def test_the_change_is_worked_out_from_what_was_handed_over(till, ticket):
    body = sell(
        till, [{"item": ticket.pk, "count": 1}], cash_given="20.00"
    ).json()

    assert body["cash_given"] == "20.00"
    assert body["cash_change"] == "10.00"


@pytest.mark.django_db
def test_less_than_the_total_is_refused(till, ticket):
    response = sell(till, [{"item": ticket.pk, "count": 1}], cash_given="5.00")

    assert response.status_code == 400


@pytest.mark.django_db
def test_a_card_sale_records_no_cash(till, ticket):
    body = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card"
    ).json()

    assert body["cash_given"] is None
    assert body["payment_type"] == "card"


@pytest.mark.django_db
def test_the_payment_provider_says_how_it_was_paid(till, event, ticket):
    cash = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="paid-cash-1")
    card = sell(
        till, [{"item": ticket.pk, "count": 1}],
        idempotency_key="paid-card-1", payment_type="card",
    )

    # So the split shows up in pretix' own reporting without a second set of books.
    assert Order.objects.get(code=cash.json()["order"]["code"]).payments.first().provider == CASH
    assert Order.objects.get(code=card.json()["order"]["code"]).payments.first().provider == CARD


@pytest.mark.django_db
def test_a_product_that_is_not_on_the_till_channel_is_refused(till, event, ticket):
    ticket.limit_sales_channels.clear()

    response = sell(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 400
    assert not Order.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_a_product_with_options_cannot_be_sold_without_one(till, shirt):
    item, _small, _large = shirt

    response = sell(till, [{"item": item.pk, "count": 1}])

    assert response.status_code == 400


@pytest.mark.django_db
def test_an_option_is_priced_on_its_own(till, shirt):
    item, _small, large = shirt

    body = sell(till, [{"item": item.pk, "variation": large.pk, "count": 1}]).json()

    assert body["order"]["total"] == "18.00"


@pytest.mark.django_db
def test_the_journal_records_what_was_sold_and_by_whom(till, event, ticket, beer, device):
    body = sell(
        till,
        [{"item": ticket.pk, "count": 2}, {"item": beer.pk, "count": 3}],
        cashier="Camille",
    ).json()

    sale = PosSale.objects.get(event=event, seq=body["journal_seq"])
    assert sale.total == Decimal("29.00")
    assert sale.cashier == "Camille"
    assert sale.device_serial == device.unique_serial
    assert sale.device_name == "Caisse bar"
    assert sale.payment_type == PosSale.PAYMENT_CASH
    assert sale.offline is False
    # A snapshot of the lines, so the journal stays readable after a product is
    # renamed or deleted.
    assert {(line["item_name"], line["count"], line["line_total"]) for line in sale.positions} == {
        ("Entrée", 2, "20.00"),
        ("Bière", 3, "9.00"),
    }


@pytest.mark.django_db
def test_a_ticket_sold_is_a_ticket_checked_in(till, event, ticket, checkin_list):
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    body = sell(till, [{"item": ticket.pk, "count": 2}]).json()

    assert body["checked_in"] == 2
    assert body["checkin_errors"] == []
    order = Order.objects.get(code=body["order"]["code"])
    assert Checkin.objects.filter(position__order=order, type=Checkin.TYPE_ENTRY).count() == 2


@pytest.mark.django_db
def test_a_beer_is_not_checked_in(till, event, beer, checkin_list):
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    body = sell(till, [{"item": beer.pk, "count": 2}]).json()

    # The list accepts all products and pretix would dutifully record the scan,
    # but a merch line has no door — and the till would announce "let them in"
    # after a pure shop sale.
    assert body["checked_in"] == 0
    order = Order.objects.get(code=body["order"]["code"])
    assert not Checkin.objects.filter(position__order=order).exists()


@pytest.mark.django_db
def test_nothing_is_checked_in_without_a_list_configured(till, ticket):
    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    assert body["checked_in"] is None


@pytest.mark.django_db
def test_a_replay_finishes_a_check_in_the_first_attempt_never_reached(
    till, event, ticket, checkin_list
):
    # The first attempt is made with no check-in list, so the order exists
    # without anyone having been let in; the list is then configured, standing
    # in for an attempt whose connection died after the order was committed.
    body = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="half-done-1").json()
    assert body["checked_in"] is None
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    replay = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="half-done-1").json()

    assert replay["replayed"] is True
    assert replay["checked_in"] == 1
    order = Order.objects.get(code=body["order"]["code"])
    assert Checkin.objects.filter(position__order=order, type=Checkin.TYPE_ENTRY).count() == 1


@pytest.mark.django_db
def test_a_second_replay_does_not_admit_the_same_person_twice(
    till, event, ticket, checkin_list
):
    event.settings.set("openpos_checkin_list", checkin_list.pk)
    body = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="steady-key-2").json()

    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="steady-key-2")
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="steady-key-2")

    order = Order.objects.get(code=body["order"]["code"])
    assert Checkin.objects.filter(position__order=order, type=Checkin.TYPE_ENTRY).count() == 1


@pytest.mark.django_db
def test_an_empty_basket_is_refused(till):
    response = sell(till, [])

    assert response.status_code == 400


@pytest.mark.django_db
def test_the_endpoint_is_closed_when_the_plugin_is_not_enabled(till, event, ticket):
    event.plugins = ""
    event.save()

    response = sell(till, [{"item": ticket.pk, "count": 1}])

    # A device may well have access to events that do not run the POS; refusing
    # here is what keeps a stale app from selling on one.
    assert response.status_code == 403


@pytest.mark.django_db
def test_an_unpaired_caller_gets_nothing(event, ticket):
    from django.test import Client

    response = Client().get(
        f"/api/v1/organizers/{event.organizer.slug}/events/{event.slug}/openpos/catalog/"
    )

    assert response.status_code in (401, 403)


@pytest.mark.django_db
def test_an_invoice_that_will_not_generate_does_not_lose_the_sale(
    till, event, ticket, monkeypatch
):
    # The money is in the drawer. Failing the sale because the PDF renderer
    # fell over would be the wrong trade every time — and the failure is
    # written into the order's own log so it can be picked up afterwards.
    from pretix_openpos.api import sales

    def explode(*args, **kwargs):
        raise RuntimeError("no fonts")

    monkeypatch.setattr(sales, "generate_invoice", explode)

    response = sell(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 201
    order = Order.objects.get(event=event)
    assert order.invoices.count() == 0
    assert order.all_logentries().filter(
        action_type="pretix.event.order.invoice.failed"
    ).exists()


@pytest.mark.django_db
def test_a_check_in_that_fails_unexpectedly_is_reported_not_swallowed(
    till, event, ticket, checkin_list, monkeypatch
):
    # The customer is standing there. The sale stands, and the screen says the
    # ticket has to be waved through by hand.
    from pretix_openpos.api import sales

    event.settings.set("openpos_checkin_list", str(checkin_list.pk))

    def explode(*args, **kwargs):
        raise RuntimeError("the check-in service is having a moment")

    monkeypatch.setattr(sales, "perform_checkin", explode)

    response = sell(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 201
    body = response.json()
    assert body["checked_in"] == 0
    assert "having a moment" in " ".join(body["checkin_errors"])


@pytest.mark.django_db
def test_a_ticket_pretix_refuses_at_the_door_is_named_in_the_answer(
    till, event, ticket, checkin_list, monkeypatch
):
    from pretix.base.services.checkin import CheckInError

    from pretix_openpos.api import sales

    event.settings.set("openpos_checkin_list", str(checkin_list.pk))

    def refuse(*args, **kwargs):
        raise CheckInError("Ticket blocked.", "blocked")

    monkeypatch.setattr(sales, "perform_checkin", refuse)

    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    assert body["checked_in"] == 0
    assert body["checkin_errors"]


@pytest.mark.django_db
def test_a_till_cannot_say_it_received_a_negative_amount(till, ticket):
    response = sell(
        till, [{"item": ticket.pk, "count": 1}], cash_given="-10.00"
    )

    assert response.status_code == 400
    assert "negative" in str(response.json())


@pytest.mark.django_db
def test_a_card_sale_cannot_carry_an_amount_received(till, ticket):
    # There is no drawer in a card payment, so an amount there is either a bug
    # in the app or a till reporting cash it never took.
    response = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", cash_given="10.00"
    )

    assert response.status_code == 400
    assert "cash" in str(response.json()).lower()


# -- how big one sale may be -----------------------------------------------


@pytest.mark.django_db
def test_a_sale_of_more_items_than_any_counter_sells_is_refused(till, event, beer):
    from pretix_openpos.api.serializers import MAX_ITEMS

    response = sell(
        till,
        [{"item": beer.pk, "count": MAX_ITEMS - 10}, {"item": beer.pk, "count": 11}],
    )

    assert response.status_code == 400
    assert response.json()["code"] == "too_many_items"
    assert str(MAX_ITEMS) in response.json()["positions"][0]
    assert not Order.objects.filter(event=event).exists()
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_a_sale_right_at_the_limit_goes_through(till, beer, monkeypatch):
    from pretix_openpos.api import serializers

    # Counted over the whole basket, and inclusive. Lowered so the test does
    # not write five hundred order positions to say so.
    monkeypatch.setattr(serializers, "MAX_ITEMS", 3)

    assert sell(
        till, [{"item": beer.pk, "count": 2}, {"item": beer.pk, "count": 1}]
    ).status_code == 201
    assert sell(
        till, [{"item": beer.pk, "count": 4}], idempotency_key="one-too-many"
    ).json()["code"] == "too_many_items"


@pytest.mark.django_db
def test_a_replayed_sale_of_that_size_is_refused_too(till, beer, monkeypatch):
    """
    What a till's queue holds is bounded like what it sells live: the app
    caps a basket, so a queued sale this size is not one it could have made,
    and the refusal goes to the list the operator is shown.
    """
    from datetime import timedelta

    from django.utils.timezone import now

    from pretix_openpos.api import serializers

    monkeypatch.setattr(serializers, "MAX_ITEMS", 3)

    response = sell(
        till,
        [{"item": beer.pk, "count": 4, "price": "3.00"}],
        offline={
            "recorded_at": (now() - timedelta(hours=1)).isoformat(),
            "charged_total": "12.00",
        },
    )

    assert response.status_code == 400
    assert response.json()["code"] == "too_many_items"
