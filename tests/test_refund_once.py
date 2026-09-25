"""
One cancellation, one refund, however many times a till asks.

From the review of 25 September 2026. A till cancels a card sale, SumUp takes
its time over the refund, and the till asks again — under the same key when
its request timed out, under a new one when the app was reloaded meanwhile.
Every attempt found the sale not cancelled yet and the card not refunded yet:
pretix cancelled the order a second time, and SumUp was asked a second time,
whose answer — nothing left to refund — was written down as a failed refund
over the one that had gone through.

And SumUp's 429, "too many requests", read as a refusal: a payment still on
the reader marked failed, a refund put off given up on.
"""
import threading
from contextlib import contextmanager

import pytest
from django.core.cache import cache
from django.utils.timezone import now
from pretix.base.models import Order
from pretix.base.models.orders import OrderRefund

from pretix_openpos import reconcile, sumup as sumup_module
from pretix_openpos.api import views
from pretix_openpos.models import PosSale, PosTerminalPayment
from pretix_openpos.reconcile import REFUNDING_KEY, reconcile_all, wait_for_refund

from .conftest import order_of, sell
from .sumup_stub import FakeResponse
from .test_backoffice_cancel import card_sale, order_url
from .test_cancel import cancel, flags
from .test_sumup_reconcile import waiting_sale
from .test_terminal import start, status

#: SumUp turning a request away for the moment.
TOO_MANY = FakeResponse(429, {"message": "Too Many Requests"})


def cancelled_meanwhile(monkeypatch, till, seq, key):
    """
    Have another attempt at this cancellation commit while the next is under way.

    Hooked where the next attempt has looked its key and the sale up and found
    neither — the first was not finished — and has written nothing yet: exactly
    where a first attempt still running on another worker would commit.
    Returns a dict holding the first attempt's answer once it ran.
    """
    real = views.drawer_session_for
    first = {}

    def racing(*args, **kwargs):
        if "response" not in first:
            first["response"] = None
            first["response"] = cancel(till, seq, key=key)
        return real(*args, **kwargs)

    monkeypatch.setattr(views, "drawer_session_for", racing)
    return first


def refund_dialog(backoffice, event, order):
    """
    pretix' own refund dialog, giving the whole card payment back automatically.

    Followed to the order page, which is where pretix says how it went.
    """
    payment = order.payments.get()
    return backoffice.post(
        order_url(event, order, "refund"),
        {
            "start-mode": "partial",
            "start-partial_amount": str(payment.amount),
            f"refund-{payment.pk}": str(payment.amount),
            "perform": "on",
            "last_known_refund_id": "0",
        },
        follow=True,
    )


def cancellations(event):
    return PosSale.objects.filter(event=event, kind=PosSale.KIND_CANCELLATION).count()


def held_by_someone_else(terminal):
    """The mark another request refunding ``terminal`` would hold."""
    cache.add(REFUNDING_KEY.format(terminal.pk), True, timeout=60)


# -- two attempts at one cancellation ------------------------------------------


@pytest.mark.django_db
def test_an_attempt_that_overlapped_the_first_answers_as_its_replay(
    monkeypatch, till, event, ticket
):
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    first = cancelled_meanwhile(monkeypatch, till, sale["journal_seq"], "same-cancel")

    second = cancel(till, sale["journal_seq"], key="same-cancel")

    assert first["response"].status_code == 201
    # What a retry a second later would have got: this cancellation, again.
    assert second.status_code == 200, second.content
    assert flags(second.json()) == (True, False, False)
    assert second.json()["cancellation"] == first["response"].json()["cancellation"]
    assert second.json()["credit_note"] == first["response"].json()["credit_note"]
    assert cancellations(event) == 1
    assert order_of(event, sale["order"]["code"]).refunds.count() == 1


