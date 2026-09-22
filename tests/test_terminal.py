"""
A card payment taken by the reader on the counter.

The rule Ad asked for is one sentence — a till with a reader may not record a
card payment that reader did not validate — and everything here is a way of
checking it holds when things go wrong: a till that reloads mid-payment, a
network that dies between asking the reader and hearing back, a forged callback,
a price edited while the customer was getting their card out.

The flow, once, so the tests below read as steps rather than as HTTP:

1. The till posts the basket to ``terminal/start``. The server prices it, keeps
   what it priced, and puts the total on the reader.
2. The cardholder answers, or does not. ``terminal/status`` says which, and it
   is the only thing that ever writes "paid".
3. The till posts the sale to ``checkout`` under the same idempotency key. The
   server finds the payment, books the order from the *pinned* basket, and only
   then is anything in the journal.
"""
from decimal import Decimal
from unittest.mock import patch

import pytest
import requests
from django.db import IntegrityError
from django.utils.timezone import now

from pretix_openpos.models import PosDevice, PosSale, PosTerminalPayment

from .conftest import sell
from .sumup_stub import FakeResponse, reader_busy, reader_offline

KEY = "key-" + "0" * 8


def start(till, positions, key=KEY):
    return till.post("terminal/start", {"idempotency_key": key, "positions": positions})


def status(till, key=KEY):
    return till.get("terminal/status", idempotency_key=key)


def cancel_payment(till, key=KEY):
    return till.post("terminal/cancel", {"idempotency_key": key})


# -- who may ask ------------------------------------------------------------


