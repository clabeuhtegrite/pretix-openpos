"""
The one module that talks to SumUp.

What is checked here is not the happy path — that is covered by the endpoints
that use it — but the shape of a failure. "The reader said no", "we could not
reach SumUp" and "SumUp refused the key" lead to three different things
happening in front of a customer, and the difference is decided here.
"""
from decimal import Decimal

import pytest
import requests

from pretix_openpos.sumup import (
    ERR_BUSY, ERR_CONFLICT, ERR_NOT_FOUND, ERR_OFFLINE, ERR_REFUSED, ERR_UNAVAILABLE, SumUpAccount, SumUpError,
    given_back, minor_units, still_running, succeeded,
)

from .sumup_stub import NOT_REFUNDABLE, FakeResponse, reader_busy, reader_offline


@pytest.fixture
def account(organizer, sumup):
    return SumUpAccount(organizer)


# -- money ------------------------------------------------------------------


@pytest.mark.parametrize(
    "amount,expected",
    [
        (Decimal("10.00"), 1000),
        (Decimal("20.15"), 2015),
        (Decimal("0.05"), 5),
        (Decimal("1234.56"), 123456),
    ],
)
def test_an_amount_becomes_the_integer_sumup_wants(amount, expected):
    assert minor_units(amount) == expected


def test_a_price_is_quantised_rather_than_truncated():
    """
    The bug this exists to stop: 20.15 as a binary float is 20.149999…, and
    int() of that is a cent short on somebody's card.
    """
    assert minor_units(Decimal("20.15")) == 2015
    assert minor_units(Decimal("20.154")) == 2015
    assert minor_units(Decimal("20.155")) == 2016


# -- what a transaction means -----------------------------------------------


@pytest.mark.parametrize("status", ["SUCCESSFUL", "PAID_OUT"])
def test_a_paid_transaction_is_one_the_money_moved_on(status):
    assert succeeded({"status": status}) is True


@pytest.mark.parametrize("status", ["FAILED", "CANCELLED", "PENDING", "REFUNDED"])
def test_nothing_else_is(status):
    """
    ``REFUNDED`` in particular: the money moved and then moved back, and a sale
    booked against it would be a sale nobody paid for.
    """
    assert succeeded({"status": status}) is False


def test_a_transaction_that_does_not_exist_yet_is_still_running():
    """The cardholder has not answered the reader. That is not a refusal."""
    assert still_running(None) is True
    assert still_running({"status": "PENDING"}) is True
    assert still_running({"status": "FAILED"}) is False


# -- the credentials --------------------------------------------------------


@pytest.mark.django_db
def test_an_organizer_with_no_credentials_is_not_configured(organizer):
    assert SumUpAccount(organizer).configured is False


@pytest.mark.django_db
def test_half_configured_is_not_configured(organizer):
    organizer.settings.set("openpos_sumup_merchant_code", "MERCH1")

    assert SumUpAccount(organizer).configured is False


@pytest.mark.django_db
def test_an_unconfigured_account_refuses_before_it_reaches_the_network(organizer):
    with pytest.raises(SumUpError) as caught:
        SumUpAccount(organizer).readers()

    assert "not set up" in str(caught.value.message)


@pytest.mark.django_db
def test_the_api_key_travels_in_the_header_and_nowhere_else(account, sumup, monkeypatch):
    seen = {}

    def capture(method, url, **kwargs):
        seen.update(kwargs)
        return FakeResponse(200, {"items": []})

    monkeypatch.setattr("pretix_openpos.sumup.requests.request", capture)
    account.readers()

    assert seen["headers"]["Authorization"] == "Bearer sup_sk_test"
    assert "sup_sk_test" not in str(seen.get("json"))
    assert "sup_sk_test" not in str(seen.get("params"))
    # And every call is bounded: a reader that has gone quiet must not hold a
    # worker until it gives up.
    assert seen["timeout"] == (5, 15)


@pytest.mark.django_db
def test_the_key_is_not_in_the_repr_either(account):
    assert "sup_sk_test" not in repr(account)


