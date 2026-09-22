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
    ERR_BUSY,
    ERR_NOT_FOUND,
    ERR_UNAVAILABLE,
    SumUpAccount,
    SumUpError,
    minor_units,
    still_running,
    succeeded,
)

from .sumup_stub import FakeResponse


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


# -- payments ---------------------------------------------------------------


@pytest.mark.django_db
def test_starting_a_checkout_returns_the_handle_on_it(account, sumup):
    reader_id = sumup.add_reader()

    client_transaction_id = account.start_checkout(
        reader_id, amount=Decimal("10.00"), currency="EUR", description="Soirée"
    )

    assert client_transaction_id in sumup.transactions
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
        (409, ERR_BUSY, True),
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
    client_transaction_id = account.start_checkout(
        "rdr_ONE", amount=Decimal("10.00"), currency="EUR", description=""
    )
    sumup.pay(client_transaction_id, transaction_id="tx_7")

    account.refund("tx_7")

    assert sumup.refunds == [("tx_7", None)]


@pytest.mark.django_db
def test_a_partial_refund_names_its_amount(account, sumup):
    sumup.add_reader()
    client_transaction_id = account.start_checkout(
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
def test_a_busy_reader_is_worth_trying_again(account, sumup):
    sumup.next_response = FakeResponse(409, {"message": "busy"})

    with pytest.raises(SumUpError) as caught:
        account.readers()

    assert caught.value.retryable is True


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
