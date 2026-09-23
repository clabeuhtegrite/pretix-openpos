"""
A till's sale cancelled in pretix itself, rather than at the till.

pretix' order page has a Cancel button, its REST API a cancel endpoint, and an
event can be cancelled wholesale. None of them used to reach the journal: the
sale went on counting in the evening's takings after pretix had struck it off,
the till could no longer reverse it because pretix said it already was, and a
card sale had nobody to give its money back — pretix offered only a manual
refund, done by hand in the SumUp app.

The rules these tests hold the plugin to:

- a cancellation made anywhere but at the till is a new journal row, in the
  name of whoever made it, and the till's own is still written exactly once;
- a reactivation undoes that row when the money never left, and only then;
- pretix' refund dialog offers to give a reader's card payment back, and does
  it through SumUp, once;
- a sale cancelled before any of this existed is listed on the Sales page until
  somebody writes it in.
"""
from datetime import date
from decimal import Decimal

import pytest
import requests
from django.test import Client
from pretix.base.models import Order, Team, TeamAPIToken
from pretix.base.models.orders import OrderRefund
from pretix.base.payment import PaymentException

from pretix_openpos.backoffice import cancelled_outside_the_journal, record_cancellation, till_cancelling
from pretix_openpos.models import PosSale, PosTerminalPayment

from .conftest import order_of, sell
from .sumup_stub import FakeResponse
from .test_backoffice import on_night
from .test_summary import adds_up


def order_url(event, order, action=""):
    return f"/control/event/{event.organizer.slug}/{event.slug}/orders/{order.code}/{action}"


def sales_url(event):
    return f"/control/event/{event.organizer.slug}/{event.slug}/openpos/sales/"


def cancel_in_back_office(client, event, order, **fields):
    """What the Cancel button on pretix' order page posts."""
    return client.post(
        order_url(event, order, "transition"),
        {"status": "c", "cancel_invoice": "on", **fields},
    )


def reactivate_in_back_office(client, event, order):
    return client.post(order_url(event, order, "reactivate"), {})


def api_token(organizer, event, name="Compta"):
    team = Team.objects.create(
        organizer=organizer, name="API", all_events=True, all_event_permissions=True,
    )
    return TeamAPIToken.objects.create(team=team, name=name)


def api(token, method, path, body=None):
    client = Client()
    call = getattr(client, method)
    return call(
        f"/api/v1/organizers/{token.team.organizer.slug}/events/{path}",
        data=body or {},
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Token {token.token}",
    )


def reversals_of(event, seq):
    return list(
        PosSale.objects.filter(
            event=event, kind=PosSale.KIND_CANCELLATION, cancels_seq=seq
        ).order_by("seq")
    )


def till_line(till, seq):
    """The line the till's own history shows for a journal row."""
    return next(line for line in till.get("history").json()["results"] if line["seq"] == seq)


def card_sale(till, sumup, positions):
    """A card sale a reader took, as the till rings it up."""
    from .test_terminal import KEY, start, status

    start(till, positions)
    sumup.pay()
    status(till)
    return sell(till, positions, payment_type="card", idempotency_key=KEY).json()


# -- the journal hears of it --------------------------------------------------


@pytest.mark.django_db
def test_a_sale_cancelled_on_the_order_page_is_reversed_in_the_journal(
    backoffice, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 4}], cash_given="20.00").json()
    order = order_of(event, sale["order"]["code"])

    cancel_in_back_office(backoffice, event, order, comment="Commande en double")

    order.refresh_from_db()
    assert order.status == Order.STATUS_CANCELED
    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.total == Decimal("-12.00")
    assert reversal.payment_type == PosSale.PAYMENT_CASH
    assert reversal.order == order
    # Nobody at a till did this, and the row says who did.
    assert reversal.device is None
    assert reversal.device_serial == ""
    assert reversal.from_back_office
    assert reversal.cashier == "boss@example.org"
    assert reversal.reason == "Commande en double"
    assert [(line["item_name"], line["count"], line["line_total"]) for line in reversal.positions] == [
        ("Bière", -4, "-12.00"),
    ]
    assert PosSale.verify_chain(event) is None


