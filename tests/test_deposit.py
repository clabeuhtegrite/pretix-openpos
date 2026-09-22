"""
Taking a cup deposit, and handing it back.

The deposit itself is an ordinary product and needs nothing from this file.
The return is the interesting half: it cannot be a pretix order, because an
order's total cannot go below nothing and the queue at the end of an evening
is people returning cups and buying nothing at all. So it is a journal row of
its own, carrying a negative amount and no order — which is what keeps the
takings the plain sum of the column and the drawer reconcilable against it.

The invariant to hold on to while reading: SUM(total) over the journal is what
should be in the drawer, whatever mixture of sales and returns produced it.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import Order

from pretix_openpos.models import PosSale

from .conftest import sell


def give_back(item, count=1):
    return {"item": item.pk, "count": count, "refund": True}


def drawer(event):
    """What the journal says the till is holding."""
    return sum((s.total for s in PosSale.objects.filter(event=event)), Decimal("0.00"))


@pytest.mark.django_db
def test_the_button_is_off_until_a_product_is_named(till, event, beer):
    assert till.get("config").json()["deposit"] == {
        "enabled": False, "item": None, "name": None, "price": None,
    }


@pytest.mark.django_db
def test_the_till_is_told_what_a_deposit_is_worth(till, event, deposit):
    assert till.get("config").json()["deposit"] == {
        "enabled": True, "item": deposit.pk, "name": "Consigne gobelet", "price": "1.00",
    }


@pytest.mark.django_db
def test_the_on_site_tariff_decides_it_like_any_other_price(till, event, deposit):
    from pretix_openpos.models import PosPrice

    PosPrice.objects.create(event=event, item=deposit, price=Decimal("2.00"))

    assert till.get("config").json()["deposit"]["price"] == "2.00"


@pytest.mark.django_db
def test_returning_cups_alone_takes_money_out_with_no_order(till, event, deposit):
    response = sell(till, [give_back(deposit, count=3)])

    assert response.status_code == 201
    body = response.json()
    # Nothing for pretix to hold, and the till is told so rather than being
    # handed an order worth minus three euros.
    assert not Order.objects.filter(event=event).exists()
    assert body["order"]["code"] == ""
    assert body["order"]["total"] == "0.00"
    assert body["deposit_refund"] == "3.00"
    assert body["net_total"] == "-3.00"


@pytest.mark.django_db
def test_the_return_is_a_journal_row_of_its_own(till, event, deposit):
    sell(till, [give_back(deposit, count=3)])

    row = PosSale.objects.get(event=event)
    assert row.kind == PosSale.KIND_DEPOSIT_REFUND
    assert row.total == Decimal("-3.00")
    assert row.order is None
    assert row.order_code == ""
    assert drawer(event) == Decimal("-3.00")


@pytest.mark.django_db
def test_a_sale_and_a_return_are_two_rows_and_one_customer(till, event, beer, deposit):
    body = sell(till, [{"item": beer.pk, "count": 4}, give_back(deposit, count=3)]).json()

    sale = PosSale.objects.get(event=event, kind=PosSale.KIND_SALE)
    refund = PosSale.objects.get(event=event, kind=PosSale.KIND_DEPOSIT_REFUND)
    # pretix is told about the beer and only the beer: four beers were sold,
    # and three euros were paid out for cups. Two economic events, and
    # netting them into the order would understate the bar's takings.
    assert sale.total == Decimal("12.00")
    assert Order.objects.get(event=event, code=body["order"]["code"]).total == Decimal("12.00")
    assert refund.total == Decimal("-3.00")
    # What the customer actually put on the counter.
    assert body["net_total"] == "9.00"
    assert drawer(event) == Decimal("9.00")


@pytest.mark.django_db
def test_the_change_is_counted_out_of_the_net(till, event, beer, deposit):
    body = sell(
        till,
        [{"item": beer.pk, "count": 4}, give_back(deposit, count=3)],
        cash_given="10.00",
        expected_total="9.00",
    ).json()

    # A ten-euro note against nine euros due, not against the twelve the order
    # is worth. Getting this wrong hands back the wrong money, in front of the
    # customer, every single time.
    assert body["cash_change"] == "1.00"
    assert PosSale.objects.get(event=event, kind=PosSale.KIND_SALE).cash_change == Decimal("1.00")


@pytest.mark.django_db
def test_the_expected_total_is_the_net_one(till, event, beer, deposit):
    response = sell(
        till,
        [{"item": beer.pk, "count": 4}, give_back(deposit, count=3)],
        expected_total="12.00",
    )

    assert response.status_code == 400
    assert response.json()["total"] == "9.00"


@pytest.mark.django_db
def test_nothing_is_tendered_when_the_drawer_is_the_one_paying(till, event, deposit):
    response = sell(till, [give_back(deposit, count=3)], cash_given="5.00")

    assert response.status_code == 400
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_a_basket_that_nets_negative_still_sells_what_was_sold(till, event, beer, deposit):
    # One beer against four cups: the customer walks away with a euro. The
    # order still exists and is still paid — it was, out of the deposit.
    body = sell(till, [{"item": beer.pk, "count": 1}, give_back(deposit, count=4)]).json()

    assert body["net_total"] == "-1.00"
    assert Order.objects.get(event=event, code=body["order"]["code"]).status == Order.STATUS_PAID
    assert drawer(event) == Decimal("-1.00")


@pytest.mark.django_db
def test_the_return_is_refused_on_any_other_product(till, event, deposit, ticket):
    response = sell(till, [give_back(ticket)])

    assert response.status_code == 400
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_the_return_is_refused_when_the_button_is_off(till, event, beer):
    response = sell(till, [give_back(beer)])

    assert response.status_code == 400


@pytest.mark.django_db
def test_a_return_is_not_also_a_free_amount(till, event, deposit):
    # Two different kinds of line, and the till never builds both at once.
    # Refusing on the shape keeps the checkout from having to work out which
    # of the two it is looking at, and with it which price wins.
    response = sell(
        till,
        [{"item": deposit.pk, "count": 1, "refund": True, "description": "Pourquoi pas"}],
    )

    assert response.status_code == 400
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_a_return_has_no_option_to_choose(till, event, deposit, shirt):
    _item, small, _large = shirt

    response = sell(
        till, [{"item": deposit.pk, "count": 1, "refund": True, "variation": small.pk}]
    )

    assert response.status_code == 400


@pytest.mark.django_db
def test_a_replayed_return_cannot_claim_to_have_taken_money(till, event, deposit):
    response = sell(
        till,
        [{"item": deposit.pk, "count": 1, "refund": True, "price": "5.00"}],
        offline={
            "recorded_at": (now() - timedelta(hours=2)).isoformat(),
            "charged_total": "5.00",
        },
    )

    assert response.status_code == 400
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_a_retry_hands_back_the_same_transaction_without_paying_twice(till, event, beer, deposit):
    lines = [{"item": beer.pk, "count": 4}, give_back(deposit, count=3)]
    first = sell(till, lines, idempotency_key="one-evening-1")
    second = sell(till, lines, idempotency_key="one-evening-1")

    assert second.status_code == 200
    assert second.json()["replayed"] is True
    # Both halves recognised, not just the sale: a retry that re-ran only the
    # payout would hand the deposit back a second time.
    assert second.json()["deposit_refund"] == "3.00"
    assert second.json()["net_total"] == "9.00"
    assert PosSale.objects.filter(event=event).count() == 2
    assert drawer(event) == Decimal("9.00")
    assert first.json()["order"]["code"] == second.json()["order"]["code"]


@pytest.mark.django_db
def test_a_retry_of_a_return_alone_is_recognised_too(till, event, deposit):
    sell(till, [give_back(deposit, count=2)], idempotency_key="cups-back-01")
    second = sell(till, [give_back(deposit, count=2)], idempotency_key="cups-back-01")

    assert second.status_code == 200
    assert second.json()["deposit_refund"] == "2.00"
    assert PosSale.objects.filter(event=event).count() == 1
    assert drawer(event) == Decimal("-2.00")


@pytest.mark.django_db
def test_a_return_queued_offline_replays(till, event, beer, deposit):
    response = sell(
        till,
        [
            {"item": beer.pk, "count": 2, "price": "3.00"},
            {"item": deposit.pk, "count": 1, "refund": True, "price": "-1.00"},
        ],
        offline={
            "recorded_at": (now() - timedelta(hours=2)).isoformat(),
            "charged_total": "5.00",
        },
    )

    assert response.status_code == 201
    assert response.json()["net_total"] == "5.00"
    assert drawer(event) == Decimal("5.00")
    assert PosSale.objects.filter(event=event, offline=True).count() == 2


@pytest.mark.django_db
def test_a_return_cannot_be_cancelled_from_the_till(till, event, deposit):
    sell(till, [give_back(deposit)])
    row = PosSale.objects.get(event=event)

    response = till.post(
        "cancel", {"seq": row.seq, "idempotency_key": "undo-the-cup-1"}
    )

    # Not a sale, so there is no order to credit. Taking the deposit again is
    # a deposit sold, which the till can already do in one tap.
    assert response.status_code == 400
    assert "not a sale" in str(response.json())


@pytest.mark.django_db
def test_the_history_shows_it_and_does_not_offer_to_reverse_it(till, event, deposit):
    sell(till, [give_back(deposit, count=2)])

    line = till.get("history").json()["results"][0]

    assert line["kind"] == PosSale.KIND_DEPOSIT_REFUND
    assert line["total"] == "-2.00"
    assert line["can_cancel"] is False


@pytest.mark.django_db
def test_the_takings_net_the_returns_off_and_count_them_apart(till, event, beer, deposit):
    sell(till, [{"item": beer.pk, "count": 4}], idempotency_key="the-beers-01")
    sell(till, [give_back(deposit, count=3)], idempotency_key="the-cups-001")

    body = till.get("summary").json()

    # One sale, whatever the journal holds beside it: a returned cup is not a
    # customer served. The money, on the other hand, has left the drawer.
    assert body["event"]["count"] == 1
    assert body["event"]["deposit_refunds"] == 1
    assert body["event"]["cash"] == "9.00"
    assert body["event"]["total"] == "9.00"


# -- cancelling a basket that had a deposit in it --------------------------


def cancel(till, seq, key="cancel-key-1", **kwargs):
    return till.post("cancel", {"seq": seq, "idempotency_key": key, **kwargs})


@pytest.mark.django_db
def test_cancelling_a_mixed_basket_puts_the_deposit_back_too(till, event, beer, deposit):
    """
    Two beers bought and three cups handed back is one transaction and two
    journal rows: the customer put the net on the counter. Reversing only the
    sale would leave the drawer short by the deposit for the rest of the
    evening, and the volunteer counting at 1:30 would find the difference with
    nothing to explain it.
    """
    sale = sell(
        till,
        [{"item": beer.pk, "count": 2}, give_back(deposit, 3)],
        cash_given="3.00",
    ).json()
    net = drawer(event)

    cancel(till, sale["journal_seq"], reason="Erreur de saisie")

    # Two beers at 3,00 less three cups at 1,00: the customer put 3,00 down.
    assert net == Decimal("3.00")
    assert drawer(event) == Decimal("0.00")


@pytest.mark.django_db
def test_the_reversal_of_the_deposit_names_the_row_it_reverses(till, event, beer, deposit):
    sale = sell(
        till, [{"item": beer.pk, "count": 2}, give_back(deposit, 3)], cash_given="3.00"
    ).json()
    payout = PosSale.objects.get(event=event, kind=PosSale.KIND_DEPOSIT_REFUND)

    cancel(till, sale["journal_seq"])

    reversal = PosSale.objects.get(event=event, cancels_seq=payout.seq)
    assert reversal.kind == PosSale.KIND_CANCELLATION
    assert reversal.total == Decimal("3.00")


@pytest.mark.django_db
def test_a_cancellation_retried_does_not_put_the_deposit_back_twice(till, event, beer, deposit):
    """
    The same key, the same answer: the payout half derives its key from the
    cancellation's exactly as it derived from the sale's.
    """
    sale = sell(
        till, [{"item": beer.pk, "count": 2}, give_back(deposit, 3)], cash_given="3.00"
    ).json()

    cancel(till, sale["journal_seq"])
    cancel(till, sale["journal_seq"])

    assert drawer(event) == Decimal("0.00")
    assert PosSale.objects.filter(event=event, kind=PosSale.KIND_CANCELLATION).count() == 2


@pytest.mark.django_db
def test_a_sale_with_no_deposit_still_reverses_to_one_row(till, event, beer):
    sale = sell(till, [{"item": beer.pk, "count": 2}], cash_given="6.00").json()

    cancel(till, sale["journal_seq"])

    assert drawer(event) == Decimal("0.00")
    assert PosSale.objects.filter(event=event, kind=PosSale.KIND_CANCELLATION).count() == 1
