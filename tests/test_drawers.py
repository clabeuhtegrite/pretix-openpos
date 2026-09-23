"""
The cash drawer, as a till meets it.

A till given a drawer takes cash into an opening of that drawer and nowhere
else: opened on a counted float, fed by the cash sales, topped up or emptied
by hand with a reason, counted blind, closed. Every one of those steps is
checked here over HTTP, with a real device token, because the refusals are
the point — a stale or edited app has to meet them exactly as a fresh one
does. What the drawer should hold is never stored, so every test that cares
about it asks for it the way the closing does.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import Order

from pretix_openpos.drawers import (
    DrawerError, check_denominations, close_drawer, count_drawer, denominations_for, figures, move_cash, open_drawer,
    session_at,
)
from pretix_openpos.models import GENESIS_HASH, PosDevice, PosDrawer, PosDrawerEntry, PosDrawerSession, PosSale

from .conftest import sell


def give_drawer(device, name="Bar", opening_float=None):
    """A drawer of this device's organizer, and the device put on it."""
    drawer, _created = PosDrawer.objects.get_or_create(
        organizer=device.organizer, name=name, defaults={"opening_float": opening_float}
    )
    PosDevice.objects.update_or_create(device=device, defaults={"drawer": drawer})
    return drawer


def open_it(till, amount="100.00", key="open-00001", **extra):
    return till.post("drawer/open", {"idempotency_key": key, "amount": amount, **extra})


def count_it(till, amount, key="count-00001", **extra):
    return till.post("drawer/count", {"idempotency_key": key, "amount": amount, **extra})


def close_it(till, count_seq=None, key="close-00001", **extra):
    body = {"idempotency_key": key, **extra}
    if count_seq is not None:
        body["count_seq"] = count_seq
    return till.post("drawer/close", body)


def move(till, kind, amount, reason="Monnaie", key="move-00001"):
    return till.post(
        "drawer/movement",
        {"idempotency_key": key, "kind": kind, "amount": amount, "reason": reason},
    )


def a_beer(beer, count=1):
    return [{"item": beer.pk, "count": count}]


def expected_of(drawer):
    return figures(drawer.sessions.get(closed_at__isnull=True))["expected"]


def make_stale(drawer):
    """The opening of a drawer nobody closed last week."""
    PosDrawerSession.objects.filter(drawer=drawer, closed_at__isnull=True).update(
        opened_at=now() - timedelta(days=7)
    )


# -- a till with no drawer ---------------------------------------------------


@pytest.mark.django_db
def test_a_till_without_a_drawer_is_told_so_and_sells_as_before(till, beer):
    assert till.get("config").json()["drawer"] is None
    assert till.get("drawer").json() == {"drawer": None, "session": None, "last_closed": None}

    response = sell(till, a_beer(beer))

    assert response.status_code == 201, response.content
    assert PosSale.objects.get().drawer_session is None


@pytest.mark.django_db
@pytest.mark.parametrize("action", ["drawer/open", "drawer/count", "drawer/movement", "drawer/close"])
def test_a_till_without_a_drawer_cannot_act_on_one(till, action):
    response = till.post(action, {"idempotency_key": "whatever-1", "amount": "1.00"})

    assert response.status_code == 400
    assert response.json()["code"] == "no_drawer"


# -- opening ---------------------------------------------------------------


@pytest.mark.django_db
def test_the_till_is_told_its_drawer_is_closed_before_anybody_taps_cash(till, device):
    give_drawer(device, opening_float=Decimal("150.00"))

    config = till.get("config").json()
    state = till.get("drawer").json()

    assert config["drawer"] == {
        "id": device.openpos_device.drawer_id, "name": "Bar", "open": False, "stale": False,
    }
    assert state["session"] is None
    assert state["last_closed"] is None
    # The float it usually starts with, for the till to offer.
    assert state["drawer"]["opening_float"] == "150.00"
    assert state["drawer"]["currency"] == "EUR"


@pytest.mark.django_db
def test_notes_and_coins_are_offered_in_the_event_s_currency(till, device):
    give_drawer(device)

    values = [d["value"] for d in till.get("drawer").json()["drawer"]["denominations"]]

    assert values[0] == "200.00" and values[-1] == "0.01"
    assert "0.50" in values
    assert denominations_for("XXX") == []


