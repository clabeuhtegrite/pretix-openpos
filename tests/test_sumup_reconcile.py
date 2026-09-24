"""
pretix and SumUp brought to agree about the money that went back to a card.

Both halves come from the first real refunds, on 24 September 2026. A refund
asked for moments after the payment got SumUp's 409 — "not refundable in its
current state" — at the till, and went through in SumUp's dashboard minutes
later; and that dashboard refund left pretix saying the customer was still
owed their money. So a 409 now leaves the refund waiting, asked for again by
pretix' periodic task, and a payment given back in SumUp is brought into pretix
by the same task: the order cancelled and refunded, the sale out of the
takings, the Sales page's lists cleared.

What must never happen is the same money going back twice: every test that
could send a refund says how many SumUp received.
"""
import json
from datetime import timedelta
from decimal import Decimal

import pytest
import requests
from django.core import mail
from django.core.management import call_command
from django.utils.timezone import now
from pretix.base.models import Order
from pretix.base.models.orders import OrderPayment, OrderRefund

from pretix_openpos import reconcile
from pretix_openpos.models import PosSale, PosTerminalPayment
from pretix_openpos.reconcile import PENDING_SINCE, TRIED_AT, reconcile_all

from .conftest import order_of
from .sumup_stub import NOT_REFUNDABLE, REFUND_FAILED, FakeResponse
from .test_backoffice_cancel import api, api_token, card_sale, order_url, reversals_of, sales_url

#: What the order keeps of SumUp's "not yet".
NOT_YET = "409 · The transaction is not refundable in its current state"


def cancel_at_the_till(till, sale, key="annule-01"):
    return till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": key})


