"""
Reversing a sale.

Never an edit: the order is cancelled through pretix' own service, the money is
recorded as going back out, and the journal gains a *new* line carrying the
negative amount. Three documents where a spreadsheet would have changed one
number, which is what makes the evening's takings defensible afterwards.
"""
from decimal import Decimal

import pytest
import requests
from django.utils.timezone import now
from pretix.base.models import Order
from pretix.base.models.orders import OrderRefund

from pretix_openpos.models import PosSale, PosTerminalPayment

from .conftest import order_of, sell
from .sumup_stub import FakeResponse


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
def test_the_order_history_says_the_refund_was_created_before_it_was_done(
    till, event, ticket
):
    """
    What pretix writes itself whenever it creates a refund. Without it the
    order's history showed a refund done that had never been created, and
    pretix' own "refund created" webhook never fired for a till's refund.
    """
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    cancel(till, sale["journal_seq"])

    order = Order.objects.get(code=sale["order"]["code"])
    refund = order.refunds.get()
    history = list(
        order.all_logentries()
        .filter(action_type__startswith="pretix.event.order.refund.")
        .order_by("pk")
        .values_list("action_type", "data")
    )
    assert [action for action, _data in history] == [
        "pretix.event.order.refund.created",
        "pretix.event.order.refund.done",
    ]
    assert f'"local_id": {refund.local_id}' in history[0][1]
    assert '"provider": "openpos_cash"' in history[0][1]


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


def flags(body):
    """The three booleans that say how a cancellation was reached."""
    return body["replayed"], body["already_cancelled"], body["by_back_office"]


@pytest.mark.django_db
def test_a_fresh_cancellation_says_so(till, ticket):
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    body = cancel(till, sale["journal_seq"]).json()

    assert flags(body) == (False, False, False)


@pytest.mark.django_db
def test_a_retry_under_a_fresh_key_gets_the_cancellation_that_stands(till, event, ticket):
    """
    What the app did before its keys were minted per sale, and still does when
    the history panel is closed and opened again: the retry of a cancellation
    that went through comes with a key the server has never seen. It used to be
    refused as "already cancelled" — and the operator lost the credit note, the
    amount to hand back and the corrected basket, for a cancellation that had
    in fact been made. It is now answered with that cancellation, exactly as
    it was answered the first time.
    """
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    first = cancel(till, sale["journal_seq"], key="first-attempt")

    response = cancel(till, sale["journal_seq"], key="second-attempt")

    assert first.status_code == 201
    assert response.status_code == 200
    body = response.json()
    assert flags(body) == (True, True, False)
    for field in ("cancellation", "sale", "credit_note", "refunded", "card_refund"):
        assert body[field] == first.json()[field], field
    # The corrected basket, and the amount it is settled against.
    assert body["sale"]["positions"] == PosSale.objects.get(seq=sale["journal_seq"]).positions
    assert body["cancellation"]["total"] == "-10.00"
    # Nothing written a second time.
    assert PosSale.objects.filter(kind=PosSale.KIND_CANCELLATION).count() == 1
    assert Order.objects.get(code=sale["order"]["code"]).refunds.count() == 1


@pytest.mark.django_db
def test_a_retry_under_the_same_key_is_a_replay_and_keeps_its_credit_note(till, event, ticket):
    """
    The same request again is not a sale found cancelled: it is this one. And
    its answer carries the credit note, which the replay used to leave out —
    the one thing the app's per-sale key was there to keep.
    """
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    first = cancel(till, sale["journal_seq"], key="same-key-here").json()

    body = cancel(till, sale["journal_seq"], key="same-key-here").json()

    assert flags(body) == (True, False, False)
    assert first["credit_note"]
    assert body["credit_note"] == first["credit_note"]
    assert body["refunded"] is True


@pytest.mark.django_db
def test_a_replay_whose_sale_cannot_be_read_still_answers(till, event, ticket):
    """
    A cancellation always names the sale it reverses, and the journal never
    loses a row; but a damaged one must not become a 500 at the counter, on
    the one request the till retries until it gets an answer. The replay
    answers with the cancellation it has, and asks no reader for anything.
    """
    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    first = cancel(till, sale["journal_seq"], key="same-key-here").json()
    PosSale.objects.filter(seq=first["cancellation"]["seq"]).update(cancels_seq=999)

    response = cancel(till, sale["journal_seq"], key="same-key-here")

    assert response.status_code == 200
    body = response.json()
    assert flags(body) == (True, False, False)
    assert body["cancellation"]["seq"] == first["cancellation"]["seq"]
    assert body["sale"] is None
    assert body["credit_note"] is None
    assert body["card_refund"] == "none"