@pytest.mark.django_db
def test_the_till_sees_the_sale_cancelled_and_stops_offering_to(
    backoffice, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    cancel_in_back_office(backoffice, event, order_of(event, sale["order"]["code"]))

    line = till_line(till, sale["journal_seq"])

    assert line["cancelled"] is True
    assert line["can_cancel"] is False


@pytest.mark.django_db
def test_the_takings_drop_by_the_cancelled_sale(backoffice, till, event, beer, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="garde-1-xx")
    sale = sell(till, [{"item": beer.pk, "count": 2}], idempotency_key="annule-1-xx").json()

    cancel_in_back_office(backoffice, event, order_of(event, sale["order"]["code"]))

    summary = till.get("summary").json()
    # The evening as a whole no longer counts the beers...
    assert summary["event"]["total"] == "10.00"
    # ...and the till's own drawer figure is left as it is: nobody took the
    # money out of it, the back office did whatever it did on its own line.
    assert summary["device"]["total"] == "16.00"


@pytest.mark.django_db
def test_the_till_s_own_cancellation_is_still_written_once(till, event, beer):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()

    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "annule-01"})

    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.device == till.device
    assert not reversal.from_back_office


@pytest.mark.django_db
def test_an_order_no_till_sold_is_none_of_the_journal_s_business(
    backoffice, event, beer
):
    order = Order.objects.create(
        event=event, email="client@example.org", status=Order.STATUS_PENDING,
        total=Decimal("3.00"), locale="fr",
        sales_channel=event.organizer.sales_channels.get(identifier="web"),
    )
    order.positions.create(item=beer, price=Decimal("3.00"), positionid=1)

    cancel_in_back_office(backoffice, event, order)

    order.refresh_from_db()
    assert order.status == Order.STATUS_CANCELED
    assert not PosSale.objects.filter(event=event).exists()

    reactivate_in_back_office(backoffice, event, order)

    order.refresh_from_db()
    assert order.status != Order.STATUS_CANCELED
    assert not PosSale.objects.filter(event=event).exists()


@pytest.mark.django_db
def test_the_cups_handed_back_in_the_same_basket_are_reversed_too(
    backoffice, till, event, beer, deposit
):
    """
    The customer put the net on the counter — the cups came off the bill — so
    the net is what the evening loses. Reversing the beer alone would leave the
    takings short by the cups for good.
    """
    sell(till, [
        {"item": beer.pk, "count": 4},
        {"item": deposit.pk, "count": 3, "refund": True},
    ])
    sale = PosSale.objects.get(event=event, kind=PosSale.KIND_SALE)
    returned = PosSale.objects.get(event=event, kind=PosSale.KIND_DEPOSIT_REFUND)

    cancel_in_back_office(backoffice, event, sale.order)

    [beer_back] = reversals_of(event, sale.seq)
    [cups_back] = reversals_of(event, returned.seq)
    assert beer_back.total == Decimal("-12.00")
    assert cups_back.total == Decimal("3.00")
    # As the till writes it: the order goes on the sale's half only.
    assert cups_back.order is None
    assert sum(row.total for row in PosSale.objects.filter(event=event)) == 0


@pytest.mark.django_db
def test_a_cancellation_that_keeps_a_fee_reverses_only_the_rest(
    backoffice, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 4}]).json()
    order = order_of(event, sale["order"]["code"])

    cancel_in_back_office(backoffice, event, order, cancellation_fee="2.00")

    order.refresh_from_db()
    assert order.total == Decimal("2.00")
    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.total == Decimal("-10.00")
    fee = reversal.positions[-1]
    assert (fee["fee"], fee["count"], fee["line_total"]) == ("cancellation", 1, "2.00")
    # What the evening keeps is exactly what pretix keeps.
    assert sum(row.total for row in PosSale.objects.filter(event=event)) == order.total