@pytest.mark.django_db
def test_opening_writes_the_float_and_says_the_drawer_is_open(till, device):
    drawer = give_drawer(device)

    response = open_it(till, "120.50", cashier="Léa")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["session"]["opening_float"] == "120.50"
    assert body["session"]["opened_by"] == "Léa"
    assert body["session"]["stale"] is False
    assert body["session"]["count"] is None
    assert body["entry"]["kind"] == "open"
    assert till.get("config").json()["drawer"]["open"] is True
    (entry,) = PosDrawerEntry.objects.filter(drawer=drawer)
    assert entry.seq == 1 and entry.previous_hash == GENESIS_HASH
    assert entry.device_serial == device.unique_serial
    assert entry.amount == Decimal("120.50")


@pytest.mark.django_db
def test_a_float_counted_note_by_note_is_kept_and_has_to_add_up(till, device):
    drawer = give_drawer(device)

    wrong = open_it(till, "100.00", denominations={"20.00": 3})
    unknown = open_it(till, "7.00", denominations={"7": 1})
    right = open_it(till, "62.00", denominations={"20": 3, "1.00": 2, "0.50": 0})

    assert wrong.status_code == 400
    assert "60.00" in str(wrong.json()["denominations"])
    assert unknown.status_code == 400
    assert right.status_code == 200, right.content
    # One spelling per note, and nothing for the rows left at zero.
    assert PosDrawerEntry.objects.get(drawer=drawer).denominations == {"20.00": 3, "1.00": 2}


@pytest.mark.django_db
def test_a_denomination_that_is_not_a_number_is_refused(till, device):
    give_drawer(device)

    response = open_it(till, "10.00", denominations={"dix": 1})

    assert response.status_code == 400
    assert "denominations" in response.json()


@pytest.mark.django_db
def test_opening_twice_is_one_opening_and_a_second_one_is_refused(till, another_till, device):
    drawer = give_drawer(device)
    give_drawer(another_till.device)

    first = open_it(till)
    retried = open_it(till)
    other = open_it(another_till, key="open-00002")

    assert first.status_code == retried.status_code == 200
    assert PosDrawerSession.objects.filter(drawer=drawer).count() == 1
    assert PosDrawerEntry.objects.filter(drawer=drawer).count() == 1
    # The other tablet at the same bar finds it open, rather than opening it
    # again on a float nobody counted twice.
    assert other.status_code == 400
    assert other.json()["code"] == "drawer_open"


# -- selling into it -------------------------------------------------------


@pytest.mark.django_db
def test_cash_into_a_closed_drawer_is_refused_and_nothing_is_written(till, device, beer):
    give_drawer(device)

    response = sell(till, a_beer(beer))

    assert response.status_code == 400
    assert response.json()["code"] == "drawer_closed"
    assert not PosSale.objects.exists()
    assert not Order.objects.exists()


@pytest.mark.django_db
def test_card_is_never_held_up_by_the_drawer(till, device, beer):
    give_drawer(device)

    response = sell(till, a_beer(beer), payment_type="card")

    assert response.status_code == 201, response.content
    assert PosSale.objects.get().drawer_session is None


@pytest.mark.django_db
def test_sales_go_into_the_open_drawer_card_included(till, device, beer):
    drawer = give_drawer(device)
    open_it(till)

    sell(till, a_beer(beer, 2), idempotency_key="sale-00001")
    sell(till, a_beer(beer), idempotency_key="sale-00002", payment_type="card")

    session = drawer.sessions.get()
    assert set(PosSale.objects.values_list("drawer_session", flat=True)) == {session.pk}
    result = figures(session)
    assert result["cash_sales"] == Decimal("6.00")
    assert result["card"] == Decimal("3.00")
    assert result["card_count"] == 1
    # The card never reaches the drawer.
    assert result["expected"] == Decimal("106.00")


