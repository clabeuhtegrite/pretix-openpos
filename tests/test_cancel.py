"""
Reversing a sale.

Never an edit: the order is cancelled through pretix' own service, the money is
recorded as going back out, and the journal gains a *new* line carrying the
negative amount. Three documents where a spreadsheet would have changed one
number, which is what makes the evening's takings defensible afterwards.
"""
from decimal import Decimal

import pytest
from pretix.base.models import Order
from pretix.base.models.orders import OrderRefund

from pretix_openpos.models import PosSale

from .conftest import sell


def cancel(till, seq, key="cancel-key-1", **kwargs):
    return till.post("cancel", {"seq": seq, "idempotency_key": key, **kwargs})


@pytest.mark.django_db
def test_cancelling_reverses_the_order_the_money_and_the_journal(till, event, ticket):
    sale = sell(till, [{"item": ticket.pk, "count": 2}]).json()

    response = cancel(till, sale["journal_seq"], reason="Erreur de saisie", cashier="Camille")

    assert response.status_code == 201
    body = response.json()
    order = Order.objects.get(code=sale["order"]["code"])
    assert order.status == Order.STATUS_CANCELED
    # Cancelling an order does not by itself say the customer was paid back.
    assert body["refunded"] is True
    refund = order.refunds.get()
    assert refund.amount == Decimal("20.00")
    assert refund.state == OrderRefund.REFUND_STATE_DONE
    assert refund.source == OrderRefund.REFUND_SOURCE_ADMIN

    reversal = PosSale.objects.get(seq=body["cancellation"]["seq"])
    assert reversal.kind == PosSale.KIND_CANCELLATION
    assert reversal.cancels_seq == sale["journal_seq"]
    assert reversal.total == Decimal("-20.00")
    assert reversal.reason == "Erreur de saisie"
    assert reversal.cashier == "Camille"


@pytest.mark.django_db
def test_the_sale_it_reverses_is_left_exactly_as_it_was(till, event, ticket):
    sale = sell(till, [{"item": ticket.pk, "count": 2}]).json()
    before = PosSale.objects.get(seq=sale["journal_seq"])

    cancel(till, sale["journal_seq"])

    after = PosSale.objects.get(seq=sale["journal_seq"])
    assert (after.total, after.hash, after.positions) == (
        before.total, before.hash, before.positions,
    )
    # The takings for the evening stay recomputable from the journal alone.
    assert sum(s.total for s in PosSale.objects.filter(event=event)) == Decimal("0.00")


@pytest.mark.django_db
def test_the_reversed_lines_go_back_in_the_basket_negated(till, ticket, beer):
    sale = sell(
        till, [{"item": ticket.pk, "count": 2}, {"item": beer.pk, "count": 1}]
    ).json()

    body = cancel(till, sale["journal_seq"]).json()

    lines = {line["item_name"]: line for line in body["cancellation"]["positions"]}
    assert lines["Entrée"]["count"] == -2
    assert lines["Entrée"]["line_total"] == "-20.00"
    assert lines["Bière"]["line_total"] == "-3.00"
    # And the sale's own lines come back unchanged, for the corrected order.
    assert {line["item_name"]: line["count"] for line in body["sale"]["positions"]} == {
        "Entrée": 2, "Bière": 1,
    }


@pytest.mark.django_db
def test_a_cancellation_that_timed_out_is_recognised_on_retry(till, event, ticket):
    """
    The reason a cancellation carries an idempotency key at all.

    The request can time out after the server has already committed it. The
    retry has to come back as the *same* cancellation — so the operator still
    gets the credit note and the corrected basket — rather than as a second
    attempt on a sale that is already reversed.
    """
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    first = cancel(till, sale["journal_seq"], key="same-key-here")
    second = cancel(till, sale["journal_seq"], key="same-key-here")

    assert first.status_code == 201
    assert second.status_code == 200
    assert second.json()["replayed"] is True
    assert second.json()["cancellation"]["seq"] == first.json()["cancellation"]["seq"]
    assert second.json()["sale"]["order"] == sale["order"]["code"]
    # One reversal, one refund. Not two.
    assert PosSale.objects.filter(kind=PosSale.KIND_CANCELLATION).count() == 1
    assert Order.objects.get(code=sale["order"]["code"]).refunds.count() == 1


@pytest.mark.django_db
def test_a_retry_under_a_fresh_key_is_refused(till, ticket):
    # What the app used to do, and why the key is now minted per sale rather
    # than per press: this is the answer the operator got instead of the credit
    # note, for a cancellation that had in fact gone through.
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    cancel(till, sale["journal_seq"], key="first-attempt")

    response = cancel(till, sale["journal_seq"], key="second-attempt")

    assert response.status_code == 400
    assert "already been cancelled" in str(response.json())


@pytest.mark.django_db
def test_another_till_cannot_unpick_this_one_s_takings(till, another_till, ticket):
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    response = cancel(another_till, sale["journal_seq"])

    # Deliberately not a 403: it is not a permission the operator can be
    # granted, it is somebody else's till.
    assert response.status_code == 400
    assert Order.objects.get(code=sale["order"]["code"]).status == Order.STATUS_PAID


@pytest.mark.django_db
def test_a_cancellation_cannot_itself_be_cancelled(till, ticket):
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    reversal = cancel(till, sale["journal_seq"], key="cancel-once-1").json()

    response = cancel(till, reversal["cancellation"]["seq"], key="cancel-twice-1")

    assert response.status_code == 400


@pytest.mark.django_db
def test_an_unknown_journal_entry_is_refused(till, ticket):
    response = cancel(till, 9999)

    assert response.status_code == 400


@pytest.mark.django_db
def test_a_cancelled_sale_is_no_longer_offered_for_cancellation(till, ticket):
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    cancel(till, sale["journal_seq"])

    history = till.get("history").json()

    lines = {line["seq"]: line for line in history["results"]}
    assert lines[sale["journal_seq"]]["cancelled"] is True
    assert lines[sale["journal_seq"]]["can_cancel"] is False


@pytest.mark.django_db
def test_a_till_only_sees_its_own_history(till, another_till, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}])

    # An operator correcting a mistake is correcting *their* mistake, made
    # minutes ago on the tablet in their hand.
    assert len(till.get("history").json()["results"]) == 1
    assert another_till.get("history").json()["results"] == []