def waiting_sale(till, sumup, event, ticket):
    """A card sale cancelled at the till, its refund refused by SumUp for now."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    sumup.not_refundable_yet.add("tx_1")
    response = cancel_at_the_till(till, sale)
    return sale, order_of(event, sale["order"]["code"]), response


def entries(order, action_type):
    return list(order.all_logentries().filter(action_type=action_type))


# -- SumUp's "not yet" at the till ---------------------------------------------


@pytest.mark.django_db
def test_a_till_refund_sumup_will_not_take_yet_is_left_waiting(
    backoffice, till, event, ticket, reader_till, sumup
):
    sale, order, response = waiting_sale(till, sumup, event, ticket)

    # Nothing to hand back at the counter, and nothing in red.
    assert response.json()["card_refund"] == "pending"
    assert "not refundable" not in response.content.decode()
    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_TRANSIT
    assert refund.info_data["sumup_error"] == NOT_YET
    assert PENDING_SINCE in refund.info_data
    assert sumup.refunds == []
    assert PosTerminalPayment.objects.get().refunded is None
    # The cancellation itself stands, as the till wrote it.
    assert len(reversals_of(event, sale["journal_seq"])) == 1
    [entry] = entries(order, "pretix_openpos.order.refund.pending")
    assert NOT_YET in str(entry.display())

    page = backoffice.get(sales_url(event)).content.decode()
    assert "Card refunds waiting for SumUp" in page
    assert "Card refunds SumUp refused" not in page
    assert "not refundable in its current state" in page
    order_page = backoffice.get(order_url(event, order)).content.decode()
    assert "Waiting for SumUp" in order_page
    assert "Last asked" in order_page


@pytest.mark.django_db
def test_the_till_asking_again_keeps_the_same_wait(till, event, ticket, reader_till, sumup):
    """A retried cancellation finds SumUp still saying not yet: one wait, not two."""
    sale, order, _response = waiting_sale(till, sumup, event, ticket)
    since = order.refunds.get().info_data[PENDING_SINCE]

    again = cancel_at_the_till(till, sale)

    assert again.json()["card_refund"] == "pending"
    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_TRANSIT
    assert refund.info_data[PENDING_SINCE] == since
    assert len(entries(order, "pretix_openpos.order.refund.pending")) == 1


@pytest.mark.django_db
def test_a_waiting_refund_is_sent_once_sumup_takes_it(
    backoffice, till, event, ticket, reader_till, sumup
):
    sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.not_refundable_yet.clear()

    done = reconcile_all()

    assert done["asso"]["sent"] == 1
    assert sumup.refunds == [("tx_1", None)]
    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_DONE
    assert PosTerminalPayment.objects.get().refunded is not None
    [entry] = entries(order, "pretix_openpos.order.refund.accepted")
    assert "on a later try" in str(entry.display())
    # Reversed once, by the till, when the sale was cancelled.
    assert len(reversals_of(event, sale["journal_seq"])) == 1
    assert "Card refunds waiting for SumUp" not in backoffice.get(sales_url(event)).content.decode()

    # And never a second time.
    reconcile_all()
    assert sumup.refunds == [("tx_1", None)]


@pytest.mark.django_db
def test_a_refund_sumup_still_will_not_take_is_asked_again_later(
    till, event, ticket, reader_till, sumup
):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    refund = order.refunds.get()
    refund.info_data = {**refund.info_data, TRIED_AT: "2026-09-24T12:00:00+00:00"}
    refund.save(update_fields=["info"])

    done = reconcile_all()

    assert done["asso"]["waiting"] == 1
    assert sumup.refunds == []
    refund.refresh_from_db()
    assert refund.state == OrderRefund.REFUND_STATE_TRANSIT
    assert refund.info_data[TRIED_AT] != "2026-09-24T12:00:00+00:00"
    assert refund.info_data["sumup_error"] == NOT_YET


@pytest.mark.django_db
def test_three_days_of_not_yet_is_for_a_person_to_look_at(
    backoffice, till, event, ticket, reader_till, sumup
):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    refund = order.refunds.get()
    refund.info_data = {
        **refund.info_data, PENDING_SINCE: (now() - timedelta(days=4)).isoformat()
    }
    refund.save(update_fields=["info"])

    done = reconcile_all()

    assert done["asso"]["failed"] == 1
    refund.refresh_from_db()
    assert refund.state == OrderRefund.REFUND_STATE_FAILED
    assert refund.info_data["sumup_error"] == NOT_YET
    assert entries(order, "pretix.event.order.refund.failed")
    [entry] = entries(order, "pretix_openpos.order.refund.gave_up")
    assert "stopped asking" in str(entry.display())
    page = backoffice.get(sales_url(event)).content.decode()
    assert "Card refunds SumUp refused" in page
    assert "Card refunds waiting for SumUp" not in page


@pytest.mark.django_db
def test_an_unreadable_start_of_the_wait_counts_from_the_refund(
    till, event, ticket, reader_till, sumup
):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    refund = order.refunds.get()
    refund.info_data = {**refund.info_data, PENDING_SINCE: "hier soir"}
    refund.save(update_fields=["info"])

    reconcile_all()

    refund.refresh_from_db()
    assert refund.state == OrderRefund.REFUND_STATE_TRANSIT


@pytest.mark.django_db
def test_a_waiting_refund_sumup_then_refuses_for_good_fails_with_its_words(
    till, event, ticket, reader_till, sumup
):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.refuse_refunds_with = FakeResponse(422, REFUND_FAILED)

    done = reconcile_all()

    assert done["asso"]["failed"] == 1
    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_FAILED
    assert "Amount exceeds the refundable amount" in refund.info_data["sumup_error"]


@pytest.mark.django_db
def test_sumup_out_of_reach_keeps_the_refund_waiting(
    till, event, ticket, reader_till, sumup, monkeypatch
):
    from pretix_openpos import sumup as sumup_module

    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.not_refundable_yet.clear()

    def cut(method, url, **kwargs):
        # The history is read first, then the transaction: this cuts the
        # second, the one read before a refund is sent.
        if url.endswith("/transactions"):
            raise requests.ConnectTimeout("no route")
        return sumup.request(method, url, **kwargs)

    monkeypatch.setattr(sumup_module.requests, "request", cut)

    done = reconcile_all()

    assert done["asso"]["waiting"] == 1
    assert sumup.refunds == []
    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_TRANSIT
    assert "could not be reached" in refund.info_data["sumup_error"]


@pytest.mark.django_db
def test_sumup_faulting_on_the_refund_keeps_it_waiting(till, event, ticket, reader_till, sumup):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.refuse_refunds_with = FakeResponse(503, {"message": "maintenance"})

    done = reconcile_all()

    assert done["asso"]["waiting"] == 1
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_TRANSIT


@pytest.mark.django_db
def test_a_refund_made_in_sumup_while_waiting_is_recorded_and_not_sent_again(
    backoffice, till, event, ticket, reader_till, sumup
):
    """What Ad did on 24 September: the till's refund refused, the dashboard's accepted."""
    sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.give_back("tx_1")

    done = reconcile_all()

    assert done["asso"]["given_back"] == 1
    assert sumup.refunds == []
    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_DONE
    assert refund.info_data["transaction_id"] == "tx_1"
    assert PosTerminalPayment.objects.get().refunded is not None
    [entry] = entries(order, "pretix_openpos.order.sumup.given_back")
    assert str(entry.display()) == (
        "Card payment tx_1 was refunded in SumUp (€10.00). "
        "The refund that was waiting for SumUp is done."
    )
    assert len(reversals_of(event, sale["journal_seq"])) == 1
    assert "Card refunds waiting for SumUp" not in backoffice.get(sales_url(event)).content.decode()


@pytest.mark.django_db
def test_a_refund_made_in_sumup_seen_only_on_the_transaction_is_recorded_too(
    till, event, ticket, reader_till, sumup, monkeypatch
):
    """The history can lag; the transaction read before sending is the last word."""
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.give_back("tx_1")
    monkeypatch.setattr(reconcile, "_compare", lambda *args, **kwargs: None)

    done = reconcile_all()

    assert done["asso"]["given_back"] == 1
    assert sumup.refunds == []
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE


@pytest.mark.django_db
def test_a_part_given_back_in_sumup_while_waiting_is_for_a_person(
    till, event, ticket, reader_till, sumup
):
    # Sending the whole now could be refused, or could send too much.
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.give_back("tx_1", amount="4.00")

    done = reconcile_all()

    assert sumup.refunds == []
    assert done["asso"]["failed"] == 1
    waiting = order.refunds.get(provider="openpos_card", source=OrderRefund.REFUND_SOURCE_ADMIN)
    assert waiting.state == OrderRefund.REFUND_STATE_FAILED
    # The payment stays "successful" in SumUp: its refund says the rest.
    assert waiting.info_data["sumup_error"] == "SUCCESSFUL · REFUND REFUNDED 4.0"
    external = order.refunds.get(source=OrderRefund.REFUND_SOURCE_EXTERNAL)
    assert external.amount == Decimal("4.00")


@pytest.mark.django_db
def test_a_waiting_refund_whose_reader_payment_says_given_back_is_done(
    till, event, ticket, reader_till, sumup
):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    PosTerminalPayment.objects.update(refunded=now())

    reconcile_all()

    assert sumup.refunds == []
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE


@pytest.mark.django_db
def test_a_waiting_refund_with_no_reader_payment_behind_it_is_left_alone(
    till, event, ticket, reader_till, sumup
):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    PosTerminalPayment.objects.update(status=PosTerminalPayment.STATUS_FAILED)
    asked = len(sumup.calls)

    reconcile_all()

    assert len(sumup.calls) == asked
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_TRANSIT


# -- SumUp's "not yet" from pretix' own screens --------------------------------


@pytest.mark.django_db
def test_the_refund_dialog_leaves_a_refund_sumup_will_not_take_yet_on_its_way(
    backoffice, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    payment = order.payments.get()
    sumup.not_refundable_yet.add("tx_1")

    backoffice.post(
        order_url(event, order, "refund"),
        {
            "start-mode": "partial",
            "start-partial_amount": "10.00",
            "start-action": "mark_pending",
            f"refund-{payment.pk}": "10.00",
            "perform": "on",
            "last_known_refund_id": "0",
        },
    )

    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_TRANSIT
    assert refund.info_data["transaction_id"] == "tx_1"
    assert refund.info_data["sumup_error"] == NOT_YET
    # pretix counts it as on its way, so it offers no second refund of it.
    payment.refresh_from_db()
    assert payment.refunded_amount == Decimal("10.00")
    # The order still stands, so the sale is still takings, until the card
    # has the money back.
    assert reversals_of(event, sale["journal_seq"]) == []

    sumup.not_refundable_yet.clear()
    reconcile_all()

    assert sumup.refunds == [("tx_1", None)]
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE
    [reversal] = reversals_of(event, sale["journal_seq"])
    # In the name of whoever asked for the refund, not of the task that sent it.
    assert reversal.cashier == "boss@example.org"


@pytest.mark.django_db
def test_the_rest_api_gets_a_refund_on_its_way_rather_than_an_error(
    organizer, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    token = api_token(organizer, event)
    sumup.next_response = FakeResponse(409, NOT_REFUNDABLE)

    response = api(
        token, "post", f"{event.slug}/orders/{order.code}/payments/1/refund/",
        {"amount": "10.00", "mark_canceled": True},
    )

    assert response.status_code == 200
    assert response.json()["state"] == "transit"
    order.refresh_from_db()
    assert order.status == Order.STATUS_CANCELED
    assert len(reversals_of(event, sale["journal_seq"])) == 1


# -- a payment given back in SumUp ----------------------------------------------


@pytest.mark.django_db
def test_a_payment_refunded_in_sumup_cancels_and_refunds_its_order(
    backoffice, till, event, ticket, reader_till, sumup
):
    """What Ad asked for: cancelled in SumUp, cancelled and refunded in pretix."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1")
    sent = len(mail.outbox)

    done = reconcile_all()

    assert done["asso"]["given_back"] == 1
    assert sumup.refunds == []
    order.refresh_from_db()
    assert order.status == Order.STATUS_CANCELED
    refund = order.refunds.get()
    assert refund.source == OrderRefund.REFUND_SOURCE_EXTERNAL
    assert refund.state == OrderRefund.REFUND_STATE_DONE
    assert refund.amount == Decimal("10.00")
    assert refund.info_data["transaction_id"] == "tx_1"
    assert order.payments.get().state == OrderPayment.PAYMENT_STATE_REFUNDED
    assert PosTerminalPayment.objects.get().refunded is not None
    # Out of the takings, in SumUp's name, with SumUp's reason.
    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.total == Decimal("-10.00")
    assert reversal.cashier == "SumUp"
    assert reversal.reason == "The card payment was refunded in SumUp."
    assert PosSale.verify_chain(event) is None
    # Nobody is written to: the buyer was at the counter.
    assert len(mail.outbox) == sent
    [entry] = entries(order, "pretix_openpos.order.sumup.given_back")
    assert str(entry.display()) == (
        "Card payment tx_1 was refunded in SumUp (€10.00). "
        "Open POS cancelled the order and recorded the refund."
    )
    assert "tx_1" in backoffice.get(order_url(event, order)).content.decode()