@pytest.mark.django_db
def test_a_cancellation_through_the_rest_api_names_the_token(
    organizer, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    token = api_token(organizer, event, name="Script de compta")

    response = api(
        token, "post", f"{event.slug}/orders/{sale['order']['code']}/mark_canceled/",
        {"send_email": False, "comment": "Remboursé par virement"},
    )

    assert response.status_code == 200
    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.cashier == "Script de compta"
    assert reversal.reason == "Remboursé par virement"


@pytest.mark.django_db
def test_a_cancellation_pretix_makes_on_nobody_s_behalf_names_nobody(till, event, beer):
    # A customer cancelling their own order, or pretix itself: the log entry
    # names no user and no token, and the row does not invent one.
    from pretix.base.services.orders import cancel_order

    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()

    cancel_order(order_of(event, sale["order"]["code"]).pk, send_mail=False)

    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.cashier == ""
    assert reversal.from_back_office


@pytest.mark.django_db
def test_a_cancellation_pretix_logged_nowhere_is_still_written(till, event, beer):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])
    Order.objects.filter(pk=order.pk).update(status=Order.STATUS_CANCELED)
    order.refresh_from_db()

    [reversal] = record_cancellation(order)

    assert (reversal.cashier, reversal.reason, reversal.total) == ("", "", Decimal("-3.00"))


@pytest.mark.django_db
def test_the_order_history_says_the_journal_followed(backoffice, till, event, beer):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])

    cancel_in_back_office(backoffice, event, order)

    entry = order.all_logentries().get(action_type="pretix_openpos.order.journal.cancelled")
    assert entry.parsed_data["rows"] == [
        {"seq": sale["journal_seq"] + 1, "cancels_seq": sale["journal_seq"], "total": "-3.00"},
    ]
    assert "Written to the till journal" in str(entry.display())
    assert f"#{sale['journal_seq'] + 1}, reversing #{sale['journal_seq']}" in str(entry.display())


@pytest.mark.django_db
def test_a_journal_that_cannot_be_written_does_not_stop_pretix(
    backoffice, till, event, beer, monkeypatch
):
    """
    pretix has cancelled the order by the time it tells the plugin. A failure
    here must not turn that into an error page, and must not go unsaid.
    """
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])

    def broken(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(PosSale, "record", broken)
    response = cancel_in_back_office(backoffice, event, order)

    assert response.status_code == 302
    order.refresh_from_db()
    assert order.status == Order.STATUS_CANCELED
    entry = order.all_logentries().get(action_type="pretix_openpos.order.journal.failed")
    assert "Sales page" in str(entry.display())
    # And the sale is waiting on the Sales page for somebody to write it.
    assert [s.seq for s in cancelled_outside_the_journal(event)] == [sale["journal_seq"]]


@pytest.mark.django_db
def test_the_same_cancellation_heard_twice_is_written_once(
    backoffice, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])
    cancel_in_back_office(backoffice, event, order)

    assert record_cancellation(order) == []
    assert len(reversals_of(event, sale["journal_seq"])) == 1


# -- and when pretix brings the order back ------------------------------------


@pytest.mark.django_db
def test_a_reactivated_order_is_back_in_the_takings(backoffice, till, event, beer):
    """
    Cancelled in pretix with nobody refunding it, then brought back: the money
    never moved, so the sale is takings again, and the till may cancel it.
    """
    sale = sell(till, [{"item": beer.pk, "count": 2}]).json()
    order = order_of(event, sale["order"]["code"])
    cancel_in_back_office(backoffice, event, order)
    [cancellation] = reversals_of(event, sale["journal_seq"])

    reactivate_in_back_office(backoffice, event, order)

    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    reactivation = PosSale.objects.get(event=event, kind=PosSale.KIND_REACTIVATION)
    assert reactivation.cancels_seq == cancellation.seq
    assert reactivation.total == Decimal("6.00")
    assert reactivation.from_back_office
    assert reactivation.cashier == "boss@example.org"
    assert sum(row.total for row in PosSale.objects.filter(event=event)) == Decimal("6.00")
    assert PosSale.cancelled_seqs(event, [sale["journal_seq"]]) == set()
    assert till_line(till, sale["journal_seq"])["can_cancel"] is True
    assert PosSale.verify_chain(event) is None
    entry = order.all_logentries().get(action_type="pretix_openpos.order.journal.reactivated")
    assert "the cancellation is undone" in str(entry.display())