@pytest.mark.django_db
def test_a_till_with_no_reader_has_nothing_to_drive(till, ticket, sumup):
    response = start(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 400
    assert response.json()["code"] == "no_terminal"


@pytest.mark.django_db
def test_a_door_with_no_reader_is_no_different(till, device, ticket, sumup):
    PosDevice.objects.create(device=device, role=PosDevice.ROLE_DOOR)

    assert start(till, [{"item": ticket.pk, "count": 1}]).status_code == 400


# -- putting a basket on the reader ----------------------------------------


@pytest.mark.django_db
def test_the_basket_goes_on_the_reader_at_the_server_s_price(till, ticket, reader_till, sumup):
    response = start(till, [{"item": ticket.pk, "count": 2}])

    assert response.status_code == 201
    assert response.json()["status"] == "pending"
    assert response.json()["amount"] == "20.00"
    _method, path, body = sumup.calls[-1]
    assert path.endswith(f"/readers/{reader_till}/checkout")
    assert body["total_amount"]["value"] == 2000


@pytest.mark.django_db
def test_the_priced_basket_is_kept_for_the_order_that_follows(till, ticket, reader_till, sumup):
    start(till, [{"item": ticket.pk, "count": 2}])

    payment = PosTerminalPayment.objects.get()
    assert payment.positions == [
        {
            "item": ticket.pk, "variation": None, "count": 2,
            "price": "10.00", "description": "", "refund": False,
        }
    ]


@pytest.mark.django_db
def test_the_payment_is_written_down_before_the_reader_is_asked(till, ticket, reader_till, sumup):
    """
    The order matters: a process that dies between the two leaves a row to be
    settled from SumUp rather than a charge nobody in pretix has heard of.

    And a lost answer leaves that row *open*. The request may have reached
    SumUp and put the amount on the reader; writing a refusal here would send
    the cashier to a fresh basket with a new key while a cardholder is looking
    at a live prompt.
    """
    sumup.next_exception = requests.ConnectTimeout("no route")

    response = start(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_unsure"
    payment = PosTerminalPayment.objects.get()
    assert payment.status == PosTerminalPayment.STATUS_PENDING
    assert payment.client_transaction_id == ""


@pytest.mark.django_db
def test_an_unsure_start_is_not_settled_by_guesswork(till, ticket, reader_till, sumup):
    """
    A row with no handle cannot be asked about, and "we never got an answer"
    must not quietly become "not paid" on the next poll.
    """
    sumup.next_exception = requests.ConnectTimeout("no route")
    start(till, [{"item": ticket.pk, "count": 1}])
    key = PosTerminalPayment.objects.get().idempotency_key

    response = status(till, key)

    assert response.status_code == 200
    assert response.json()["status"] == PosTerminalPayment.STATUS_PENDING
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_PENDING


@pytest.mark.django_db
def test_a_refusal_from_sumup_is_still_written_down(till, ticket, reader_till, sumup):
    """
    The other half of the rule: an answer that says no is an answer, and the
    row closes on it rather than staying open for ever.
    """
    sumup.next_response = FakeResponse(400, {"message": "reader says no"})

    response = start(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_unreachable"
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_FAILED


@pytest.mark.django_db
def test_a_reader_that_is_off_is_named_to_the_cashier(till, ticket, reader_till, sumup):
    """
    "SumUp refused this request" used to be all a volunteer got, for the most
    ordinary refusal there is. Nothing reached the reader, so the row closes and
    the till is free to try again, or to take cash.
    """
    sumup.next_response = reader_offline()

    response = start(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_unreachable"
    assert "offline" in response.json()["detail"][0]
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_FAILED


@pytest.mark.django_db
def test_a_reader_still_holding_the_last_request_is_named_too(till, ticket, reader_till, sumup):
    # SumUp holds a reader for a minute after every request it accepts: a
    # payment stopped and restarted at once is refused, and the cashier is
    # told to give it that minute rather than that the card was declined.
    sumup.next_response = reader_busy()

    response = start(till, [{"item": ticket.pk, "count": 1}])

    assert response.json()["code"] == "terminal_unreachable"
    assert "previous request" in response.json()["detail"][0]
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_FAILED


@pytest.mark.django_db
def test_the_request_put_on_the_reader_is_kept(till, ticket, reader_till, sumup):
    start(till, [{"item": ticket.pk, "count": 1}])

    payment = PosTerminalPayment.objects.get()
    assert payment.checkout_id in sumup.checkouts


@pytest.mark.django_db
def test_a_second_tap_finds_the_payment_already_running(till, ticket, reader_till, sumup):
    """
    SumUp's reader checkout has no idempotency key of its own, so this is the
    only thing between a double tap and a double charge.
    """
    start(till, [{"item": ticket.pk, "count": 1}])

    again = start(till, [{"item": ticket.pk, "count": 1}])

    assert again.status_code == 200
    assert PosTerminalPayment.objects.count() == 1
    assert len([p for p in sumup.call_paths("POST") if p.endswith("/checkout")]) == 1


@pytest.mark.django_db
def test_a_basket_that_pays_money_out_is_refused_before_anyone_waits(
    till, deposit, reader_till, sumup
):
    """
    SumUp only refunds against a transaction of its own, so there is no way to
    send money to a card that nothing stands behind. Saying so here beats a
    reader sitting waiting for a card that can never settle it.
    """
    response = start(till, [{"item": deposit.pk, "count": 1, "refund": True}])

    assert response.status_code == 400
    assert response.json()["code"] == "nothing_to_charge"
    assert sumup.started == []


@pytest.mark.django_db
def test_a_sold_out_product_does_not_reach_a_cardholder(till, ticket, reader_till, sumup):
    quota = ticket.quotas.first()
    quota.size = 0
    quota.save()

    response = start(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 400
    assert response.json()["code"] == "sold_out"
    assert sumup.started == []


@pytest.mark.django_db
def test_a_product_that_is_not_on_sale_here_is_refused(till, event, ticket, reader_till, sumup):
    ticket.all_sales_channels = False
    ticket.limit_sales_channels.clear()
    ticket.save()

    assert start(till, [{"item": ticket.pk, "count": 1}]).status_code == 400
    assert sumup.started == []


# -- waiting for the cardholder --------------------------------------------


@pytest.mark.django_db
def test_a_payment_nobody_has_answered_is_still_pending(till, ticket, reader_till, sumup):
    start(till, [{"item": ticket.pk, "count": 1}])

    assert status(till).json()["status"] == "pending"


@pytest.mark.django_db
def test_the_card_going_through_is_the_only_thing_that_writes_paid(
    till, ticket, reader_till, sumup
):
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.pay()

    assert status(till).json()["status"] == "successful"
    assert PosTerminalPayment.objects.get().transaction_id == "tx_1"


@pytest.mark.django_db
def test_a_refused_card_is_reported_with_sumup_s_own_word_for_it(
    till, ticket, reader_till, sumup
):
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.pay(status="FAILED")

    body = status(till).json()
    assert body["status"] == "failed"
    assert body["failure"] == "FAILED"


@pytest.mark.django_db
def test_not_being_able_to_ask_sumup_writes_nothing(till, ticket, reader_till, sumup):
    """
    The distinction the whole flow rests on. Writing "failed" here would lose a
    payment that went through while a cable was out: money taken, no sale, and
    nothing to point at.
    """
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.next_exception = requests.ConnectTimeout("no route")

    assert status(till).json()["status"] == "pending"
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_PENDING


@pytest.mark.django_db
def test_sumup_refusing_the_key_ends_the_wait(till, ticket, reader_till, sumup):
    """A key that has been revoked will not start working on the next poll."""
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.next_response = FakeResponse(401, {"message": "nope"})

    assert status(till).json()["status"] == "failed"


@pytest.mark.django_db
def test_a_settled_payment_is_not_asked_about_again(till, ticket, reader_till, sumup):
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.pay()
    status(till)
    before = len(sumup.calls)

    status(till)

    assert len(sumup.calls) == before


@pytest.mark.django_db
def test_a_customer_who_walks_away_ends_the_wait(till, ticket, reader_till, sumup):
    """
    No card was presented, so the Transactions API has nothing and never will.
    The request on the reader is what says it is over — it expires by itself —
    and without asking it the till went on waiting for a card that was never
    coming, card payments held on the reader behind it.
    """
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.walk_away()

    body = status(till).json()

    assert body["status"] == "failed"
    # In the Transactions API's own case, which the till turns into a sentence.
    assert body["failure"] == "CANCELLED"


@pytest.mark.django_db
def test_a_request_the_reader_calls_failed_ends_the_wait_too(till, ticket, reader_till, sumup):
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.walk_away(status="failed")

    assert status(till).json()["failure"] == "FAILED"


@pytest.mark.django_db
def test_the_reader_saying_paid_is_not_enough_to_write_paid(till, ticket, reader_till, sumup):
    """
    Only the transaction carries the id a refund will need, so a request the
    reader calls successful waits for its transaction to show.
    """
    start(till, [{"item": ticket.pk, "count": 1}])
    payment = PosTerminalPayment.objects.get()
    sumup.checkouts[payment.checkout_id]["status"] = "successful"

    assert status(till).json()["status"] == "pending"


@pytest.mark.django_db
def test_a_card_answered_after_all_wins_over_the_reader_s_request(
    till, ticket, reader_till, sumup
):
    # The transaction is asked first, and it is what the money did.
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.walk_away()
    sumup.pay()

    assert status(till).json()["status"] == "successful"


@pytest.mark.django_db
def test_a_request_the_reader_cannot_find_changes_nothing(till, ticket, reader_till, sumup):
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.checkouts.clear()

    assert status(till).json()["status"] == "pending"


@pytest.mark.django_db
def test_a_payment_from_before_the_request_was_kept_settles_as_it_always_did(
    till, ticket, reader_till, sumup
):
    """Rows written by an earlier version have no request to ask about."""
    start(till, [{"item": ticket.pk, "count": 1}])
    PosTerminalPayment.objects.update(checkout_id="")
    sumup.walk_away()

    assert status(till).json()["status"] == "pending"
    assert not [p for p in sumup.call_paths("GET") if "/checkout/" in p]


@pytest.mark.django_db
def test_asking_about_a_basket_nobody_started_is_refused(till, reader_till, sumup):
    response = status(till)

    assert response.status_code == 400
    assert response.json()["code"] == "no_payment"


# -- taking it back off ----------------------------------------------------


@pytest.mark.django_db
def test_giving_up_takes_the_amount_off_the_reader(till, ticket, reader_till, sumup):
    start(till, [{"item": ticket.pk, "count": 1}])

    response = cancel_payment(till)

    assert response.status_code == 200
    assert any(path.endswith("/terminate") for path in sumup.call_paths("POST"))


@pytest.mark.django_db
def test_stopping_frees_the_till_once_the_reader_has_obeyed(till, ticket, reader_till, sumup):
    """
    The cashier presses stop, the customer pays cash. The reader obeys in its
    own time, so straight after the stop the payment is still waiting — and the
    next poll finds it over, rather than the till staying stuck on it.
    """
    start(till, [{"item": ticket.pk, "count": 1}])

    assert cancel_payment(till).json()["status"] == "pending"
    sumup.walk_away(status="failed")

    assert status(till).json()["status"] == "failed"


@pytest.mark.django_db
def test_a_card_tapped_in_the_same_second_is_still_a_payment(till, ticket, reader_till, sumup):
    """
    The reader only obeys a terminate while it is still waiting. What comes
    back is what happened, not what was asked for — a till told otherwise would
    send the customer away having paid.
    """
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.pay()

    assert cancel_payment(till).json()["status"] == "successful"


@pytest.mark.django_db
def test_cancelling_a_payment_that_is_already_done_does_not_ask_the_reader(
    till, ticket, reader_till, sumup
):
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.pay()
    status(till)

    cancel_payment(till)

    assert not any(path.endswith("/terminate") for path in sumup.call_paths("POST"))


@pytest.mark.django_db
def test_a_reader_that_will_not_be_terminated_is_asked_about_anyway(
    till, ticket, reader_till, sumup
):
    """Already finished, already gone, or unreachable: the answer settles all three."""
    start(till, [{"item": ticket.pk, "count": 1}])
    sumup.next_response = FakeResponse(500, {"message": "down"})

    assert cancel_payment(till).status_code == 200


@pytest.mark.django_db
def test_cancelling_a_basket_nobody_started_is_refused(till, reader_till, sumup):
    assert cancel_payment(till).json()["code"] == "no_payment"


# -- and then the sale ------------------------------------------------------


def take_payment(till, positions, key=KEY, sumup=None):
    """Put a basket on the reader and have the cardholder pay for it."""
    start(till, positions, key=key)
    sumup.pay()
    status(till, key=key)


@pytest.mark.django_db
def test_the_sale_is_recorded_once_the_reader_has_validated_it(
    till, ticket, reader_till, sumup
):
    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)

    response = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    )

    assert response.status_code == 201
    assert PosSale.objects.get().payment_type == PosSale.PAYMENT_CARD


@pytest.mark.django_db
def test_the_order_is_built_from_what_the_card_paid_for(
    till, event, ticket, reader_till, sumup
):
    """
    A price edited while the customer was getting their card out must not make
    the order disagree with the charge. The basket is the one that was priced
    when the reader was asked, whatever the catalogue says now.
    """
    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    ticket.default_price = 25
    ticket.save()

    response = sell(
        till,
        [{"item": ticket.pk, "count": 1}],
        payment_type="card",
        idempotency_key=KEY,
        expected_total="10.00",
    )

    assert response.status_code == 201
    assert response.json()["order"]["total"] == "10.00"


@pytest.mark.django_db
def test_a_sale_the_app_sends_differently_is_booked_from_the_pinned_basket(
    till, ticket, beer, reader_till, sumup
):
    """
    An app that sends one basket to the reader and another to the journal gets
    the first one booked. The card is what the customer agreed to.
    """
    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)

    response = sell(
        till, [{"item": beer.pk, "count": 5}], payment_type="card", idempotency_key=KEY
    )

    assert response.status_code == 201
    positions = PosSale.objects.get().positions
    assert [p["item"] for p in positions] == [ticket.pk]


@pytest.mark.django_db
def test_a_pending_payment_does_not_let_a_sale_through(till, ticket, reader_till, sumup):
    start(till, [{"item": ticket.pk, "count": 1}])

    response = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    )

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_required"
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_another_till_s_payment_does_not_let_this_one_sell(
    till, another_till, ticket, device, reader_till, sumup
):
    """
    The key is the app's, so a second till could in principle send the same
    one. The payment names the device that took it, and that is checked.
    """
    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    PosDevice.objects.create(
        device=another_till.device,
        role=PosDevice.ROLE_TILL,
        sumup_reader_id=sumup.add_reader("rdr_TWO"),
    )

    response = sell(
        another_till,
        [{"item": ticket.pk, "count": 1}],
        payment_type="card",
        idempotency_key=KEY,
    )

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_required"


@pytest.mark.django_db
def test_a_cash_sale_on_the_same_till_needs_no_reader(till, ticket, reader_till, sumup):
    response = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="cash", cash_given="10.00"
    )

    assert response.status_code == 201