@pytest.mark.django_db
def test_two_tablets_sharing_a_drawer_sell_into_the_same_opening(till, another_till, device, beer):
    drawer = give_drawer(device)
    give_drawer(another_till.device)
    open_it(till)

    sell(till, a_beer(beer), idempotency_key="sale-00001")
    sell(another_till, a_beer(beer), idempotency_key="sale-00002")

    assert expected_of(drawer) == Decimal("106.00")


@pytest.mark.django_db
def test_a_drawer_left_open_since_an_earlier_day_takes_no_cash_tonight(till, device, beer):
    drawer = give_drawer(device)
    open_it(till)
    make_stale(drawer)

    cash = sell(till, a_beer(beer), idempotency_key="sale-00001")
    card = sell(till, a_beer(beer), idempotency_key="sale-00002", payment_type="card")

    assert till.get("config").json()["drawer"]["stale"] is True
    assert cash.status_code == 400
    assert cash.json()["code"] == "drawer_stale"
    # Card goes through, and is not filed under last week's evening.
    assert card.status_code == 201
    assert PosSale.objects.get().drawer_session is None


@pytest.mark.django_db
def test_a_replayed_sale_goes_into_the_opening_it_was_rung_up_in(till, device, beer):
    """Even closed since, and even with the drawer closed now: the cash is in it."""
    drawer = give_drawer(device)
    open_it(till)
    session = drawer.sessions.get()
    PosDrawerSession.objects.filter(pk=session.pk).update(opened_at=now() - timedelta(hours=3))
    count = count_it(till, "100.00").json()["entry"]
    close_it(till, count["seq"])

    during = sell(
        till, [{"item": beer.pk, "count": 1, "price": "3.00"}],
        idempotency_key="offline-00001",
        offline={"recorded_at": (now() - timedelta(hours=1)).isoformat(), "charged_total": "3.00"},
    )
    before = sell(
        till, [{"item": beer.pk, "count": 1, "price": "3.00"}],
        idempotency_key="offline-00002",
        offline={"recorded_at": (now() - timedelta(hours=5)).isoformat(), "charged_total": "3.00"},
    )

    assert during.status_code == before.status_code == 201
    assert PosSale.objects.get(idempotency_key="offline-00001").drawer_session_id == session.pk
    assert PosSale.objects.get(idempotency_key="offline-00002").drawer_session is None
    # And the closing report sees it arrive after the count.
    session.refresh_from_db()
    closing = session.entries.get(kind=PosDrawerEntry.KIND_CLOSE)
    assert figures(session)["expected"] == closing.expected + Decimal("3.00")
    assert session_at(None, now()) is None


@pytest.mark.django_db
def test_returned_deposits_and_cancellations_come_out_of_the_drawer(till, device, beer, deposit):
    drawer = give_drawer(device)
    open_it(till)

    sale = sell(till, a_beer(beer, 2), idempotency_key="sale-00001").json()
    sell(till, [{"item": deposit.pk, "count": 2, "refund": True}], idempotency_key="cups-00001")
    cancelled = till.post(
        "cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-00001"}
    )

    assert cancelled.status_code == 201, cancelled.content
    result = figures(drawer.sessions.get())
    assert result["cash_sales"] == Decimal("6.00")
    assert result["cash_cancellations"] == Decimal("-6.00")
    assert result["deposit_refunds"] == Decimal("-2.00")
    assert result["expected"] == Decimal("98.00")
    assert PosSale.objects.get(kind=PosSale.KIND_CANCELLATION).drawer_session is not None


@pytest.mark.django_db
def test_cash_cannot_be_handed_back_from_a_closed_drawer(till, device, beer):
    drawer = give_drawer(device)
    open_it(till)
    sale = sell(till, a_beer(beer), idempotency_key="sale-00001").json()
    count = count_it(till, "103.00").json()["entry"]
    close_it(till, count["seq"])

    response = till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-00001"})

    assert response.status_code == 400
    assert response.json()["code"] == "drawer_closed"
    assert not PosSale.objects.filter(kind=PosSale.KIND_CANCELLATION).exists()
    assert drawer.sessions.get().closed_at is not None