@pytest.mark.django_db
def test_a_reactivation_the_journal_cannot_follow_is_said_on_the_order(
    backoffice, till, event, beer, monkeypatch
):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])
    cancel_in_back_office(backoffice, event, order)

    def broken(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(PosSale, "record", broken)
    reactivate_in_back_office(backoffice, event, order)

    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    entry = order.all_logentries().get(action_type="pretix_openpos.order.journal.failed")
    assert "reactivation could not be written" in str(entry.display())


@pytest.mark.django_db
def test_a_sale_can_go_round_more_than_once(backoffice, till, event, beer):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])

    cancel_in_back_office(backoffice, event, order)
    reactivate_in_back_office(backoffice, event, order)
    cancel_in_back_office(backoffice, event, order)

    assert len(reversals_of(event, sale["journal_seq"])) == 2
    assert PosSale.cancelled_seqs(event, [sale["journal_seq"]]) == {sale["journal_seq"]}
    assert sum(row.total for row in PosSale.objects.filter(event=event)) == 0

    reactivate_in_back_office(backoffice, event, order)

    assert PosSale.cancelled_seqs(event, [sale["journal_seq"]]) == set()
    assert sum(row.total for row in PosSale.objects.filter(event=event)) == Decimal("3.00")


@pytest.mark.django_db
def test_the_closing_screen_counts_a_reactivated_sale_as_sold_again(
    backoffice, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 2}]).json()
    order = order_of(event, sale["order"]["code"])
    cancel_in_back_office(backoffice, event, order)
    cancelled = till.get("summary").json()

    reactivate_in_back_office(backoffice, event, order)
    body = till.get("summary").json()

    assert cancelled["event"]["cancellations"] == 1
    assert cancelled["categories"] == []
    # Sold, and no longer one of the cancelled: the beers are back on the list.
    assert body["event"]["count"] == 1
    assert body["event"]["cancellations"] == 0
    assert body["event"]["cancelled_total"] == "0.00"
    assert body["event"]["total"] == "6.00"
    assert [
        (line["name"], line["count"], line["total"])
        for group in body["categories"]
        for line in group["items"]
    ] == [("Bière", 2, "6.00")]
    # The back office's line nets to nothing, and the till's is what its
    # drawer holds.
    assert [(line["name"], line["total"]) for line in body["devices"]] == [
        ("Caisse bar", "6.00"),
        (None, "0.00"),
    ]
    assert adds_up(body)


@pytest.mark.django_db
def test_an_evening_that_only_saw_the_order_come_back_knows_what_came_back(
    backoffice, till, event, beer, deposit
):
    """
    pretix can bring an order back days after it was cancelled, and the Sales
    page shows one evening at a time. The evening of the reactivation holds
    nothing else, and follows it through the cancellation it undoes to the
    rows it restores: the beers to the products, the cups to the deposits
    handed back. It counts one cancellation fewer, which is not announced.
    """
    sale = sell(
        till,
        [{"item": beer.pk, "count": 2}, {"item": deposit.pk, "count": 3, "refund": True}],
    ).json()
    order = order_of(event, sale["order"]["code"])
    cancel_in_back_office(backoffice, event, order)
    reactivate_in_back_office(backoffice, event, order)
    for row in PosSale.objects.filter(event=event):
        back = row.kind == PosSale.KIND_REACTIVATION
        on_night(event, row.idempotency_key, date(2026, 9, 26 if back else 19))

    response = backoffice.get(sales_url(event) + "?from=2026-09-26&to=2026-09-26")
    detail = response.context["detail"]

    (group,) = detail["categories"]
    assert [(line["name"], line["count"]) for line in group["items"]] == [("Bière", 2)]
    assert detail["deposits"]["returned"] == {"count": 3, "total": Decimal("-3.00")}
    assert response.context["totals"]["total"] == Decimal("3.00")
    assert "already taken off every figure" not in response.content.decode()