@pytest.mark.django_db
def test_a_payment_cancelled_in_sumup_says_cancelled(till, event, ticket, reader_till, sumup):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1", status="CANCELLED")

    reconcile_all()

    order.refresh_from_db()
    assert order.status == Order.STATUS_CANCELED
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE
    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.reason == "The card payment was cancelled in SumUp."
    [entry] = entries(order, "pretix_openpos.order.sumup.given_back")
    assert str(entry.display()).startswith("Card payment tx_1 was cancelled in SumUp (€10.00).")


@pytest.mark.django_db
def test_an_amount_only_the_transaction_states_is_counted_once(
    till, event, ticket, reader_till, sumup
):
    """SumUp lists a transaction's events twice over; the card got its money once."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1")

    reconcile_all()

    order.refresh_from_db()
    assert order.status == Order.STATUS_CANCELED
    assert [refund.amount for refund in order.refunds.all()] == [Decimal("10.00")]


@pytest.mark.django_db
def test_a_payment_called_refunded_with_no_figure_anywhere_is_left_as_it_is(
    till, event, ticket, reader_till, sumup
):
    """Guessing "all of it" could cancel a round for one beer handed back."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    transaction = sumup.give_back("tx_1")
    transaction["events"] = transaction["transaction_events"] = []

    reconcile_all()

    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    assert order.refunds.count() == 0
    assert PosTerminalPayment.objects.get().refunded is None