@pytest.mark.django_db
def test_a_card_sale_can_be_cancelled_with_the_drawer_closed(till, device, beer):
    give_drawer(device)
    sale = sell(till, a_beer(beer), payment_type="card").json()

    response = till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-00001"})

    assert response.status_code == 201, response.content


@pytest.mark.django_db
def test_test_mode_sales_are_counted_apart(till, device, event, beer):
    drawer = give_drawer(device)
    open_it(till)
    event.testmode = True
    event.save()

    sell(till, a_beer(beer))

    result = figures(drawer.sessions.get())
    assert result["cash_sales"] == Decimal("0.00")
    assert result["testmode_count"] == 1
    assert result["expected"] == Decimal("100.00")


@pytest.mark.django_db
def test_a_drawer_closed_under_a_sale_s_feet_refuses_the_cash(till, device, beer):
    """The lock the checkout takes finds the opening closed, and writes nothing."""
    from rest_framework.exceptions import ValidationError

    from pretix_openpos.api.views import hold_drawer_session

    drawer = give_drawer(device)
    open_it(till)
    session = drawer.sessions.get()
    count = count_it(till, "100.00").json()["entry"]
    close_it(till, count["seq"])

    with pytest.raises(ValidationError) as refusal:
        hold_drawer_session(session, PosSale.PAYMENT_CASH)

    assert refusal.value.detail["code"] == "drawer_closed"
    assert hold_drawer_session(session, PosSale.PAYMENT_CARD) is None
    assert hold_drawer_session(None, PosSale.PAYMENT_CASH) is None


# -- money in and out ------------------------------------------------------


@pytest.mark.django_db
def test_money_put_in_and_taken_out_moves_what_the_drawer_should_hold(till, device):
    drawer = give_drawer(device)
    open_it(till)

    put_in = move(till, "in", "50.00", "Monnaie de la banque", key="move-00001")
    taken = move(till, "out", "30.00", "Glaçons", key="move-00002")

    assert put_in.status_code == taken.status_code == 200
    movements = taken.json()["session"]["movements"]
    assert [(m["kind"], m["amount"], m["reason"]) for m in movements] == [
        ("in", "50.00", "Monnaie de la banque"),
        ("out", "30.00", "Glaçons"),
    ]
    assert expected_of(drawer) == Decimal("120.00")


@pytest.mark.django_db
def test_money_cannot_move_through_a_closed_drawer(till, device):
    give_drawer(device)

    response = move(till, "out", "30.00")

    assert response.status_code == 400
    assert response.json()["code"] == "drawer_closed"


@pytest.mark.django_db
def test_a_movement_needs_a_reason_and_an_amount(till, device):
    give_drawer(device)
    open_it(till)

    blank = move(till, "out", "30.00", reason="  ")
    nothing = move(till, "in", "0.00", key="move-00002")

    assert blank.status_code == 400
    assert nothing.status_code == 400
    assert PosDrawerEntry.objects.count() == 1


@pytest.mark.django_db
def test_the_ledger_refuses_what_the_api_would_never_send(device):
    drawer = give_drawer(device)
    open_drawer(drawer, idempotency_key="open-00001", amount=Decimal("10.00"))

    for kind, amount, reason in (("sideways", Decimal("1.00"), "x"), ("in", Decimal("0"), "x"),
                                 ("in", None, "x"), ("out", Decimal("1.00"), "")):
        with pytest.raises(DrawerError):
            move_cash(drawer, idempotency_key=f"move-{kind}-{amount}", kind=kind,
                      amount=amount, reason=reason)


# -- counting and closing --------------------------------------------------


@pytest.mark.django_db
def test_the_count_is_blind_until_it_is_written_down(till, device, beer):
    give_drawer(device)
    open_it(till)
    sell(till, a_beer(beer, 4))

    before = till.get("drawer").json()
    counted = count_it(till, "110.00")

    # Nothing the till is handed before the count says what it should find.
    assert "expected" not in str(before)
    assert counted.status_code == 200, counted.content
    entry = counted.json()["entry"]
    assert entry["expected"] == "112.00"
    assert entry["difference"] == "-2.00"
    assert counted.json()["session"]["count"]["current"] is True