# -- readers ----------------------------------------------------------------


@pytest.mark.django_db
def test_the_readers_of_the_account_come_back(account, sumup):
    sumup.add_reader("rdr_A", name="Bar")
    sumup.add_reader("rdr_B", name="Entrée")

    assert [r["id"] for r in account.readers()] == ["rdr_A", "rdr_B"]


@pytest.mark.django_db
def test_an_answer_that_is_not_a_list_of_readers_is_no_readers(account, sumup):
    sumup.next_response = FakeResponse(200, ["unexpected"])

    assert account.readers() == []


@pytest.mark.django_db
def test_pairing_claims_the_reader_showing_the_code(account, sumup):
    reader = account.pair_reader("ABCDEF", "Bar")

    assert reader["name"] == "Bar"
    assert reader["id"] in sumup.readers


@pytest.mark.django_db
def test_forgetting_a_reader_removes_it(account, sumup):
    reader_id = sumup.add_reader("rdr_A")

    account.forget_reader(reader_id)

    assert sumup.readers == {}


@pytest.mark.django_db
def test_a_reader_says_what_it_is_doing(account, sumup):
    sumup.set_state(sumup.add_reader("rdr_A"), "WAITING_FOR_CARD")

    assert account.reader_status("rdr_A")["state"] == "WAITING_FOR_CARD"


@pytest.mark.django_db
def test_a_reader_that_cannot_answer_is_not_an_error(account, sumup):
    """
    The status endpoint needs firmware 3.3.39.0 on a Solo; taking payments
    needs 3.3.24.3. A reader in between works and cannot answer this, so "we
    do not know" is the honest result rather than an exception on a page load.
    """
    sumup.add_reader("rdr_A")

    assert account.reader_status("rdr_A") is None


@pytest.mark.django_db
def test_the_status_is_read_where_sumup_puts_it(account, sumup):
    """
    Under ``data``, as SumUp documents it. Looked for at the top level, it was
    never there: every reader on the back office read "unknown", switched on
    and online or not.
    """
    sumup.next_response = FakeResponse(200, {"data": {
        "battery_level": 10.0,
        "battery_temperature": 35,
        "connection_type": "Wi-Fi",
        "firmware_version": "3.3.3.21",
        "last_activity": "2025-09-25T15:20:00Z",
        "state": "IDLE",
        "status": "ONLINE",
    }})

    status = account.reader_status("rdr_A")

    assert status["status"] == "ONLINE"
    assert status["battery_level"] == 10.0


@pytest.mark.django_db
@pytest.mark.parametrize(
    "body",
    [
        {"data": {"battery_level": 50}},
        {"battery_level": 50},
        # The shape this used to expect, which SumUp does not send.
        {"status": "ONLINE", "state": "IDLE"},
        {"data": "ONLINE"},
    ],
)
def test_an_answer_with_no_status_in_it_is_no_answer(account, sumup, body):
    sumup.next_response = FakeResponse(200, body)

    assert account.reader_status("rdr_A") is None


@pytest.mark.django_db
def test_asking_a_reader_is_bounded_harder_than_the_rest(account, sumup, monkeypatch):
    # One call per reader, made while an organizer waits for a page. A reader
    # that has gone quiet must not hold that page for the usual fifteen
    # seconds to say so.
    seen = {}

    def capture(method, url, **kwargs):
        seen.update(kwargs)
        return FakeResponse(200, {"data": {"status": "ONLINE", "state": "IDLE"}})

    monkeypatch.setattr("pretix_openpos.sumup.requests.request", capture)
    account.reader_status("rdr_A")

    assert seen["timeout"] == (5, 5)


# -- payments ---------------------------------------------------------------