@pytest.mark.django_db
def test_a_sale_the_back_office_cancelled_is_said_to_have_been(
    backoffice, till, event, ticket
):
    """
    The till asks to cancel a sale somebody has just cancelled on pretix' order
    page. It gets that cancellation, marked as the back office's, so the app
    can say who did it rather than offer to hand the money back a second time;
    and it writes nothing.
    """
    from .test_backoffice_cancel import cancel_in_back_office

    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()
    cancel_in_back_office(backoffice, event, order_of(event, sale["order"]["code"]))
    before = PosSale.objects.count()

    response = cancel(till, sale["journal_seq"], key="after-the-office")

    assert response.status_code == 200
    body = response.json()
    assert flags(body) == (True, True, True)
    assert body["sale"]["order"] == sale["order"]["code"]
    assert body["cancellation"]["cancels_seq"] == sale["journal_seq"]
    assert PosSale.objects.count() == before


@pytest.mark.django_db
def test_a_card_the_back_office_cancelled_is_never_refunded_from_the_till(
    backoffice, till, event, ticket, reader_till, sumup
):
    """
    Whoever cancelled it there decided about the money there — pretix offers
    its own refund dialog for the card, and may have been told "not now". The
    till's request must not make that decision for them.
    """
    from .test_backoffice_cancel import cancel_in_back_office, card_sale

    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    cancel_in_back_office(backoffice, event, order_of(event, sale["order"]["code"]))

    body = cancel(till, sale["journal_seq"], key="after-the-office").json()

    assert flags(body) == (True, True, True)
    assert body["card_refund"] == "none"
    assert sumup.refunds == []


@pytest.mark.django_db
def test_where_a_card_the_back_office_cancelled_stands_is_read_not_asked(
    backoffice, till, event, ticket, reader_till, sumup
):
    from .test_backoffice_cancel import cancel_in_back_office, card_sale, order_url

    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    payment = order.payments.get()
    cancel_in_back_office(backoffice, event, order)
    # Refused by SumUp from pretix' dialog: the refund is failed on the order.
    sumup.next_response = FakeResponse(422, {"message": "too late"})
    backoffice.post(
        order_url(event, order, "refund"),
        {
            "start-mode": "partial",
            "start-partial_amount": "10.00",
            f"refund-{payment.pk}": "10.00",
            "perform": "on",
            "last_known_refund_id": "0",
        },
    )
    assert cancel(till, sale["journal_seq"], key="after-a-refusal").json()["card_refund"] == "failed"

    # Left waiting for SumUp, as its 409 leaves one.
    refund = order.refunds.order_by("-local_id").first()
    refund.state = OrderRefund.REFUND_STATE_TRANSIT
    refund.save(update_fields=["state"])
    assert cancel(till, sale["journal_seq"], key="while-it-waits").json()["card_refund"] == "pending"

    # And sent in the end, from the dialog.
    PosTerminalPayment.objects.update(refunded=now())
    assert cancel(till, sale["journal_seq"], key="once-it-went").json()["card_refund"] == "already"
    # Not one of which asked SumUp for anything: the one refund call is the
    # dialog's.
    assert [path for path in sumup.call_paths("POST") if path.endswith("/refunds")] == [
        "/v1.0/merchants/MERCH1/payments/tx_1/refunds"
    ]


@pytest.mark.django_db
def test_a_fresh_key_finishes_a_card_refund_the_first_attempt_did_not_reach(
    till, ticket, reader_till, sumup
):
    """
    The cancellation commits, then the connection dies before SumUp is asked;
    the retry comes back under another key. The till's own cancellation, so
    the job is finished — once.
    """
    from .test_backoffice_cancel import card_sale

    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    sumup.next_exception = requests.ConnectTimeout("no route")
    first = cancel(till, sale["journal_seq"], key="cancel-first")
    assert first.json()["card_refund"] == "failed"

    again = cancel(till, sale["journal_seq"], key="cancel-again")

    assert flags(again.json()) == (True, True, False)
    assert again.json()["card_refund"] == "done"
    assert sumup.refunds == [("tx_1", None)]
    assert cancel(till, sale["journal_seq"], key="cancel-third").json()["card_refund"] == "already"
    assert len(sumup.refunds) == 1