@pytest.mark.django_db
def test_closing_on_the_count_just_made(till, device, beer):
    drawer = give_drawer(device)
    open_it(till)
    sell(till, a_beer(beer))
    count = count_it(till, "103.00").json()["entry"]

    response = close_it(till, count["seq"], reason="RAS", cashier="Léa")

    assert response.status_code == 200, response.content
    body = response.json()
    assert body["session"] is None
    assert body["last_closed"]["amount"] == "103.00"
    assert body["last_closed"]["expected"] == "103.00"
    assert body["last_closed"]["difference"] == "0.00"
    assert body["last_closed"]["cashier"] == "Léa"
    assert till.get("config").json()["drawer"]["open"] is False
    session = drawer.sessions.get()
    assert session.closed_at is not None
    closing = session.entries.get(kind=PosDrawerEntry.KIND_CLOSE)
    assert closing.reason == "RAS"
    assert closing.datetime == session.closed_at


@pytest.mark.django_db
def test_a_recount_is_kept_and_the_closing_uses_the_last_one(till, device):
    drawer = give_drawer(device)
    open_it(till)
    first = count_it(till, "95.00", key="count-00001").json()["entry"]
    second = count_it(till, "100.00", key="count-00002").json()["entry"]

    stale = close_it(till, first["seq"])
    closed = close_it(till, second["seq"], key="close-00002")

    assert stale.status_code == 400
    assert stale.json()["code"] == "count_stale"
    assert closed.status_code == 200
    assert drawer.entries.filter(kind=PosDrawerEntry.KIND_COUNT).count() == 2


@pytest.mark.django_db
def test_a_sale_between_the_count_and_the_closing_asks_for_a_recount(till, another_till, device, beer):
    give_drawer(device)
    give_drawer(another_till.device)
    open_it(till)
    count = count_it(till, "100.00").json()["entry"]

    # The other tablet at the bar sells a beer while this one is being counted.
    sell(another_till, a_beer(beer))
    state = till.get("drawer").json()
    response = close_it(till, count["seq"])

    assert state["session"]["count"]["current"] is False
    assert response.status_code == 400
    assert response.json()["code"] == "count_stale"


@pytest.mark.django_db
def test_closing_needs_a_count(till, device):
    give_drawer(device)
    open_it(till)

    missing = close_it(till)
    unknown = close_it(till, 99, key="close-00002")

    assert missing.status_code == 400
    assert unknown.status_code == 400
    assert unknown.json()["code"] == "count_required"


@pytest.mark.django_db
def test_counting_or_closing_a_closed_drawer_says_it_is_closed(till, device):
    give_drawer(device)

    closing = close_it(till, 1)
    counting = count_it(till, "10.00")

    assert closing.status_code == counting.status_code == 400
    assert closing.json()["code"] == counting.json()["code"] == "drawer_closed"


@pytest.mark.django_db
def test_a_drawer_forgotten_since_last_week_can_be_closed_uncounted(till, device):
    drawer = give_drawer(device)
    open_it(till)
    make_stale(drawer)

    response = close_it(till, uncounted=True, reason="Oubliée samedi")

    assert response.status_code == 200, response.content
    assert response.json()["last_closed"]["amount"] is None
    assert response.json()["last_closed"]["difference"] is None
    # And tonight's can be opened.
    assert open_it(till, key="open-00002").status_code == 200


@pytest.mark.django_db
def test_tonight_s_drawer_cannot_be_closed_uncounted(till, device):
    give_drawer(device)
    open_it(till)

    response = close_it(till, uncounted=True)

    assert response.status_code == 400
    assert response.json()["code"] == "count_required"


@pytest.mark.django_db
def test_the_last_closing_is_what_a_closed_drawer_shows(till, device):
    give_drawer(device)
    open_it(till)
    count = count_it(till, "98.00").json()["entry"]
    close_it(till, count["seq"])

    state = till.get("drawer").json()

    assert state["session"] is None
    assert state["last_closed"]["difference"] == "-2.00"