@pytest.mark.django_db
def test_starting_a_checkout_returns_the_handle_on_it(account, sumup):
    reader_id = sumup.add_reader()

    client_transaction_id, checkout_id = account.start_checkout(
        reader_id, amount=Decimal("10.00"), currency="EUR", description="Soirée"
    )

    assert client_transaction_id in sumup.transactions
    assert checkout_id in sumup.checkouts
    _method, _path, body = sumup.calls[-1]
    assert body["total_amount"] == {"currency": "EUR", "minor_unit": 2, "value": 1000}
    assert body["description"] == "Soirée"
    # No callback address unless one was given: SumUp refuses a plain-HTTP one.
    assert "return_url" not in body


@pytest.mark.django_db
def test_a_callback_address_is_passed_on_when_there_is_one(account, sumup):
    reader_id = sumup.add_reader()

    account.start_checkout(
        reader_id,
        amount=Decimal("10.00"),
        currency="EUR",
        description="Soirée",
        return_url="https://pretix.example.org/openpos/sumup/demo/tok/",
    )

    assert sumup.calls[-1][2]["return_url"].endswith("/tok/")


@pytest.mark.django_db
def test_a_checkout_sumup_accepts_without_naming_a_transaction_is_an_error(account, sumup):
    """
    There would be no way to find out what became of it, which is worse than
    refusing to start: the customer would be asked for a card nobody could
    account for afterwards.
    """
    sumup.add_reader()
    sumup.next_response = FakeResponse(201, {"data": {}})

    with pytest.raises(SumUpError) as caught:
        account.start_checkout(
            "rdr_ONE", amount=Decimal("10.00"), currency="EUR", description=""
        )

    assert "named no transaction" in str(caught.value.message)


@pytest.mark.django_db
def test_a_checkout_answered_without_its_own_id_still_starts(account, sumup):
    """
    SumUp's description makes the transaction's handle required and the
    request's optional. Without the second there is simply nothing to ask the
    reader about later, which is how every payment was settled until now.
    """
    sumup.add_reader()
    sumup.next_response = FakeResponse(201, {"data": {"client_transaction_id": "ctx_9"}})

    assert account.start_checkout(
        "rdr_ONE", amount=Decimal("10.00"), currency="EUR", description=""
    ) == ("ctx_9", "")


@pytest.mark.django_db
def test_the_request_on_the_reader_says_where_it_has_got_to(account, sumup):
    reader_id = sumup.add_reader()
    client_transaction_id, checkout_id = account.start_checkout(
        reader_id, amount=Decimal("10.00"), currency="EUR", description=""
    )

    assert account.reader_checkout(reader_id, checkout_id)["status"] == "pending"
    assert sumup.calls[-1][1] == f"/v0.1/merchants/MERCH1/readers/{reader_id}/checkout/{checkout_id}"

    sumup.walk_away(client_transaction_id)

    assert account.reader_checkout(reader_id, checkout_id)["status"] == "cancelled"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "response",
    [
        FakeResponse(404, {"detail": "not found"}),
        FakeResponse(503, {"message": "down"}),
        FakeResponse(200, {"data": {"checkout_id": "chk_1"}}),
        FakeResponse(200, {"status": "cancelled"}),
    ],
)
def test_a_reader_request_that_cannot_be_read_is_no_answer(account, sumup, response):
    """
    Asked only to close a payment early. Not knowing must leave the payment
    exactly as it was, so nothing here raises.
    """
    sumup.next_response = response

    assert account.reader_checkout("rdr_ONE", "chk_1") is None


@pytest.mark.django_db
def test_a_transaction_that_does_not_exist_is_not_an_error(account, sumup):
    """
    The reader has been asked and the cardholder has not answered. That is what
    the till is polling to find out, so a 404 here is "not yet", not a fault.
    """
    assert account.transaction("ctx_nope") is None


@pytest.mark.django_db
def test_not_yet_is_recognised_by_code_and_never_by_wording(account, sumup, monkeypatch):
    """
    The trap this replaces: "not yet" used to be recognised by looking for an
    English phrase inside the operator-facing message. Those messages are
    translated, so the first French catalogue would have turned the *normal*
    state of every reader payment — waiting for the cardholder — into a
    refusal, two seconds after it started, with the tests still green because
    they run in English.

    So the message is deliberately not English here, and the answer must not
    change.
    """
    def french_404(*_args, **_kwargs):
        raise SumUpError(
            "SumUp ne connaît pas ce lecteur ou cette transaction.",
            code=ERR_NOT_FOUND,
        )

    monkeypatch.setattr(SumUpAccount, "_call", french_404)

    assert account.transaction("ctx_nope") is None