# -- the callback from SumUp ------------------------------------------------


def callback_url(organizer):
    from pretix_openpos.webhook import webhook_token

    return f"/openpos/sumup/{organizer.slug}/{webhook_token(organizer)}/"


@pytest.mark.django_db
def test_a_callback_makes_the_server_go_and_ask(client, organizer, till, ticket, reader_till, sumup):
    """
    Which is the whole of what it does. The callback carries no signature, so
    it is a nudge and the Transactions API is the evidence.
    """
    start(till, [{"item": ticket.pk, "count": 1}])
    client_transaction_id = sumup.pay()

    response = client.post(
        callback_url(organizer),
        data={"payload": {"client_transaction_id": client_transaction_id}},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_SUCCESSFUL


@pytest.mark.django_db
def test_a_forged_callback_cannot_make_a_payment_succeed(
    client, organizer, till, ticket, reader_till, sumup
):
    """The one thing that matters here: saying "successful" is not evidence."""
    start(till, [{"item": ticket.pk, "count": 1}])
    client_transaction_id = sumup.started[0]

    client.post(
        callback_url(organizer),
        data={
            "payload": {"client_transaction_id": client_transaction_id, "status": "successful"}
        },
        content_type="application/json",
    )

    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_PENDING


@pytest.mark.django_db
def test_a_callback_with_the_wrong_token_is_not_found(client, organizer):
    response = client.post(
        f"/openpos/sumup/{organizer.slug}/not-the-token/",
        data={"payload": {"client_transaction_id": "ctx_1"}},
        content_type="application/json",
    )

    assert response.status_code == 404


@pytest.mark.django_db
def test_a_callback_for_an_organizer_that_does_not_exist_is_not_found(client):
    response = client.post(
        "/openpos/sumup/nobody/whatever/",
        data={"payload": {"client_transaction_id": "ctx_1"}},
        content_type="application/json",
    )

    assert response.status_code == 404


@pytest.mark.django_db
def test_a_callback_that_is_not_json_is_refused(client, organizer):
    response = client.post(
        callback_url(organizer), data="not json", content_type="application/json"
    )

    assert response.status_code == 400


@pytest.mark.django_db
def test_a_callback_naming_no_transaction_is_refused(client, organizer):
    response = client.post(
        callback_url(organizer), data={"payload": {}}, content_type="application/json"
    )

    assert response.status_code == 400


@pytest.mark.django_db
def test_a_callback_for_a_payment_of_another_organizer_is_answered_and_dropped(
    client, organizer, till, ticket, reader_till, sumup
):
    """
    200 rather than 404: SumUp retries anything else up to five times, and
    there is nothing to retry about a payment this organizer does not have.
    """
    start(till, [{"item": ticket.pk, "count": 1}])

    response = client.post(
        callback_url(organizer),
        data={"payload": {"client_transaction_id": "ctx_somebody_else"}},
        content_type="application/json",
    )

    assert response.status_code == 200
    assert PosTerminalPayment.objects.get().status == PosTerminalPayment.STATUS_PENDING


@pytest.mark.django_db
def test_the_callback_address_is_only_offered_over_https(organizer, settings):
    from pretix_openpos.webhook import webhook_url

    settings.SITE_URL = "http://localhost:8000"
    assert webhook_url(organizer) is None

    settings.SITE_URL = "https://pretix.example.org"
    assert webhook_url(organizer).startswith("https://pretix.example.org/openpos/sumup/")


@pytest.mark.django_db
def test_the_token_is_minted_once_and_kept(organizer):
    from pretix_openpos.webhook import webhook_token

    assert webhook_token(organizer) == webhook_token(organizer)


# -- giving the money back --------------------------------------------------


@pytest.mark.django_db
def test_cancelling_a_reader_sale_refunds_the_card(till, ticket, reader_till, sumup):
    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    ).json()

    response = till.post(
        "cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"}
    )

    assert response.json()["card_refund"] == "done"
    assert sumup.refunds == [("tx_1", None)]
    assert PosTerminalPayment.objects.get().refunded is not None