@pytest.mark.django_db
def test_a_refund_sumup_refused_and_made_in_sumup_leaves_the_refused_list(
    backoffice, till, event, ticket, reader_till, sumup
):
    """
    The other half of 24 September, as 0.22.1 left it: a refusal on the order,
    the money back from the dashboard, and pretix still listing a debt.
    """
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.next_response = FakeResponse(422, REFUND_FAILED)
    cancel_at_the_till(till, sale)
    assert "Card refunds SumUp refused" in backoffice.get(sales_url(event)).content.decode()
    sumup.give_back("tx_1")

    reconcile_all()

    refused = order.refunds.get(state=OrderRefund.REFUND_STATE_FAILED)
    recorded = order.refunds.get(source=OrderRefund.REFUND_SOURCE_EXTERNAL)
    assert recorded.state == OrderRefund.REFUND_STATE_DONE
    assert recorded.amount == refused.amount
    assert "Card refunds SumUp refused" not in backoffice.get(sales_url(event)).content.decode()
    assert len(reversals_of(event, sale["journal_seq"])) == 1
    [entry] = entries(order, "pretix_openpos.order.sumup.given_back")
    assert str(entry.display()).endswith("Open POS recorded the refund.")


@pytest.mark.django_db
def test_a_refund_as_sumup_writes_it_down_is_found_and_brought_in(
    backoffice, till, event, ticket, reader_till, sumup
):
    """
    The same, with SumUp's answers as read back from the live account on 24
    September: the payment still "successful" under both statuses, a payout
    scheduled beside the refund, and the refund a line of the history of its
    own. Asked for refunded payments only, as up to 0.24.1, the history gave
    nothing, and the order went on saying the customer was owed their money.
    """
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.next_response = FakeResponse(422, REFUND_FAILED)
    cancel_at_the_till(till, sale)
    transaction = sumup.give_back("tx_1")
    transaction["simple_status"] = "SUCCESSFUL"
    transaction["events"].insert(
        0, {"id": 90, "type": "PAYOUT", "status": "SCHEDULED", "amount": 9.8}
    )
    transaction["transaction_events"].insert(
        0, {"id": 90, "event_type": "PAYOUT", "status": "PENDING", "amount": 9.8}
    )
    order.refresh_from_db()
    assert order.pending_sum == Decimal("-10.00")

    done = reconcile_all()["asso"]

    # The refund's line, matched to the payment it names; the payment read
    # once, for how much it had back.
    assert (done["listed"], done["given_back"]) == (1, 1)
    assert sumup.transaction_reads == ["tx_1"]
    assert sumup.refunds == []
    order.refresh_from_db()
    assert order.pending_sum == Decimal("0.00")
    recorded = order.refunds.get(source=OrderRefund.REFUND_SOURCE_EXTERNAL)
    assert (recorded.state, recorded.amount) == (OrderRefund.REFUND_STATE_DONE, Decimal("10.00"))
    assert PosTerminalPayment.objects.get().refunded is not None
    assert "Card refunds SumUp refused" not in backoffice.get(sales_url(event)).content.decode()