@pytest.mark.django_db
def test_a_reactivation_after_the_money_went_back_leaves_the_journal_alone(
    backoffice, till, event, beer
):
    """
    The till handed the cash back, so pretix brings the order back as pending:
    the customer holds the money again, and the drawer does not.
    """
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "annule-01"})

    reactivate_in_back_office(backoffice, event, order)

    order.refresh_from_db()
    assert order.status == Order.STATUS_PENDING
    assert not PosSale.objects.filter(event=event, kind=PosSale.KIND_REACTIVATION).exists()
    assert PosSale.cancelled_seqs(event, [sale["journal_seq"]]) == {sale["journal_seq"]}
    entry = order.all_logentries().get(action_type="pretix_openpos.order.journal.not_restored")
    assert "keeps this sale cancelled" in str(entry.display())


@pytest.mark.django_db
def test_a_till_cancellation_whose_refund_sumup_refused_comes_back_whole(
    backoffice, till, event, ticket, reader_till, sumup
):
    # The refund failed, so the money is with the association and pretix
    # brings the order back paid. The journal follows it.
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.next_response = FakeResponse(422, {"message": "too late"})
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "annule-01"})

    reactivate_in_back_office(backoffice, event, order)

    order.refresh_from_db()
    assert order.status == Order.STATUS_PAID
    assert PosSale.cancelled_seqs(event, [sale["journal_seq"]]) == set()
    # The till's own cancellation line now reads as undone.
    [cancellation] = reversals_of(event, sale["journal_seq"])
    assert till_line(till, cancellation.seq)["cancelled"] is True


# -- the Sales page ------------------------------------------------------------


@pytest.mark.django_db
def test_the_sales_page_puts_the_back_office_on_a_line_of_its_own(
    backoffice, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 1}], cashier="Camille").json()
    cancel_in_back_office(backoffice, event, order_of(event, sale["order"]["code"]))

    context = backoffice.get(sales_url(event)).context

    labels = {bucket["label"]: bucket["total"] for bucket in context["by_device"]}
    assert labels == {
        "Caisse bar · Camille": Decimal("3.00"),
        "pretix back office · boss@example.org": Decimal("-3.00"),
    }
    assert context["totals"]["total"] == Decimal("0.00")


@pytest.mark.django_db
def test_the_export_names_the_back_office_too(backoffice, till, event, beer):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    cancel_in_back_office(backoffice, event, order_of(event, sale["order"]["code"]))

    response = backoffice.get(sales_url(event) + "?export=csv")

    rows = b"".join(response.streaming_content).decode("utf-8").splitlines()
    cancellation = next(row for row in rows if row.split(";")[1] == "cancellation")
    assert cancellation.split(";")[4] == "pretix back office"
    assert cancellation.split(";")[6] == "boss@example.org"


@pytest.mark.django_db
def test_the_new_lines_of_the_sales_page_read_in_french(backoffice, till, event, beer):
    from pretix.base.models import User

    User.objects.filter(email="boss@example.org").update(locale="fr")
    kept = sell(till, [{"item": beer.pk, "count": 1}], idempotency_key="garde-1-xx").json()
    missed = sell(till, [{"item": beer.pk, "count": 1}], idempotency_key="rate-1-xx").json()
    cancel_in_back_office(backoffice, event, order_of(event, kept["order"]["code"]))
    cancelled_before_open_pos_listened(
        backoffice, event, order_of(event, missed["order"]["code"])
    )

    page = backoffice.get(sales_url(event)).content.decode()

    assert "back-office pretix · boss@example.org" in page
    assert "Annulées dans pretix, encore comptées ici" in page
    assert "Les écrire au journal" in page


def cancelled_before_open_pos_listened(backoffice, event, order):
    """A cancellation made in pretix while nothing wrote it to the journal."""
    with till_cancelling():
        cancel_in_back_office(backoffice, event, order, comment="Avant la 0.19")