@pytest.mark.django_db
@pytest.mark.parametrize(
    "status,code,retryable",
    [
        (404, ERR_NOT_FOUND, False),
        # A refund SumUp will not make *yet*, or a reader already paired:
        # nothing to do with a busy reader, which SumUp reports as a 422. Not
        # retryable in this module's sense — asking again at once gets the
        # same answer — but a caller refunding waits and asks again later.
        (409, ERR_CONFLICT, False),
        (422, ERR_REFUSED, False),
        (503, ERR_UNAVAILABLE, True),
    ],
)
def test_every_failure_carries_a_code_a_caller_can_branch_on(
    account, sumup, status, code, retryable
):
    sumup.next_response = FakeResponse(status, {"message": "nope"})

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert caught.value.code == code
    assert caught.value.retryable is retryable


@pytest.mark.django_db
def test_a_refund_names_the_transaction_and_no_amount_by_default(account, sumup):
    sumup.add_reader()
    client_transaction_id, _checkout_id = account.start_checkout(
        "rdr_ONE", amount=Decimal("10.00"), currency="EUR", description=""
    )
    sumup.pay(client_transaction_id, transaction_id="tx_7")

    account.refund("tx_7")

    assert sumup.refunds == [("tx_7", None)]


@pytest.mark.django_db
def test_a_whole_refund_is_asked_for_with_an_empty_json_object(account, sumup):
    """
    Never with no body at all. SumUp's spec calls the body optional, but its
    own client (sumup-go, ``TransactionsClient.Refund``) always sends one, as
    JSON — the request SumUp is known to take. Open POS sent nothing until
    0.22.1, and the first real refund, on 2026-09-24, was refused.
    """
    sumup.add_reader()
    client_transaction_id, _checkout_id = account.start_checkout(
        "rdr_ONE", amount=Decimal("10.00"), currency="EUR", description=""
    )
    sumup.pay(client_transaction_id, transaction_id="tx_7")

    account.refund("tx_7")

    [(method, path, body)] = [call for call in sumup.calls if call[1].endswith("/refunds")]
    assert (method, path) == ("POST", "/v1.0/merchants/MERCH1/payments/tx_7/refunds")
    assert body == {}


@pytest.mark.django_db
def test_a_refund_sumup_made_is_not_reported_as_refused(account, sumup):
    """
    SumUp answers a refund with 201. Treated as a refusal, every card sale
    cancelled at the till told the operator to refund from the SumUp app a
    card that had already been paid back — the one way to pay it back twice.
    """
    sumup.next_response = FakeResponse(201, {})

    assert account.refund("tx_7") is None


@pytest.mark.django_db
def test_a_partial_refund_names_its_amount(account, sumup):
    sumup.add_reader()
    client_transaction_id, _checkout_id = account.start_checkout(
        "rdr_ONE", amount=Decimal("10.00"), currency="EUR", description=""
    )
    sumup.pay(client_transaction_id, transaction_id="tx_7")

    account.refund("tx_7", Decimal("4.00"))

    assert sumup.refunds == [("tx_7", 4.0)]


# -- how failures come back -------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("status", [401, 403])
def test_a_rejected_key_says_where_to_fix_it(account, sumup, status):
    sumup.next_response = FakeResponse(status, {"message": "nope"})

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert "API key" in str(caught.value.message)
    assert caught.value.retryable is False