@pytest.mark.django_db
def test_a_payment_refunded_twice_is_read_once_a_pass(till, event, ticket, reader_till, sumup):
    """Two refunds, two lines: the payment says what it had back in all."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1", amount="4.00")
    sumup.give_back("tx_1", amount="2.00")

    done = reconcile_all()["asso"]

    assert (done["listed"], done["given_back"]) == (2, 1)
    assert sumup.transaction_reads == ["tx_1"]
    [refund] = order.refunds.all()
    assert (refund.state, refund.amount) == (OrderRefund.REFUND_STATE_EXTERNAL, Decimal("6.00"))


@pytest.mark.django_db
def test_a_refund_sumup_cancelled_is_no_money_back(till, event, ticket, reader_till, sumup):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.refund_lines.append(
        {"id": "77", "transaction_id": "tx_1", "type": "REFUND", "status": "CANCELLED",
         "amount": 10.0}
    )

    done = reconcile_all()["asso"]

    assert (done["listed"], done["given_back"]) == (1, 0)
    assert sumup.transaction_reads == []
    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    assert order.refunds.count() == 0


@pytest.mark.django_db
def test_a_part_given_back_in_sumup_is_recorded_for_a_person_to_process(
    till, event, ticket, reader_till, sumup
):
    """One beer handed back does not cancel the round."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1", amount="4.00")

    reconcile_all()
    reconcile_all()

    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    [refund] = order.refunds.all()
    assert refund.state == OrderRefund.REFUND_STATE_EXTERNAL
    assert refund.amount == Decimal("4.00")
    assert PosTerminalPayment.objects.get().refunded is None
    assert reversals_of(event, sale["journal_seq"]) == []
    [entry] = entries(order, "pretix_openpos.order.sumup.given_back")
    assert "process it on this order" in str(entry.display())


@pytest.mark.django_db
def test_a_part_somebody_cancelled_on_the_order_is_not_written_again(
    till, event, ticket, reader_till, sumup
):
    """Their call, not to be undone every five minutes; more given back later is recorded."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1", amount="4.00")
    reconcile_all()
    dismissed = order.refunds.get()
    dismissed.state = OrderRefund.REFUND_STATE_CANCELED
    dismissed.save()

    reconcile_all()
    assert order.refunds.count() == 1

    # Two more: six in all.
    sumup.give_back("tx_1", amount="2.00")
    reconcile_all()
    later = order.refunds.exclude(pk=dismissed.pk).get()
    assert later.state == OrderRefund.REFUND_STATE_EXTERNAL
    assert later.amount == Decimal("2.00")
    assert len(entries(order, "pretix_openpos.order.sumup.given_back")) == 2


@pytest.mark.django_db
def test_bringing_sumup_into_pretix_twice_does_it_once(till, event, ticket, reader_till, sumup):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1")

    reconcile_all()
    done = reconcile_all()

    # Nothing left to compare: the payment is known to be given back.
    assert done == {}
    assert order.refunds.count() == 1
    assert len(entries(order, "pretix_openpos.order.sumup.given_back")) == 1
    assert len(reversals_of(event, sale["journal_seq"])) == 1


@pytest.mark.django_db
def test_a_pass_that_read_the_payment_before_another_brought_it_in_does_nothing(
    till, event, ticket, reader_till, sumup
):
    """Two passes at once: the reader payment is read again under a lock."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1")
    stale = PosTerminalPayment.objects.get()

    reconcile_all()

    assert reconcile.absorb(stale, sumup.find("tx_1")) is None
    assert order.refunds.count() == 1
    assert len(entries(order, "pretix_openpos.order.sumup.given_back")) == 1