@pytest.mark.django_db
def test_a_sale_cancelled_before_this_existed_is_listed(backoffice, till, event, beer):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    cancelled_before_open_pos_listened(
        backoffice, event, order_of(event, sale["order"]["code"])
    )

    page = backoffice.get(sales_url(event))

    assert [s.seq for s in page.context["missed_cancellations"]] == [sale["journal_seq"]]
    assert "Cancelled in pretix, still counted here" in page.content.decode()
    assert "Write them to the journal" in page.content.decode()


@pytest.mark.django_db
def test_writing_them_in_dates_each_one_when_pretix_cancelled_it(
    backoffice, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])
    cancelled_before_open_pos_listened(backoffice, event, order)
    when = order.all_logentries().get(action_type="pretix.event.order.canceled").datetime

    response = backoffice.post(sales_url(event) + "catch-up/")

    assert response.status_code == 302
    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.datetime == when
    assert reversal.cashier == "boss@example.org"
    assert reversal.reason == "Avant la 0.19"
    assert cancelled_outside_the_journal(event) == []
    entry = order.all_logentries().get(action_type="pretix_openpos.order.journal.cancelled")
    assert entry.parsed_data["late"] is True
    assert "written to the till journal only now" in str(entry.display())
    page = backoffice.get(sales_url(event)).content.decode()
    assert "Cancelled in pretix, still counted here" not in page


@pytest.mark.django_db
def test_a_cancellation_that_kept_a_fee_is_listed_and_written_in_too(
    backoffice, till, event, beer
):
    # pretix leaves such an order paid, at the fee. Its cancellation date is
    # what says it was cancelled.
    sale = sell(till, [{"item": beer.pk, "count": 4}]).json()
    order = order_of(event, sale["order"]["code"])
    with till_cancelling():
        cancel_in_back_office(backoffice, event, order, cancellation_fee="2.00")

    assert [s.seq for s in cancelled_outside_the_journal(event)] == [sale["journal_seq"]]
    backoffice.post(sales_url(event) + "catch-up/")

    [reversal] = reversals_of(event, sale["journal_seq"])
    assert reversal.total == Decimal("-10.00")


@pytest.mark.django_db
def test_a_catch_up_that_fails_says_so(backoffice, till, event, beer, monkeypatch):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    cancelled_before_open_pos_listened(
        backoffice, event, order_of(event, sale["order"]["code"])
    )

    def broken(*args, **kwargs):
        raise RuntimeError("disk full")

    monkeypatch.setattr(PosSale, "record", broken)
    response = backoffice.post(sales_url(event) + "catch-up/", follow=True)

    assert "could not be written" in response.content.decode()
    assert len(cancelled_outside_the_journal(event)) == 1


@pytest.mark.django_db
def test_nothing_to_catch_up_is_said_too(backoffice, event):
    response = backoffice.post(sales_url(event) + "catch-up/", follow=True)

    assert "already in the journal" in response.content.decode()


@pytest.mark.django_db
def test_writing_to_the_journal_needs_the_right_to_change_orders(
    reader, backoffice, till, event, beer
):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    cancelled_before_open_pos_listened(
        backoffice, event, order_of(event, sale["order"]["code"])
    )

    page = reader.get(sales_url(event))
    # Listed for whoever reads the takings, since it is about them...
    assert "Cancelled in pretix, still counted here" in page.content.decode()
    # ...and the button left to whoever may act on it.
    assert "Write them to the journal" not in page.content.decode()
    assert reader.post(sales_url(event) + "catch-up/").status_code == 403
    assert len(cancelled_outside_the_journal(event)) == 1


@pytest.mark.django_db
def test_a_reactivated_order_is_not_listed(backoffice, till, event, beer):
    sale = sell(till, [{"item": beer.pk, "count": 1}]).json()
    order = order_of(event, sale["order"]["code"])
    cancelled_before_open_pos_listened(backoffice, event, order)

    reactivate_in_back_office(backoffice, event, order)

    assert cancelled_outside_the_journal(event) == []
    # Never reversed in the journal, never needed restoring either.
    assert not PosSale.objects.filter(event=event).exclude(kind=PosSale.KIND_SALE).exists()