@pytest.mark.django_db
def test_a_reader_that_is_off_says_so(account, sumup):
    """
    The refusal a counter meets most. It used to read "SumUp refused this
    request", which tells a volunteer nothing they can act on.
    """
    sumup.add_reader()
    sumup.next_response = reader_offline()

    with pytest.raises(SumUpError) as caught:
        account.start_checkout("rdr_ONE", amount=Decimal("10.00"), currency="EUR", description="")

    assert caught.value.code == ERR_OFFLINE
    assert "offline" in str(caught.value.message)
    # Nothing reached the reader, so the payment has failed rather than become
    # unknown: retryable here would keep the till waiting on a card forever.
    assert caught.value.retryable is False


@pytest.mark.django_db
def test_a_reader_still_holding_the_last_request_says_so(account, sumup):
    sumup.add_reader()
    sumup.next_response = reader_busy()

    with pytest.raises(SumUpError) as caught:
        account.start_checkout("rdr_ONE", amount=Decimal("10.00"), currency="EUR", description="")

    assert caught.value.code == ERR_BUSY
    assert "previous request" in str(caught.value.message)
    assert caught.value.retryable is False


@pytest.mark.django_db
@pytest.mark.parametrize(
    "body",
    [
        {"errors": {"total_amount": ["must be greater than 0"]}},
        {"type": "https://developer.sumup.com/problem/validation-error",
         "title": "Unprocessable Entity", "status": 422, "detail": "Validation failed"},
        {"errors": {"type": 7}},
    ],
)
def test_any_other_422_is_a_plain_refusal(account, sumup, body):
    sumup.next_response = FakeResponse(422, body)

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert caught.value.code == ERR_REFUSED


@pytest.mark.django_db
def test_sumup_faulting_is_worth_trying_again(account, sumup):
    sumup.next_response = FakeResponse(503, {"message": "down"})

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert caught.value.retryable is True


@pytest.mark.django_db
def test_being_unable_to_reach_sumup_is_not_a_refusal(account, sumup):
    """
    The distinction the whole terminal flow rests on: the till is being told to
    try again, not that the payment failed.
    """
    sumup.next_exception = requests.ConnectTimeout("no route")

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert caught.value.retryable is True
    assert "could not be reached" in str(caught.value.message)


@pytest.mark.django_db
def test_a_refusal_sumup_explains_keeps_its_wording_out_of_the_screen(account, sumup):
    sumup.next_response = FakeResponse(422, {"message": "amount too small"})

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert str(caught.value.message) == "SumUp refused this request."
    # SumUp's own words stay in the log, where they are useful.
    assert "amount too small" in caught.value.detail


@pytest.mark.django_db
def test_a_gateway_page_in_place_of_an_error_is_still_sumup_faulting(account, sumup):
    # A proxy in front of SumUp answers in HTML. There is no error name to read
    # in that, and nothing in it may be taken for a reader refusing.
    sumup.next_response = FakeResponse(502, text="<html>Bad gateway</html>")

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert caught.value.code == ERR_UNAVAILABLE
    assert caught.value.retryable is True


@pytest.mark.django_db
def test_an_answer_that_is_not_json_is_said_so(account, sumup):
    sumup.next_response = FakeResponse(200, text="<html>gateway</html>")

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert "could not read" in str(caught.value.message)


@pytest.mark.django_db
def test_an_empty_success_is_an_empty_answer(account, sumup):
    sumup.add_reader("rdr_A")

    # 204, no body: forgetting a reader answers this way and must not blow up.
    assert account.forget_reader("rdr_A") is None