@pytest.mark.django_db
def test_an_order_that_cannot_be_cancelled_keeps_the_refund_to_process(
    till, event, ticket, reader_till, sumup, monkeypatch
):
    from pretix.base.services import orders

    def refuse(*args, **kwargs):
        raise orders.OrderError("Nope.")

    monkeypatch.setattr(orders, "cancel_order", refuse)
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1")

    reconcile_all()

    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_EXTERNAL
    # The money is back all the same, so the sale is out of the takings.
    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.cashier == "SumUp"
    [entry] = entries(order, "pretix_openpos.order.sumup.given_back")
    assert "could not cancel the order" in str(entry.display())


@pytest.mark.django_db
def test_a_card_payment_with_no_sale_given_back_leaves_that_list(
    backoffice, till, event, ticket, reader_till, sumup
):
    from .test_terminal import start, status

    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.pay()
    status(till)
    assert "Card payments with no sale" in backoffice.get(sales_url(event)).content.decode()
    sumup.give_back("tx_1")

    reconcile_all()

    assert PosTerminalPayment.objects.get().refunded is not None
    assert "Card payments with no sale" not in backoffice.get(sales_url(event)).content.decode()


@pytest.mark.django_db
def test_a_payment_still_paid_in_sumup_is_left_as_it_is(till, event, ticket, reader_till, sumup):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])

    reconcile_all()

    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    assert order.refunds.count() == 0
    assert sumup.history_reads