@pytest.mark.django_db
def test_a_key_that_names_somebody_else_s_entry_is_refused(
    till, another_till, event, ticket
):
    """
    A replay is this till's own cancellation coming back. A key naming a sale,
    or another till's cancellation, is a mistake at best — and at worst the key
    of a cancellation the back office wrote, spelt out in backoffice.py, which
    would have had the till finish a refund somebody chose not to make.
    """
    theirs = sell(another_till, [{"item": ticket.pk, "count": 1}], idempotency_key="their-sale-1").json()
    cancel(another_till, theirs["journal_seq"], key="their-cancel-1")
    mine = sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="my-sale-0001").json()

    for key in ("their-cancel-1", "my-sale-0001"):
        response = cancel(till, mine["journal_seq"], key=key)

        assert response.status_code == 400
        assert "another entry" in str(response.json())
    assert Order.objects.get(code=mine["order"]["code"]).status == Order.STATUS_PAID


@pytest.mark.django_db
def test_a_back_office_key_cannot_make_the_till_refund_a_card(
    backoffice, till, event, ticket, reader_till, sumup
):
    from .test_backoffice_cancel import cancel_in_back_office, card_sale

    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    cancel_in_back_office(backoffice, event, order_of(event, sale["order"]["code"]))
    written = PosSale.objects.get(kind=PosSale.KIND_CANCELLATION)

    response = cancel(till, sale["journal_seq"], key=written.idempotency_key)

    assert response.status_code == 400
    assert sumup.refunds == []


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


@pytest.mark.django_db
def test_a_sale_whose_order_has_been_purged_is_refused_in_words(till, event, ticket):
    # Test-mode orders are deleted when test mode is switched off, and the
    # journal outlives them on purpose. Cancelling one has to say so rather
    # than raise.
    sell(till, [{"item": ticket.pk, "count": 1}])
    sale = PosSale.objects.get(event=event, kind=PosSale.KIND_SALE)
    # What the purge leaves behind: the journal row, with nothing to point at.
    PosSale.objects.filter(pk=sale.pk).update(order=None)

    response = cancel(till, sale.seq)

    assert response.status_code == 400
    assert "no longer exists" in str(response.json())


@pytest.mark.django_db
def test_an_order_pretix_will_not_cancel_is_refused_with_its_status(till, event, ticket):
    # Cancelled in the back office while the till still lists it. The reason
    # has to name the status, or the operator is left pressing a button.
    sell(till, [{"item": ticket.pk, "count": 1}])
    sale = PosSale.objects.get(event=event, kind=PosSale.KIND_SALE)
    Order.objects.filter(pk=sale.order_id).update(status=Order.STATUS_CANCELED)

    response = cancel(till, sale.seq)

    assert response.status_code == 400
    assert "pretix will not let this order be cancelled" in str(response.json())


@pytest.mark.django_db
def test_pretix_refusing_mid_cancellation_is_reported_not_swallowed(
    till, event, ticket, monkeypatch
):
    from pretix.base.services.orders import OrderError

    from pretix_openpos.api import views

    sell(till, [{"item": ticket.pk, "count": 1}])
    sale = PosSale.objects.get(event=event, kind=PosSale.KIND_SALE)

    def refuse(*args, **kwargs):
        raise OrderError("Quota is gone.")

    monkeypatch.setattr(views, "cancel_order", refuse)

    response = cancel(till, sale.seq)

    assert response.status_code == 400
    assert "Quota is gone." in str(response.json())
    # Nothing half-done: no reversing line, and the sale still stands.
    assert PosSale.objects.filter(event=event, kind=PosSale.KIND_CANCELLATION).count() == 0


@pytest.mark.django_db
def test_a_sale_with_no_confirmed_payment_is_still_cancelled(till, event, ticket):
    # There is nothing to refund — the books already agree with the drawer —
    # and refusing here would leave an order nobody can cancel from the till.
    sell(till, [{"item": ticket.pk, "count": 1}])
    sale = PosSale.objects.get(event=event, kind=PosSale.KIND_SALE)
    Order.objects.get(pk=sale.order_id).payments.all().delete()

    response = cancel(till, sale.seq)

    assert response.status_code == 201
    assert response.json()["refunded"] is False
    assert OrderRefund.objects.filter(order__event=event).count() == 0