# -- what SumUp said, for the back office -------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize(
    "response,reason",
    [
        # A problem document, as the refund route answers.
        (
            FakeResponse(409, {
                "type": "https://developer.sumup.com/problem/conflict", "title": "Conflict",
                "status": 409, "detail": "The transaction is not refundable in its current state",
            }),
            "409 · The transaction is not refundable in its current state",
        ),
        (
            FakeResponse(403, {"title": "Forbidden", "detail": "users is not allowed to make a refund"}),
            "403 · users is not allowed to make a refund",
        ),
        # The same, with the specifics in a list of errors.
        (
            FakeResponse(422, {
                "detail": "Refund failed.",
                "errors": [{"code": "INVALID_AMOUNT", "detail": "Amount exceeds the refundable amount"}],
            }),
            "422 · Refund failed. · INVALID_AMOUNT · Amount exceeds the refundable amount",
        ),
        # The Readers API's own shape.
        (reader_busy(), "422 · READER_BUSY · There is a pending checkout for the device."),
        # An older route, answering with a list.
        (
            FakeResponse(400, [{"error_code": "NOT_ENOUGH_BALANCE", "message": "Not enough balance"}]),
            "400 · NOT_ENOUGH_BALANCE · Not enough balance",
        ),
        # A field and its complaint.
        (
            FakeResponse(422, {"errors": {"total_amount": ["must be greater than 0"]}}),
            "422 · total_amount: must be greater than 0",
        ),
        (FakeResponse(400, {"errors": {"amount": "too high"}}), "400 · amount: too high"),
        # Nothing readable: the status alone.
        (FakeResponse(409, {"errors": {"type": 7}}), "409"),
        (FakeResponse(409, {"errors": []}), "409"),
        (FakeResponse(409, []), "409"),
        (FakeResponse(502, text="<html>Bad gateway</html>"), "502"),
    ],
)
def test_a_refusal_keeps_sumup_s_own_words_for_the_back_office(account, sumup, response, reason):
    sumup.next_response = response

    with pytest.raises(SumUpError) as caught:
        account.refund("tx_7")

    assert caught.value.reason == reason


@pytest.mark.django_db
def test_sumup_s_words_go_after_the_message_for_the_back_office(account, sumup):
    sumup.next_response = FakeResponse(409, {"detail": "The transaction is not refundable"})

    with pytest.raises(SumUpError) as caught:
        account.refund("tx_7")

    # The till's screen keeps its own words...
    assert str(caught.value.message) == "SumUp refused this request."
    # ...and the back office gets SumUp's after them.
    assert caught.value.explained() == (
        "SumUp refused this request. SumUp answered: 409 · The transaction is not refundable"
    )


@pytest.mark.django_db
def test_not_reaching_sumup_has_no_words_of_sumup_s_to_add(account, sumup):
    sumup.next_exception = requests.ConnectTimeout("no route")

    with pytest.raises(SumUpError) as caught:
        account.refund("tx_7")

    assert caught.value.reason == ""
    assert caught.value.explained() == str(caught.value.message)


@pytest.mark.django_db
def test_sumup_s_words_never_carry_the_key(account, sumup):
    """They are shown in the back office, so they are checked, not trusted."""
    sumup.next_response = FakeResponse(401, {"message": "invalid token sup_sk_test"})

    with pytest.raises(SumUpError) as caught:
        account.refund("tx_7")

    assert "sup_sk_test" not in caught.value.reason
    assert caught.value.reason == "401 · invalid token …"


# -- what went back to the card ----------------------------------------------


@pytest.mark.django_db
def test_a_refund_asked_for_too_soon_is_told_apart_from_a_refusal(account, sumup):
    """
    SumUp's answer to the first real refunds, asked for moments after the
    payment: the same refund went through in its dashboard minutes later.
    """
    sumup.next_response = FakeResponse(409, NOT_REFUNDABLE)

    with pytest.raises(SumUpError) as caught:
        account.refund("tx_7")

    assert caught.value.code == ERR_CONFLICT
    assert caught.value.reason == "409 · The transaction is not refundable in its current state"


@pytest.mark.django_db
def test_a_transaction_is_read_by_the_id_a_refund_names(account, sumup):
    sumup.transactions["ctx_1"] = {"id": "tx_1", "client_transaction_id": "ctx_1",
                                   "status": "SUCCESSFUL", "amount": 10.0}

    assert account.transaction_by_id("tx_1")["status"] == "SUCCESSFUL"
    assert sumup.calls[-1][1] == "/v2.1/merchants/MERCH1/transactions"