# -- giving a card back from pretix --------------------------------------------


def provider_for(payment):
    return payment.payment_provider


@pytest.mark.django_db
def test_the_refund_dialog_offers_a_card_a_reader_took(
    till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    payment = order_of(event, sale["order"]["code"]).payments.get()

    assert provider_for(payment).payment_refund_supported(payment) is True
    # The whole transaction or nothing, as the till does it.
    assert provider_for(payment).payment_partial_refund_supported(payment) is False


@pytest.mark.django_db
def test_not_a_card_taken_on_somebody_s_phone(till, event, ticket, sumup):
    sale = sell(till, [{"item": ticket.pk, "count": 1}], payment_type="card").json()
    payment = order_of(event, sale["order"]["code"]).payments.get()

    assert provider_for(payment).payment_refund_supported(payment) is False


@pytest.mark.django_db
def test_not_a_card_already_given_back(till, event, ticket, reader_till, sumup):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    payment = order_of(event, sale["order"]["code"]).payments.get()
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "annule-01"})

    assert provider_for(payment).payment_refund_supported(payment) is False


@pytest.mark.django_db
def test_not_once_sumup_is_no_longer_set_up(
    organizer, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    payment = order_of(event, sale["order"]["code"]).payments.get()
    organizer.settings.delete("openpos_sumup_api_key")

    assert provider_for(payment).payment_refund_supported(payment) is False


@pytest.mark.django_db
def test_cancel_then_refund_on_the_card_from_pretix_s_own_dialog(
    backoffice, till, event, ticket, reader_till, sumup
):
    """The whole of what Ad asked for, through the screens pretix shows."""
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    payment = order.payments.get()

    response = cancel_in_back_office(backoffice, event, order)

    # pretix goes straight to "how do you want to give the money back?"...
    assert "/refund?" in response["Location"]
    dialog = backoffice.get(response["Location"]).content.decode()
    # ...and the card is offered, ticked, for its full amount.
    assert f'name="refund-{payment.pk}"' in dialog
    assert "checked" in dialog.split(f'name="refund-{payment.pk}"')[1].split(">")[0]

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

    assert sumup.refunds == [("tx_1", None)]
    refund = order.refunds.get()
    assert refund.state == OrderRefund.REFUND_STATE_DONE
    assert refund.provider == "openpos_card"
    assert refund.info_data["transaction_id"] == "tx_1"
    assert PosTerminalPayment.objects.get().refunded is not None
    # And the journal already had the cancellation, from the first step.
    assert len(reversals_of(event, sale["journal_seq"])) == 1


@pytest.mark.django_db
def test_refund_on_the_card_through_the_rest_api(
    organizer, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    token = api_token(organizer, event)

    response = api(
        token, "post", f"{event.slug}/orders/{order.code}/payments/1/refund/",
        {"amount": "10.00", "mark_canceled": True},
    )

    assert response.status_code == 200, response.content
    assert sumup.refunds == [("tx_1", None)]
    order.refresh_from_db()
    # Refunded first and cancelled by pretix after: the journal hears of it
    # all the same.
    assert order.status == Order.STATUS_CANCELED
    assert len(reversals_of(event, sale["journal_seq"])) == 1


@pytest.mark.django_db
def test_a_part_of_the_payment_is_left_to_the_sumup_app(
    organizer, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    token = api_token(organizer, event)

    response = api(
        token, "post", f"{event.slug}/orders/{sale['order']['code']}/payments/1/refund/",
        {"amount": "4.00"},
    )

    assert response.status_code == 400
    assert sumup.refunds == []


@pytest.mark.django_db
def test_a_refund_sumup_refuses_fails_in_pretix_and_is_listed(
    backoffice, organizer, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    token = api_token(organizer, event)
    sumup.next_response = FakeResponse(409, {"message": "not refundable"})

    response = api(
        token, "post", f"{event.slug}/orders/{order.code}/payments/1/refund/",
        {"amount": "10.00"},
    )

    assert response.status_code == 400
    assert "SumUp refused this request" in response.json()["detail"]
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_FAILED
    assert PosTerminalPayment.objects.get().refunded is None
    page = backoffice.get(sales_url(event)).content.decode()
    assert "Card refunds SumUp refused" in page


@pytest.mark.django_db
def test_a_refund_sumup_did_not_answer_says_to_look_before_trying_again(
    organizer, till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    token = api_token(organizer, event)
    sumup.next_exception = requests.ConnectTimeout("no route")

    response = api(
        token, "post", f"{event.slug}/orders/{order.code}/payments/1/refund/",
        {"amount": "10.00"},
    )

    assert response.status_code == 400
    detail = response.json()["detail"]
    assert "not known whether the money went back" in detail
    assert "tx_1" in detail
    assert order.refunds.get().state == OrderRefund.REFUND_STATE_FAILED


@pytest.mark.django_db
def test_a_refused_till_refund_given_back_from_pretix_leaves_the_list(
    backoffice, organizer, till, event, ticket, reader_till, sumup
):
    """
    The till's refund was refused; the organiser gives it back the next
    morning from pretix. The failed refund stays on the order, as pretix keeps
    it, and the Sales page stops asking for it.
    """
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    sumup.next_response = FakeResponse(422, {"message": "too late"})
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "annule-01"})
    assert "Card refunds SumUp refused" in backoffice.get(sales_url(event)).content.decode()
    token = api_token(organizer, event)

    response = api(
        token, "post", f"{event.slug}/orders/{order.code}/payments/1/refund/",
        {"amount": "10.00"},
    )

    assert response.status_code == 200, response.content
    assert sumup.refunds == [("tx_1", None)]
    assert sorted(r.state for r in order.refunds.all()) == [
        OrderRefund.REFUND_STATE_DONE, OrderRefund.REFUND_STATE_FAILED,
    ]
    assert "Card refunds SumUp refused" not in backoffice.get(sales_url(event)).content.decode()


@pytest.mark.django_db
def test_the_provider_never_sends_a_card_back_twice(
    till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    payment = order.payments.get()
    PosTerminalPayment.objects.update(refunded="2026-09-19T23:00:00Z")
    refund = order.refunds.create(
        payment=payment, amount=payment.amount, provider=payment.provider,
        state=OrderRefund.REFUND_STATE_CREATED, source=OrderRefund.REFUND_SOURCE_ADMIN,
    )

    with pytest.raises(PaymentException, match="already been refunded"):
        provider_for(payment).execute_refund(refund)
    assert sumup.refunds == []


@pytest.mark.django_db
def test_the_provider_refuses_what_no_reader_took(till, event, ticket, sumup):
    sale = sell(till, [{"item": ticket.pk, "count": 1}], payment_type="card").json()
    order = order_of(event, sale["order"]["code"])
    payment = order.payments.get()
    refund = order.refunds.create(
        payment=payment, amount=payment.amount, provider=payment.provider,
        state=OrderRefund.REFUND_STATE_CREATED, source=OrderRefund.REFUND_SOURCE_ADMIN,
    )

    with pytest.raises(PaymentException, match="SumUp app"):
        provider_for(payment).execute_refund(refund)


@pytest.mark.django_db
def test_the_provider_refuses_a_part_even_when_asked_directly(
    till, event, ticket, reader_till, sumup
):
    sale = card_sale(till, sumup, [{"item": ticket.pk, "count": 1}])
    order = order_of(event, sale["order"]["code"])
    payment = order.payments.get()
    refund = order.refunds.create(
        payment=payment, amount=Decimal("4.00"), provider=payment.provider,
        state=OrderRefund.REFUND_STATE_CREATED, source=OrderRefund.REFUND_SOURCE_ADMIN,
    )

    with pytest.raises(PaymentException, match="whole payment"):
        provider_for(payment).execute_refund(refund)
    assert sumup.refunds == []