@pytest.mark.django_db
def test_a_retried_cancellation_does_not_refund_twice(till, ticket, reader_till, sumup):
    """
    The till retries under the same key when an answer goes missing. The
    cancellation is handed back as it stands, and so is the refund — sending
    the money a second time is the failure mode this guards.
    """
    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    ).json()
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})

    again = till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})

    assert again.status_code == 200
    assert again.json()["card_refund"] == "already"
    assert len(sumup.refunds) == 1


@pytest.mark.django_db
def test_a_retry_finishes_a_refund_the_first_attempt_did_not_reach(
    till, ticket, reader_till, sumup
):
    """
    The cancellation commits, then the connection dies before SumUp is asked.
    Nothing else would ever go back and do it, so the retry does.
    """
    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    ).json()
    sumup.next_exception = requests.ConnectTimeout("no route")
    first = till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})
    assert first.json()["card_refund"] == "failed"

    again = till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})

    assert again.json()["card_refund"] == "done"
    assert sumup.refunds == [("tx_1", None)]


@pytest.mark.django_db
def test_a_refund_sumup_refuses_is_said_plainly(till, ticket, reader_till, sumup):
    """
    The money is still on the customer's card. A cancellation that looks
    complete is the one thing nobody finds out about until the customer does.
    """
    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    ).json()
    sumup.next_response = FakeResponse(422, {"message": "too late"})

    response = till.post(
        "cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"}
    )

    assert response.json()["card_refund"] == "failed"
    assert PosTerminalPayment.objects.get().refunded is None