@pytest.mark.django_db
def test_an_attempt_under_another_key_finds_the_cancellation_that_overlapped_it(
    monkeypatch, till, event, ticket
):
    """
    The app reloaded while the first attempt was still being written, and asked
    again with a key of its own. pretix' cancel_order trusts the order it is
    handed, so the second attempt, which had read the order before the first
    committed, cancelled it a second time: a second credit note, a second
    refund, a second line in the journal.
    """
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    first = cancelled_meanwhile(monkeypatch, till, sale["journal_seq"], "first-cancel")

    second = cancel(till, sale["journal_seq"], key="second-cancel")

    assert first["response"].status_code == 201
    assert second.status_code == 200, second.content
    assert flags(second.json()) == (True, True, False)
    for field in ("cancellation", "sale", "credit_note", "refunded", "card_refund"):
        assert second.json()[field] == first["response"].json()[field], field
    order = order_of(event, sale["order"]["code"])
    assert cancellations(event) == 1
    assert order.refunds.count() == 1
    assert order.invoices.filter(is_cancellation=True).count() == 1
    assert order.all_logentries().filter(action_type="pretix.event.order.canceled").count() == 1


@pytest.mark.django_db
def test_a_card_cancelled_twice_at_once_goes_back_once(
    monkeypatch, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    first = cancelled_meanwhile(monkeypatch, till, sale["journal_seq"], "first-cancel")

    second = cancel(till, sale["journal_seq"], key="second-cancel")

    assert first["response"].json()["card_refund"] == "done"
    assert second.json()["card_refund"] == "already"
    assert sumup.refunds == [("tx_1", None)]
    refund = order_of(event, sale["order"]["code"]).refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_DONE


@pytest.mark.django_db
def test_an_order_that_could_no_longer_be_cancelled_meanwhile_is_refused_in_words(
    monkeypatch, till, event, ticket
):
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    real = views.drawer_session_for

    def meanwhile(*args, **kwargs):
        # Changed by something that writes no journal line: read again under
        # the lock, the order is what decides.
        Order.objects.filter(code=sale["order"]["code"]).update(status=Order.STATUS_CANCELED)
        return real(*args, **kwargs)

    monkeypatch.setattr(views, "drawer_session_for", meanwhile)

    response = cancel(till, sale["journal_seq"])

    assert response.status_code == 400
    assert "pretix will not let this order be cancelled" in str(response.json())
    assert cancellations(event) == 0


@pytest.mark.django_db
def test_a_key_clash_the_journal_cannot_account_for_is_not_passed_off_as_a_replay(
    monkeypatch, till, event, ticket
):
    sell(till, [{"item": ticket.pk, "count": 1}])
    sale = PosSale.objects.get(event=event, kind=PosSale.KIND_SALE)
    # Something under the key when the transaction looked, nothing once it
    # had rolled back: there is no answer to hand back, so there is none.
    monkeypatch.setattr(views, "hold_idempotency_key", lambda event, key: sale)

    with pytest.raises(PosSale.AlreadyRecorded):
        cancel(till, sale.seq)

    assert cancellations(event) == 0


# -- one request at a time asks SumUp for a card's money -------------------------


@pytest.mark.django_db
def test_a_till_waits_for_the_refund_in_hand_rather_than_asking_again(
    monkeypatch, till, event, ticket, reader_till, sumup, real_cache
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    terminal = PosTerminalPayment.objects.get()
    held_by_someone_else(terminal)

    def the_other_request_is_answered(payment):
        # SumUp gave the money back to whoever was asking, which wrote it down
        # and let go.
        PosTerminalPayment.objects.filter(pk=payment.pk).update(refunded=now())
        cache.delete(REFUNDING_KEY.format(payment.pk))
        return True

    monkeypatch.setattr(views, "wait_for_refund", the_other_request_is_answered)

    response = cancel(till, sale["journal_seq"])

    assert response.status_code == 201
    assert response.json()["card_refund"] == "already"
    assert sumup.refunds == []
    # And the till's own refund says the money is back, as it is.
    refund = order_of(event, sale["order"]["code"]).refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_DONE


@pytest.mark.django_db
def test_a_refund_let_go_of_with_nothing_written_is_finished_by_the_till(
    monkeypatch, till, event, ticket, reader_till, sumup, real_cache
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    terminal = PosTerminalPayment.objects.get()
    held_by_someone_else(terminal)

    def let_go(payment):
        cache.delete(REFUNDING_KEY.format(payment.pk))
        return True

    monkeypatch.setattr(views, "wait_for_refund", let_go)

    response = cancel(till, sale["journal_seq"])

    assert response.json()["card_refund"] == "done"
    assert sumup.refunds == [("tx_1", None)]


@pytest.mark.django_db
def test_a_refund_still_in_hand_after_the_wait_is_answered_not_yet(
    monkeypatch, till, event, ticket, reader_till, sumup, real_cache
):
    """
    Never "none": the till would have the amount counted out of the drawer
    while the card may be getting it back. A 5xx, whose key the till keeps, so
    the next press finds out how it went.
    """
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    terminal = PosTerminalPayment.objects.get()
    held_by_someone_else(terminal)
    monkeypatch.setattr(reconcile, "REFUND_WAIT", 0)

    response = cancel(till, sale["journal_seq"], key="cancel-once")

    assert response.status_code == 503
    assert response.json()["code"] == "refund_in_progress"
    assert response["Retry-After"] == "5"
    assert sumup.refunds == []
    # The cancellation itself stands: it was written before SumUp was asked.
    assert cancellations(event) == 1

    cache.delete(REFUNDING_KEY.format(terminal.pk))
    again = cancel(till, sale["journal_seq"], key="cancel-once")

    assert again.status_code == 200
    assert again.json()["card_refund"] == "done"
    assert sumup.refunds == [("tx_1", None)]


@pytest.mark.django_db
def test_a_refund_taken_again_the_moment_it_was_let_go_is_answered_not_yet(
    monkeypatch, till, event, ticket, reader_till, sumup, real_cache
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    held_by_someone_else(PosTerminalPayment.objects.get())
    monkeypatch.setattr(views, "wait_for_refund", lambda payment: True)

    response = cancel(till, sale["journal_seq"])

    assert response.status_code == 503
    assert sumup.refunds == []


@pytest.mark.django_db
def test_a_card_whose_payment_pretix_no_longer_holds_is_still_given_back(
    till, event, ticket, reader_till, sumup
):
    """
    Nothing in pretix to write the refund on — the payment was removed there —
    but the reader took the money, so the card gets it back all the same.
    """
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order_of(event, sale["order"]["code"]).payments.all().delete()

    response = cancel(till, sale["journal_seq"])

    assert response.status_code == 201
    assert response.json()["refunded"] is False
    assert response.json()["card_refund"] == "done"
    assert sumup.refunds == [("tx_1", None)]


@pytest.mark.django_db
def test_a_refund_done_meanwhile_is_never_written_back_as_failed(
    monkeypatch, till, event, ticket, reader_till, sumup
):
    """
    The periodic comparison read SumUp's history while the till was asking,
    and wrote the refund done. What SumUp then told the till — nothing left to
    refund — is about that refund, not a refusal of it.
    """
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])

    def compared_meanwhile(method, url, **kwargs):
        if method == "POST" and url.endswith("/refunds"):
            OrderRefund.objects.filter(order__code=sale["order"]["code"]).update(
                state=OrderRefund.REFUND_STATE_DONE
            )
            return FakeResponse(422, {"message": "Nothing left to refund"})
        return sumup.request(method, url, **kwargs)

    monkeypatch.setattr(sumup_module.requests, "request", compared_meanwhile)

    response = cancel(till, sale["journal_seq"])

    assert response.json()["card_refund"] == "already"
    order = order_of(event, sale["order"]["code"])
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE
    assert not order.all_logentries().filter(action_type="pretix.event.order.refund.failed").exists()


@pytest.mark.django_db
def test_the_periodic_task_leaves_a_refund_in_hand_alone(
    till, event, ticket, reader_till, sumup, real_cache
):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.not_refundable_yet.clear()
    terminal = PosTerminalPayment.objects.get()
    held_by_someone_else(terminal)

    reconcile_all()

    assert sumup.refunds == []
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_TRANSIT

    cache.delete(REFUNDING_KEY.format(terminal.pk))
    done = reconcile_all()

    assert done["asso"]["sent"] == 1
    assert sumup.refunds == [("tx_1", None)]


@pytest.mark.django_db
def test_the_periodic_task_finds_a_refund_just_made_and_sends_nothing(
    monkeypatch, till, event, ticket, reader_till, sumup
):
    """Read again once it holds the payment: whoever held it before may have been given the money."""
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.not_refundable_yet.clear()
    real = reconcile.refund_in_hand

    @contextmanager
    def given_back_just_before(terminal):
        PosTerminalPayment.objects.filter(pk=terminal.pk).update(refunded=now())
        with real(terminal) as mine:
            yield mine

    monkeypatch.setattr(reconcile, "refund_in_hand", given_back_just_before)

    done = reconcile_all()

    assert done["asso"]["given_back"] == 1
    assert sumup.refunds == []
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE


@pytest.mark.django_db
def test_the_refund_dialog_does_not_ask_sumup_while_a_till_does(
    backoffice, till, event, ticket, reader_till, sumup, real_cache
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    held_by_someone_else(PosTerminalPayment.objects.get())

    page = refund_dialog(backoffice, event, order).content.decode()

    assert sumup.refunds == []
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_FAILED
    assert "being refunded through SumUp right now" in page


@pytest.mark.django_db
def test_the_refund_dialog_finding_the_card_given_back_once_it_holds_it_asks_nothing(
    monkeypatch, backoffice, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    real = reconcile.refund_in_hand

    @contextmanager
    def given_back_just_before(terminal):
        PosTerminalPayment.objects.filter(pk=terminal.pk).update(refunded=now())
        with real(terminal) as mine:
            yield mine

    monkeypatch.setattr(reconcile, "refund_in_hand", given_back_just_before)

    page = refund_dialog(backoffice, event, order).content.decode()

    assert sumup.refunds == []
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_FAILED
    assert "already been refunded through SumUp" in page


@pytest.mark.django_db
def test_waiting_for_a_refund_ends_when_it_is_let_go(till, ticket, reader_till, sumup, real_cache):
    card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    terminal = PosTerminalPayment.objects.get()
    held_by_someone_else(terminal)
    letting_go = threading.Timer(0.3, cache.delete, [REFUNDING_KEY.format(terminal.pk)])
    letting_go.start()
    try:
        assert wait_for_refund(terminal) is True
    finally:
        letting_go.cancel()
    assert cache.get(REFUNDING_KEY.format(terminal.pk)) is None


# -- SumUp's 429 ------------------------------------------------------------------


@pytest.mark.django_db
def test_a_poll_sumup_turned_away_is_unanswered_not_failed(till, ticket, reader_till, sumup):
    """
    A busy evening, several tills waiting on cards: exactly when SumUp says it
    is asked too often. The question went unanswered; the payment did not fail.
    """
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.next_response = TOO_MANY

    body = status(till).json()

    assert (body["status"], body["sumup_unreachable"]) == ("pending", True)
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_PENDING


@pytest.mark.django_db
def test_a_payment_sumup_turned_away_never_reached_the_reader(till, ticket, reader_till, sumup):
    # Nothing is on the reader, so it is a refusal, and it says why.
    sumup.next_response = TOO_MANY

    response = start(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_unreachable"
    assert "too many requests" in str(response.json())
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_FAILED


@pytest.mark.django_db
def test_a_till_refund_sumup_turned_away_is_left_waiting(
    till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    sumup.next_response = TOO_MANY

    response = cancel(till, sale["journal_seq"])

    assert response.json()["card_refund"] == "pending"
    refund = order_of(event, sale["order"]["code"]).refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_TRANSIT
    assert refund.info_data["sumup_error"].startswith("429")
    assert sumup.refunds == []


@pytest.mark.django_db
def test_the_periodic_task_keeps_waiting_through_a_429(till, event, ticket, reader_till, sumup):
    _sale, order, _response = waiting_sale(till, sumup, event, ticket)
    sumup.not_refundable_yet.clear()
    sumup.refuse_refunds_with = TOO_MANY

    done = reconcile_all()

    assert done["asso"]["waiting"] == 1
    assert done["asso"]["failed"] == 0
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_TRANSIT

    sumup.refuse_refunds_with = None
    reconcile_all()

    assert sumup.refunds == [("tx_1", None)]
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_DONE


@pytest.mark.django_db
def test_the_refund_dialog_leaves_a_refund_sumup_turned_away_on_its_way(
    backoffice, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.refuse_refunds_with = TOO_MANY

    refund_dialog(backoffice, event, order)

    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_TRANSIT
    assert refund.info_data["sumup_error"].startswith("429")
    assert sumup.refunds == []