@pytest.mark.django_db
def test_a_payment_given_back_that_no_reader_here_took_is_left_alone(
    till, event, ticket, reader_till, sumup
):
    """Taken on the SumUp app, say: in SumUp's history, and nothing of pretix'."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.pay("ctx_app", transaction_id="tx_app", amount="5.00")
    sumup.give_back("tx_app")

    done = reconcile_all()[event.organizer.slug]

    assert (done["compared"], done["listed"], done["given_back"]) == (True, 1, 0)
    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    assert order.refunds.count() == 0


@pytest.mark.django_db
def test_nothing_is_asked_of_sumup_with_nothing_to_compare(organizer, event, sumup):
    assert reconcile_all() == {}
    assert sumup.calls == []


@pytest.mark.django_db
def test_an_organizer_without_sumup_is_not_asked(
    organizer, till, event, ticket, reader_till, sumup
):
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    organizer.settings.delete("openpos_sumup_api_key")
    asked = len(sumup.calls)

    assert reconcile_all() == {}
    assert len(sumup.calls) == asked


@pytest.mark.django_db
def test_a_history_that_cannot_be_read_is_read_again_next_time(
    till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.give_back("tx_1")
    sumup.next_response = FakeResponse(503, {"message": "maintenance"})

    reconcile_all()
    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID

    reconcile_all()
    order.refresh_from_db()
    assert order.status == Order.STATUS_CANCELED


@pytest.mark.django_db
def test_one_payment_s_trouble_does_not_stop_the_rest(
    till, event, ticket, reader_till, sumup, monkeypatch
):
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    sumup.give_back("tx_1")

    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(reconcile, "absorb", broken)
    assert reconcile_all()["asso"]["given_back"] == 0

    monkeypatch.setattr(reconcile, "reconcile_organizer", broken)
    assert reconcile_all() == {}
    # Written down all the same, for the Sales page to say something is wrong.
    assert reconcile.last_comparison(event.organizer)["crashed"] is True


@pytest.mark.django_db
def test_one_refund_s_trouble_does_not_stop_the_rest(
    till, event, ticket, reader_till, sumup, monkeypatch
):
    waiting_sale(till, sumup, event, ticket)

    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(reconcile, "_ask_again", broken)
    done = reconcile_all()["asso"]
    assert [done[key] for key in ("given_back", "sent", "waiting", "failed")] == [0, 0, 0, 0]


# -- pretix' periodic task ------------------------------------------------------


@pytest.mark.django_db
def test_pretix_periodic_task_runs_the_comparison(till, event, ticket, reader_till, sumup):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.not_refundable_yet.clear()

    call_command("runperiodic", tasks="pretix_openpos.signals.openpos_sumup_reconcile")

    assert sumup.refunds == [("tx_1", None)]
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE


# -- a refund somebody already recorded by hand -----------------------------------


@pytest.mark.django_db
def test_a_refund_already_recorded_by_hand_is_not_recorded_twice(
    backoffice, till, event, ticket, reader_till, sumup
):
    """
    Refused at the till, given back in SumUp's dashboard, then written down in
    pretix as a manual refund by somebody tidying the order: the money went
    back once, and the order must not say the customer now owes it.
    """
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.next_response = FakeResponse(422, REFUND_FAILED)
    cancel_at_the_till(till, sale)
    order.refunds.create(
        amount=Decimal("10.00"), provider="manual", state=OrderRefund.REFUND_STATE_DONE,
        source=OrderRefund.REFUND_SOURCE_ADMIN,
    )
    sumup.give_back("tx_1")

    reconcile_all()

    order.refresh_from_db()
    assert order.pending_sum == Decimal("0.00")
    assert not order.refunds.filter(source=OrderRefund.REFUND_SOURCE_EXTERNAL).exists()
    assert PosTerminalPayment.objects.get().refunded is not None
    assert "Card refunds SumUp refused" not in backoffice.get(sales_url(event)).content.decode()
    [entry] = entries(order, "pretix_openpos.order.sumup.given_back")
    assert str(entry.display()).endswith(
        "pretix already had this refund recorded, so nothing was added."
    )


# -- what the Sales page says, and its button -----------------------------------


def compare_url(event):
    return f"/control/event/{event.organizer.slug}/{event.slug}/openpos/sales/sumup/"


@pytest.mark.django_db
def test_the_sales_page_says_when_the_periodic_task_last_compared(
    backoffice, till, event, ticket, reader_till, sumup
):
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    page = backoffice.get(sales_url(event)).content.decode()
    assert "No automatic comparison with SumUp has run yet" in page

    sumup.give_back("tx_1")
    reconcile_all()

    record = reconcile.last_comparison(event.organizer)
    assert (record["compared"], record["listed"], record["given_back"]) == (True, 1, 1)
    page = backoffice.get(sales_url(event)).content.decode()
    assert "Last automatic comparison with SumUp" in page
    assert "Given back in SumUp: 1 · brought into pretix: 1" in page


@pytest.mark.django_db
def test_the_sales_page_says_what_sumup_answered_when_it_would_not(
    backoffice, till, event, ticket, reader_till, sumup
):
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    sumup.next_response = FakeResponse(403, {"message": "users is not allowed to do this"})

    reconcile_all()

    record = reconcile.last_comparison(event.organizer)
    assert record["error"].startswith("403")
    page = backoffice.get(sales_url(event)).content.decode()
    assert "history could not be read: 403" in page
    assert "alert-warning" in page


@pytest.mark.django_db
def test_the_sales_page_says_so_when_the_last_pass_is_old(
    backoffice, till, event, ticket, reader_till, sumup
):
    """pretix advises running its cron at least hourly: two hours is a stopped task."""
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    reconcile_all()
    page = backoffice.get(sales_url(event)).content.decode()
    assert "more than two hours ago" not in page
    assert "alert-warning" not in page

    record = json.loads(event.organizer.settings.get(reconcile.LAST_COMPARED))
    record["at"] = (now() - timedelta(hours=3)).isoformat()
    event.organizer.settings.set(reconcile.LAST_COMPARED, json.dumps(record))

    page = backoffice.get(sales_url(event)).content.decode()
    assert "That is more than two hours ago" in page
    assert "alert-warning" in page


@pytest.mark.django_db
def test_an_old_pass_with_nothing_left_since_is_no_warning(
    backoffice, till, event, ticket, reader_till, sumup
):
    """The task skips an organizer with nothing to compare: its last pass ages."""
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    sumup.give_back("tx_1")
    reconcile_all()
    record = json.loads(event.organizer.settings.get(reconcile.LAST_COMPARED))
    record["at"] = (now() - timedelta(days=12)).isoformat()
    event.organizer.settings.set(reconcile.LAST_COMPARED, json.dumps(record))

    page = backoffice.get(sales_url(event)).content.decode()

    assert "Given back in SumUp: 1 · brought into pretix: 1" in page
    assert "more than two hours ago" not in page


@pytest.mark.django_db
def test_nothing_to_compare_yet_is_no_warning(backoffice, event, sumup):
    page = backoffice.get(sales_url(event)).content.decode()

    assert "Nothing to compare with SumUp" in page
    assert "No automatic comparison with SumUp has run yet" not in page
    assert "Compare with SumUp now" in page


@pytest.mark.django_db
def test_a_pass_with_nothing_left_to_compare_says_so(organizer, sumup):
    from pretix_openpos.views import comparison_summary

    done = reconcile.reconcile_organizer(organizer)

    assert sumup.calls == []
    assert "Nothing to compare with SumUp" in str(comparison_summary(done))


@pytest.mark.django_db
def test_an_unreadable_record_counts_as_no_pass(organizer, sumup):
    organizer.settings.set(reconcile.LAST_COMPARED, "{not json")
    assert reconcile.last_comparison(organizer) is None


@pytest.mark.django_db
def test_the_sales_page_says_nothing_of_sumup_without_an_account(backoffice, event):
    assert "Compare with SumUp now" not in backoffice.get(sales_url(event)).content.decode()


@pytest.mark.django_db
def test_compare_now_brings_a_refund_made_in_sumup_in_at_once(
    backoffice, till, event, ticket, reader_till, sumup
):
    """24 September again, without waiting for the server's cron."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.next_response = FakeResponse(422, REFUND_FAILED)
    cancel_at_the_till(till, sale)
    sumup.give_back("tx_1")

    page = backoffice.post(compare_url(event), follow=True).content.decode()

    assert "Given back in SumUp: 1 · brought into pretix: 1" in page
    assert "Card refunds SumUp refused" not in page
    assert sorted(refund.state for refund in order.refunds.all()) == [
        OrderRefund.REFUND_STATE_DONE, OrderRefund.REFUND_STATE_FAILED,
    ]
    # One event's pass, not the periodic task's: that one has still not run.
    assert reconcile.last_comparison(event.organizer) is None