@pytest.mark.django_db
def test_a_refused_refund_leaves_pretix_saying_the_money_is_still_out(
    till, event, ticket, reader_till, sumup
):
    """
    The hole this closes. pretix used to mark the refund *done* before SumUp had
    been asked at all, so a refusal left the order page showing a completed
    refund while the amount was still on the customer's card. The books and the
    customer then disagree and nothing on the server records which is right —
    the only witness is a volunteer at a bar who saw a red banner an hour ago.
    """
    from pretix.base.models.orders import OrderRefund

    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    ).json()
    sumup.next_response = FakeResponse(422, {"message": "too late"})

    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})

    refund = OrderRefund.objects.get(order__event=event)
    assert refund.state == OrderRefund.REFUND_STATE_FAILED
    # And the order still counts the payment as taken, which is the truth.
    assert refund.payment.state != "refunded"


@pytest.mark.django_db
def test_a_refund_that_goes_through_is_marked_done(till, event, ticket, reader_till, sumup):
    from pretix.base.models.orders import OrderRefund

    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    ).json()

    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})

    assert OrderRefund.objects.get(order__event=event).state == (
        OrderRefund.REFUND_STATE_DONE
    )


@pytest.mark.django_db
def test_a_retry_that_gets_the_money_back_clears_the_failed_refund(
    till, event, ticket, reader_till, sumup
):
    # Otherwise the order page keeps saying the customer was never paid back,
    # long after they were.
    from pretix.base.models.orders import OrderRefund

    take_payment(till, [{"item": ticket.pk, "count": 1}], sumup=sumup)
    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card", idempotency_key=KEY
    ).json()
    sumup.next_exception = requests.ConnectTimeout("no route")
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})
    assert OrderRefund.objects.get(order__event=event).state == (
        OrderRefund.REFUND_STATE_FAILED
    )

    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})

    assert OrderRefund.objects.get(order__event=event).state == (
        OrderRefund.REFUND_STATE_DONE
    )