@pytest.mark.django_db
def test_every_drawer_write_is_idempotent(till, device):
    drawer = give_drawer(device)
    open_it(till)
    for _attempt in range(2):
        move(till, "in", "10.00")
        count_it(till, "110.00")
    count = PosDrawerEntry.objects.get(kind=PosDrawerEntry.KIND_COUNT)
    for _attempt in range(2):
        assert close_it(till, count.seq).status_code == 200

    assert list(drawer.entries.values_list("kind", flat=True)) == ["open", "in", "count", "close"]
    # A retry of the count answers with the same figures.
    assert count_drawer(drawer, idempotency_key="count-00001", amount=Decimal("1")) == count


@pytest.mark.django_db
def test_the_back_office_can_close_on_an_amount(device):
    drawer = give_drawer(device)
    open_drawer(drawer, idempotency_key="open-00001", amount=Decimal("10.00"))

    with pytest.raises(DrawerError):
        close_drawer(drawer, idempotency_key="close-00001")
    entry = close_drawer(drawer, idempotency_key="close-00002", amount=Decimal("12.00"),
                         source=PosDrawerEntry.SOURCE_BACKOFFICE)

    assert entry.difference == Decimal("2.00")
    assert entry.source == PosDrawerEntry.SOURCE_BACKOFFICE


# -- the takings screen is not the drawer ------------------------------------


@pytest.mark.django_db
def test_the_takings_screen_counts_sales_and_never_what_the_drawer_holds(till, device, beer):
    # The event's takings stay whole on a till with a drawer: they are what
    # the evening sold, and were asked for as such. What the drawer should
    # hold is another figure — the float, money put in and taken out — and
    # the till is only ever given it next to a count.
    give_drawer(device)
    open_it(till)
    sell(till, a_beer(beer), idempotency_key="sale-00001")
    sell(till, a_beer(beer), idempotency_key="sale-00002", payment_type="card")
    move(till, "in", "50.00")

    summary = till.get("summary").json()

    assert summary["device"]["cash"] == "3.00"
    assert summary["event"]["cash"] == "3.00"
    assert summary["event"]["card"] == "3.00"
    assert "drawer" not in summary


# -- the ledger itself -----------------------------------------------------


@pytest.mark.django_db
def test_the_ledger_is_append_only(till, device):
    give_drawer(device)
    open_it(till)
    entry = PosDrawerEntry.objects.get()

    with pytest.raises(ValueError):
        entry.save()
    with pytest.raises(ValueError):
        entry.delete()


@pytest.mark.django_db
def test_a_lowered_float_breaks_the_chain_and_is_found(till, device):
    drawer = give_drawer(device)
    open_it(till)
    move(till, "in", "10.00")
    assert PosDrawerEntry.verify_chain(drawer) is None

    PosDrawerEntry.objects.filter(drawer=drawer, seq=1).update(amount=Decimal("50.00"))

    assert PosDrawerEntry.verify_chain(drawer).seq == 1


@pytest.mark.django_db
def test_a_sale_moved_to_another_opening_breaks_the_journal(till, device, event, beer):
    drawer = give_drawer(device)
    open_it(till)
    sale = sell(till, a_beer(beer)).json()
    other = PosDrawerSession.objects.create(drawer=drawer, opened_at=now(), closed_at=now())
    assert PosSale.verify_chain(event) is None
    assert PosSale.objects.get().hash_version == 5

    PosSale.objects.filter(seq=sale["journal_seq"]).update(drawer_session=other)

    assert PosSale.verify_chain(event).seq == sale["journal_seq"]


@pytest.mark.django_db
def test_a_count_given_note_by_note_is_checked_against_its_currency():
    assert check_denominations({}, Decimal("5.00"), "EUR") is None
    assert check_denominations({"5.00": 1}, Decimal("5.00"), "EUR") is None
    assert check_denominations({"5.00": 1}, Decimal("5.00"), "XXX") is not None


@pytest.mark.django_db
def test_the_names_of_the_new_rows_read_well(till, device):
    drawer = give_drawer(device)
    open_it(till)
    session = drawer.sessions.get()
    entry = drawer.entries.get()

    assert str(drawer) == "Bar"
    assert str(session).startswith("Bar ")
    assert str(entry) == "Bar #1 open 100.00"
    assert session.is_open
    assert drawer.open_session() == session
    assert entry.difference is None