@pytest.mark.django_db
def test_a_transaction_that_is_not_there_by_id_is_an_error(account, sumup):
    # Unlike by the checkout's handle: a refund names a transaction that was
    # read when the sale was booked, so it exists.
    with pytest.raises(SumUpError) as caught:
        account.transaction_by_id("tx_nope")

    assert caught.value.code == ERR_NOT_FOUND


@pytest.mark.django_db
def test_the_history_is_asked_for_refunds_and_payments_given_back_since_a_time(account, sumup):
    from datetime import datetime, timezone

    list(account.given_back_payments(datetime(2026, 9, 24, 12, 30, tzinfo=timezone.utc)))

    [query] = sumup.history_reads
    assert query == {
        "oldest_time": "2026-09-24T12:30:00Z",
        "statuses[]": ["CANCELLED", "REFUNDED"],
        # A refund's own line: the payment's stays "successful".
        "types[]": ["PAYMENT", "REFUND"],
        "order": "descending",
        "limit": 100,
    }


@pytest.mark.django_db
def test_the_history_follows_its_next_link_page_by_page(account, sumup):
    from datetime import datetime, timezone

    for n in range(5):
        sumup.pay(f"ctx_{n}", transaction_id=f"tx_{n}", amount="1.00")
    for n in range(5):
        sumup.give_back(f"tx_{n}")
    sumup.pay("ctx_paid", transaction_id="tx_paid", amount="1.00")

    items = list(account.given_back_payments(datetime(2026, 9, 1, tzinfo=timezone.utc), limit=2))

    # Newest first, each refund once, and no payment: the refunded ones stay
    # "successful", like the one still paid.
    assert [(item["type"], item["transaction_id"]) for item in items] == [
        ("REFUND", f"tx_{n}") for n in (4, 3, 2, 1, 0)
    ]
    assert len(sumup.history_reads) == 3
    # The link's cursor is laid over the filters, which it does not repeat.
    assert sumup.history_reads[1]["newest_ref"] == items[1]["id"]
    assert sumup.history_reads[1]["statuses[]"] == ["CANCELLED", "REFUNDED"]
    assert sumup.history_reads[1]["types[]"] == ["PAYMENT", "REFUND"]


@pytest.mark.django_db
def test_a_next_link_that_repeats_the_filters_keeps_all_of_them(account, sumup):
    from datetime import datetime, timezone

    for n in range(3):
        sumup.pay(f"ctx_{n}", transaction_id=f"tx_{n}", amount="1.00")
        sumup.give_back(f"tx_{n}", status="REFUNDED" if n % 2 else "CANCELLED")
    sumup.history_link_extra = (
        "&statuses[]=CANCELLED&statuses[]=REFUNDED&types[]=PAYMENT&types[]=REFUND"
    )

    items = list(account.given_back_payments(datetime(2026, 9, 1, tzinfo=timezone.utc), limit=2))

    assert [(item["type"], item["transaction_id"]) for item in items] == [
        ("REFUND", "tx_1"), ("PAYMENT", "tx_2"), ("PAYMENT", "tx_0"),
    ]
    assert sumup.history_reads[1]["statuses[]"] == ["CANCELLED", "REFUNDED"]
    assert sumup.history_reads[1]["types[]"] == ["PAYMENT", "REFUND"]


@pytest.mark.django_db
def test_the_history_stops_after_so_many_pages(account, sumup):
    from datetime import datetime, timezone

    for n in range(5):
        sumup.transactions[f"ctx_{n}"] = {
            "id": f"tx_{n}", "client_transaction_id": f"ctx_{n}",
            "status": "CANCELLED", "amount": "1.00",
        }

    items = list(
        account.given_back_payments(datetime(2026, 9, 1, tzinfo=timezone.utc), limit=2, pages=2)
    )

    assert len(items) == 4
    assert len(sumup.history_reads) == 2