@pytest.mark.django_db
def test_compare_now_asks_again_for_this_event_s_waiting_refund(
    backoffice, till, event, ticket, reader_till, sumup
):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.not_refundable_yet.clear()

    page = backoffice.post(compare_url(event), follow=True).content.decode()

    assert "waiting refunds sent: 1" in page
    assert sumup.refunds == [("tx_1", None)]
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE


@pytest.mark.django_db
def test_compare_now_leaves_other_events_alone(
    backoffice, organizer, till, event, ticket, reader_till, sumup
):
    """The permission it asks for is this event's, so its reach is too."""
    from pretix.base.models import Event

    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    other = Event.objects.create(
        organizer=organizer, name="Autre soirée", slug="autre", date_from=now(),
        plugins="pretix_openpos", currency="EUR",
    )
    PosTerminalPayment.objects.create(
        event=other, idempotency_key="ailleurs", reader_id="rdr_x", amount=Decimal("5.00"),
        currency="EUR", status=PosTerminalPayment.STATUS_SUCCESSFUL, transaction_id="tx_other",
        client_transaction_id="ctx_other",
    )
    sumup.pay("ctx_other", transaction_id="tx_other", amount="5.00")
    sumup.give_back("tx_other")

    backoffice.post(compare_url(event))

    assert sumup.history_reads
    assert PosTerminalPayment.objects.get(transaction_id="tx_other").refunded is None


@pytest.mark.django_db
def test_compare_now_says_what_sumup_answered(
    backoffice, till, event, ticket, reader_till, sumup
):
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    sumup.next_response = FakeResponse(503, {"message": "maintenance"})

    page = backoffice.post(compare_url(event), follow=True).content.decode()

    assert "history could not be read: 503" in page


@pytest.mark.django_db
def test_compare_now_owns_up_to_its_own_trouble(
    backoffice, till, event, ticket, reader_till, sumup, monkeypatch
):
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])

    def broken(*args, **kwargs):
        raise RuntimeError("boom")

    monkeypatch.setattr(reconcile, "reconcile_organizer", broken)
    page = backoffice.post(compare_url(event), follow=True).content.decode()

    assert "ran into an error while comparing with SumUp" in page


@pytest.mark.django_db
def test_compare_now_needs_sumup(backoffice, event):
    page = backoffice.post(compare_url(event), follow=True).content.decode()
    assert "SumUp is not set up for this organizer yet." in page


@pytest.mark.django_db
def test_compare_now_is_for_those_who_may_change_orders(reader, event, sumup):
    assert reader.post(compare_url(event)).status_code == 403
    assert sumup.calls == []