@pytest.mark.django_db
def test_a_cash_refund_is_done_the_moment_it_is_recorded(till, event, ticket):
    # No reader is asked, so there is nothing to wait for: the money left the
    # drawer while the customer was standing there. Making this one provisional
    # too would leave every cash cancellation looking unfinished for ever.
    from pretix.base.models.orders import OrderRefund

    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="cash", cash_given="10.00"
    ).json()

    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})

    assert OrderRefund.objects.get(order__event=event).state == (
        OrderRefund.REFUND_STATE_DONE
    )


@pytest.mark.django_db
def test_a_card_taken_on_a_phone_is_done_straight_away_too(till, event, ticket):
    # Declared card, no reader on this till: the operator refunded it themselves
    # in the card provider's app. This server has nothing to ask and nothing to
    # wait for.
    from pretix.base.models.orders import OrderRefund

    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card"
    ).json()

    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"})

    assert OrderRefund.objects.get(order__event=event).state == (
        OrderRefund.REFUND_STATE_DONE
    )


@pytest.mark.django_db
def test_a_cash_sale_has_no_card_to_refund(till, ticket, reader_till, sumup):
    sale = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="cash", cash_given="10.00"
    ).json()

    response = till.post(
        "cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"}
    )

    assert response.json()["card_refund"] == "none"
    assert sumup.refunds == []


@pytest.mark.django_db
def test_a_card_taken_on_somebody_s_phone_is_refunded_the_way_it_was_taken(
    till, ticket, sumup
):
    """No reader drove it, so this server has nothing to give back."""
    sale = sell(till, [{"item": ticket.pk, "count": 1}], payment_type="card").json()

    response = till.post(
        "cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-1"}
    )

    assert response.json()["card_refund"] == "none"


@pytest.mark.django_db
def test_a_payment_names_itself_by_its_key_and_state(till, ticket, reader_till, sumup):
    """What a support call asks for, and what the admin lists show."""
    start(till, [{"item": ticket.pk, "count": 1}])

    assert str(PosTerminalPayment.objects.get()) == f"{KEY} 10.00 pending"


@pytest.mark.django_db
def test_two_taps_in_the_same_second_charge_one_card(till, ticket, reader_till, sumup):
    """
    Both requests look for a payment, both find none, and the unique key lets
    one through. The loser takes the winner's payment rather than faulting.
    """
    from pretix_openpos.models import PosTerminalPayment as Model

    real_create = Model.objects.create
    state = {"first": True}

    def racing_create(**kwargs):
        if state["first"]:
            state["first"] = False
            # The other request got there between the look-up and this line.
            real_create(**kwargs)
            raise IntegrityError("duplicate key")
        return real_create(**kwargs)

    with patch.object(Model.objects, "create", side_effect=racing_create):
        response = start(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 200
    assert PosTerminalPayment.objects.count() == 1


@pytest.mark.django_db
def test_a_payment_naming_no_till_belongs_to_none(till, ticket, reader_till, sumup, device):
    """
    The check that stops one device booking a sale against another's card
    payment. Two blanks matching would be the wrong way for it to fail.
    """
    start(till, [{"item": ticket.pk, "count": 1}])
    payment = PosTerminalPayment.objects.get()
    payment.device_serial = ""

    assert payment.belongs_to(device) is False
    assert payment.belongs_to(None) is False


@pytest.mark.django_db
def test_a_write_that_fails_for_another_reason_is_still_a_failure(
    till, ticket, reader_till, sumup
):
    """
    The catch above is for the duplicate key and nothing else. Anything else
    answering 200 would tell a till a payment is running when none is.
    """
    from pretix_openpos.models import PosTerminalPayment as Model

    with patch.object(Model.objects, "create", side_effect=IntegrityError("something else")):
        with pytest.raises(IntegrityError):
            start(till, [{"item": ticket.pk, "count": 1}])

    assert not PosTerminalPayment.objects.exists()


# -- two tills, one reader --------------------------------------------------
#
# A bar with two tablets and one machine between them. Allowed, and safe only
# because the server takes turns for them: SumUp's reader checkout refuses the
# *second* call, by which time a payment row has been written and a till's
# idempotency key has been spent on a basket that never reached the reader.


@pytest.fixture
def shared_reader(device, another_till, sumup):
    """One reader, given to both tills."""
    reader_id = sumup.add_reader()
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id=reader_id
    )
    PosDevice.objects.create(
        device=another_till.device, role=PosDevice.ROLE_TILL, sumup_reader_id=reader_id
    )
    return reader_id