@pytest.mark.parametrize(
    "transaction,expected",
    [
        (None, Decimal("0.00")),
        ({"status": "SUCCESSFUL", "amount": 10.0}, Decimal("0.00")),
        # Reversed before it settled: all of it, whatever else is said.
        ({"status": "CANCELLED", "amount": 10.0}, Decimal("10.00")),
        ({"status": "SUCCESSFUL", "simple_status": "CANCELLED", "amount": "7.5"}, Decimal("7.50")),
        # The history's line says how much.
        ({"status": "REFUNDED", "amount": 10.0, "refunded_amount": 10.0}, Decimal("10.00")),
        ({"status": "REFUNDED", "amount": 10.0, "refunded_amount": 2.5}, Decimal("2.50")),
        # The transaction itself only lists its events, twice over: once.
        (
            {
                "status": "REFUNDED", "amount": 10.0,
                "events": [{"type": "REFUND", "status": "SUCCESSFUL", "amount": 4.0},
                           {"type": "PAYOUT", "status": "PAID_OUT", "amount": 10.0},
                           {"type": "REFUND", "status": "FAILED", "amount": 6.0}],
                "transaction_events": [{"event_type": "REFUND", "status": "SUCCESSFUL",
                                        "amount": 4.0}],
            },
            Decimal("4.00"),
        ),
        (
            {"simple_status": "REFUNDED", "amount": 10.0,
             "transaction_events": [{"event_type": "REFUND", "status": "PENDING",
                                     "amount": -10.0}]},
            Decimal("10.00"),
        ),
        # A refunded payment stays "successful", as SumUp answered on 24
        # September 2026: its history line says how much went back...
        ({"type": "PAYMENT", "status": "SUCCESSFUL", "amount": 1.0, "refunded_amount": 1.0},
         Decimal("1.00")),
        ({"type": "PAYMENT", "status": "SUCCESSFUL", "amount": 1.0, "refunded_amount": 0},
         Decimal("0.00")),
        ({"status": "SUCCESSFUL", "amount": 10.0, "refunded_amount": -3.0}, Decimal("0.00")),
        # ...and the payment itself its refund events, twice over: once.
        (
            {"status": "SUCCESSFUL", "simple_status": "SUCCESSFUL", "amount": 1.0,
             "events": [{"type": "PAYOUT", "status": "SCHEDULED", "amount": 0.98},
                        {"type": "REFUND", "status": "REFUNDED", "amount": 1.0}],
             "transaction_events": [{"event_type": "PAYOUT", "status": "PENDING",
                                     "amount": 0.98},
                                    {"event_type": "REFUND", "status": "REFUNDED",
                                     "amount": 1.0}]},
            Decimal("1.00"),
        ),
        # A refund not final yet does not, when nothing else says refunded.
        ({"status": "SUCCESSFUL", "amount": 10.0,
          "events": [{"type": "REFUND", "status": "PENDING", "amount": 10.0}]}, Decimal("0.00")),
        ({"status": "SUCCESSFUL", "amount": 10.0,
          "events": [{"type": "REFUND", "status": "SUCCESSFUL", "amount": None}]}, None),
        # A refund's own line: that one refund, so the payment is to say how
        # much it had back in all. Cancelled, a refund is no money back.
        ({"type": "REFUND", "status": "REFUNDED", "amount": 1.0}, None),
        ({"type": "REFUND", "status": "SUCCESSFUL", "amount": 1.0}, None),
        ({"type": "REFUND", "status": "CANCELLED", "amount": 1.0}, Decimal("0.00")),
        ({"type": "REFUND", "status": "FAILED", "amount": 1.0}, Decimal("0.00")),
        ({"type": "REFUND", "status": "PENDING", "amount": 1.0}, Decimal("0.00")),
        # Refunded, and not a word of how much: not guessed.
        ({"status": "REFUNDED", "amount": 10.0}, None),
        ({"status": "REFUNDED", "amount": 10.0,
          "events": [{"type": "REFUND", "status": "SUCCESSFUL", "amount": "n/a"}]}, None),
        ({"status": "REFUNDED", "amount": 10.0, "refunded_amount": True}, None),
    ],
)
def test_how_much_went_back_is_read_from_what_sumup_says(transaction, expected):
    assert given_back(transaction) == expected