@pytest.mark.django_db
def test_a_second_till_cannot_put_a_basket_on_a_busy_reader(
    till, another_till, ticket, shared_reader, sumup
):
    start(till, [{"item": ticket.pk, "count": 1}], key="premiere-01")

    response = start(another_till, [{"item": ticket.pk, "count": 1}], key="seconde-01")

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_busy"


@pytest.mark.django_db
def test_the_refused_till_is_left_with_nothing_written_down(
    till, another_till, event, ticket, shared_reader, sumup
):
    """
    The point of refusing here rather than letting SumUp refuse. Nothing was
    put on the reader, so nothing may be recorded as having been: a payment row
    would spend this till's key on a basket no cardholder ever saw, and the
    cashier would be holding a key they cannot use again.
    """
    start(till, [{"item": ticket.pk, "count": 1}], key="premiere-01")

    start(another_till, [{"item": ticket.pk, "count": 1}], key="seconde-01")

    assert not PosTerminalPayment.objects.filter(idempotency_key="seconde-01").exists()
    # And SumUp was never asked to put a second amount on the machine.
    assert len([p for p in sumup.call_paths("POST") if p.endswith("/checkout")]) == 1


@pytest.mark.django_db
def test_the_other_till_can_still_sell_for_cash(
    till, another_till, event, ticket, shared_reader, sumup
):
    # The whole point of blocking rather than breaking: one machine is busy,
    # the bar is not.
    start(till, [{"item": ticket.pk, "count": 1}], key="premiere-01")

    response = sell(
        another_till, [{"item": ticket.pk, "count": 1}], idempotency_key="liquide-01"
    )

    assert response.status_code == 201
    assert PosSale.objects.filter(idempotency_key="liquide-01").exists()


@pytest.mark.django_db
def test_the_reader_frees_up_the_moment_the_first_payment_lands(
    till, another_till, ticket, shared_reader, sumup
):
    start(till, [{"item": ticket.pk, "count": 1}], key="premiere-01")
    payment = PosTerminalPayment.objects.get(idempotency_key="premiere-01")
    sumup.pay(payment.client_transaction_id, transaction_id="tx_1")

    # Asked, not assumed: the row still reads pending because nobody on the
    # first till has polled since. That must not hold the machine.
    response = start(another_till, [{"item": ticket.pk, "count": 1}], key="seconde-01")

    assert response.status_code == 201


@pytest.mark.django_db
def test_a_refused_card_does_not_hold_the_reader_either(
    till, another_till, ticket, shared_reader, sumup
):
    start(till, [{"item": ticket.pk, "count": 1}], key="premiere-01")
    payment = PosTerminalPayment.objects.get(idempotency_key="premiere-01")
    sumup.pay(payment.client_transaction_id, transaction_id="tx_1", status="FAILED")

    assert start(
        another_till, [{"item": ticket.pk, "count": 1}], key="seconde-01"
    ).status_code == 201


@pytest.mark.django_db
def test_a_basket_that_ended_unpaid_frees_the_shared_reader_at_once(
    till, another_till, ticket, shared_reader, sumup
):
    """
    Not five minutes later. The other till asks what became of the payment
    holding the machine, and the reader's own record says it is over.
    """
    start(till, [{"item": ticket.pk, "count": 1}], key="premiere-01")
    payment = PosTerminalPayment.objects.get(idempotency_key="premiere-01")
    sumup.walk_away(payment.client_transaction_id)

    response = start(another_till, [{"item": ticket.pk, "count": 1}], key="seconde-01")

    assert response.status_code == 201


@pytest.mark.django_db
def test_a_basket_nobody_ever_answered_stops_holding_the_reader(
    till, another_till, ticket, shared_reader, sumup
):
    """
    The failure this must not have. A payment left pending — a till that went
    flat with a prompt up — would otherwise take card off the bar for the rest
    of the evening, with nobody able to say why. Long past any customer still
    standing there, the machine is cleared and the next basket goes on.
    """
    from pretix_openpos.api.views import READER_HELD_FOR

    start(till, [{"item": ticket.pk, "count": 1}], key="abandonnee-01")
    PosTerminalPayment.objects.filter(idempotency_key="abandonnee-01").update(
        created=now() - READER_HELD_FOR * 2
    )

    response = start(another_till, [{"item": ticket.pk, "count": 1}], key="seconde-01")

    assert response.status_code == 201
    # Cleared first, or SumUp refuses the checkout and the cashier is left
    # looking at a machine that says nothing.
    assert [p for p in sumup.call_paths("POST") if p.endswith("/terminate")]


@pytest.mark.django_db
def test_the_abandoned_payment_is_not_written_off_by_the_till_that_took_over(
    till, another_till, ticket, shared_reader, sumup
):
    # Clearing a screen says nothing about whether a card was charged. Only
    # SumUp's own transaction does, and that is what settling asks — so the
    # row stays open for the back office rather than being guessed at here.
    from pretix_openpos.api.views import READER_HELD_FOR

    start(till, [{"item": ticket.pk, "count": 1}], key="abandonnee-01")
    PosTerminalPayment.objects.filter(idempotency_key="abandonnee-01").update(
        created=now() - READER_HELD_FOR * 2
    )

    start(another_till, [{"item": ticket.pk, "count": 1}], key="seconde-01")

    held = PosTerminalPayment.objects.get(idempotency_key="abandonnee-01")
    assert held.status == PosTerminalPayment.STATUS_PENDING


@pytest.mark.django_db
def test_a_till_retrying_its_own_basket_is_not_blocked_by_itself(
    till, ticket, reader_till, sumup
):
    # The replay path: same key, same basket. It must come back as the same
    # payment rather than as "the reader is busy" — which it would, since the
    # payment holding the reader is this one.
    first = start(till, [{"item": ticket.pk, "count": 1}], key="meme-cle-01")
    second = start(till, [{"item": ticket.pk, "count": 1}], key="meme-cle-01")

    assert (first.status_code, second.status_code) == (201, 200)
    assert PosTerminalPayment.objects.filter(idempotency_key="meme-cle-01").count() == 1


@pytest.mark.django_db
def test_a_reader_on_one_till_only_is_unaffected(till, ticket, reader_till, sumup):
    # The ordinary case, and the one that must not have grown a lookup that
    # refuses it: nothing else is on this machine.
    assert start(till, [{"item": ticket.pk, "count": 1}]).status_code == 201


@pytest.mark.django_db
def test_a_payment_on_a_different_reader_does_not_block_this_one(
    till, another_till, event, ticket, sumup
):
    first_reader = sumup.add_reader("rdr_BAR")
    second_reader = sumup.add_reader("rdr_ENTREE")
    PosDevice.objects.create(
        device=till.device, role=PosDevice.ROLE_TILL, sumup_reader_id=first_reader
    )
    PosDevice.objects.create(
        device=another_till.device, role=PosDevice.ROLE_TILL, sumup_reader_id=second_reader
    )
    start(till, [{"item": ticket.pk, "count": 1}], key="bar-01")

    assert start(
        another_till, [{"item": ticket.pk, "count": 1}], key="entree-01"
    ).status_code == 201


# -- a card basket with deposits handed back --------------------------------

@pytest.mark.django_db
def test_a_card_basket_with_deposits_books_what_the_card_paid(
    till, event, beer, deposit, reader_till, sumup
):
    """
    The one the review ranked first, and the one that could not be checked
    until the reader existed. Four beers at twelve, three cups back at three:
    the reader takes nine, and pretix has to agree with SumUp about that, or
    the card takings never reconcile against the transfer.
    """
    from pretix.base.models import Order

    basket = [
        {"item": beer.pk, "count": 4},
        {"item": deposit.pk, "count": 3, "refund": True},
    ]
    assert start(till, basket).json()["amount"] == "9.00"
    sumup.pay()
    status(till)

    body = sell(till, basket, payment_type="card", idempotency_key=KEY).json()

    order = Order.objects.get(event=event, code=body["order"]["code"])
    # Nine on the card, nine on the order, nine on the payment. It used to be
    # nine on the card and twelve on both of the others.
    assert order.total == Decimal("9.00")
    assert [(p.provider, p.amount) for p in order.payments.all()] == [
        ("openpos_card", Decimal("9.00"))
    ]
    # The beer is still twelve euros of beer; the deposit is a line beside it.
    assert sum(p.price for p in order.positions.all()) == Decimal("12.00")
    assert [f.value for f in order.fees.all()] == [Decimal("-3.00")]


@pytest.mark.django_db
def test_cancelling_such_a_sale_gives_back_what_the_card_took(
    till, event, beer, deposit, reader_till, sumup
):
    """
    The second half of the same fault. pretix used to record a refund of
    twelve; SumUp can only refund its own transaction, which was nine. The
    till then said "already refunded, nothing to hand over" and the customer
    left three euros short of their cups.
    """
    from pretix.base.models import Order

    basket = [
        {"item": beer.pk, "count": 4},
        {"item": deposit.pk, "count": 3, "refund": True},
    ]
    start(till, basket)
    sumup.pay()
    status(till)
    body = sell(till, basket, payment_type="card", idempotency_key=KEY).json()

    response = till.post(
        "cancel",
        {"seq": body["journal_seq"], "idempotency_key": "annule-01", "reason": "erreur"},
    )

    assert response.status_code == 201
    order = Order.objects.get(event=event, code=body["order"]["code"])
    assert [(r.amount, r.state) for r in order.refunds.all()] == [
        (Decimal("9.00"), "done")
    ]
    # And SumUp gave back its own transaction, which is the same nine. No
    # amount is named on purpose: the transaction's figure is the authority on
    # what the card was charged, and it is not what the beer came to.
    assert sumup.refunds == [("tx_1", None)]
