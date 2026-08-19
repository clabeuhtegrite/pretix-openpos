"""
The takings a volunteer reconciles the drawer against.

Two things make this less obvious than summing a column: a till serves an
evening and an evening crosses midnight, and test-mode money never existed.
"""
import zoneinfo
from datetime import datetime
from decimal import Decimal

import pytest

from pretix_openpos.api.views import BUSINESS_DAY_STARTS_AT, start_of_business_day
from pretix_openpos.models import PosSale

from .conftest import sell

PARIS = zoneinfo.ZoneInfo("Europe/Paris")


def at(day, hour, minute=0):
    return datetime(2026, 8, day, hour, minute, tzinfo=PARIS)


def entry(event, order, device, when, total="10.00", payment_type="cash", **kwargs):
    """A journal row at a chosen moment, written the way a replay writes one."""
    return PosSale.record(
        event=event,
        order=order,
        device=device,
        cashier=kwargs.pop("cashier", ""),
        payment_type=payment_type,
        total=Decimal(total),
        positions=[],
        idempotency_key=f"entry-{when.isoformat()}-{total}-{payment_type}",
        recorded_at=when,
        **kwargs,
    )


@pytest.fixture
def sold(event, ticket):
    """
    An order to hang hand-placed journal rows off.

    Built directly rather than sold through the till, so that the only journal
    rows in these tests are the ones a test placed itself, at a moment it chose.
    """
    from django.utils.timezone import now
    from pretix.base.models import Order

    return Order.objects.create(
        event=event,
        status=Order.STATUS_PAID,
        datetime=now(),
        expires=now(),
        total=Decimal("10.00"),
        sales_channel=event.organizer.sales_channels.get(identifier="openpos"),
    )


def freeze(monkeypatch, when):
    """Pretend the till is asking at this moment."""
    monkeypatch.setattr("pretix_openpos.api.views.now", lambda: when)


@pytest.mark.django_db
def test_the_day_starts_at_six_in_the_morning(event, monkeypatch):
    freeze(monkeypatch, at(15, 22, 30))
    assert start_of_business_day(event) == at(15, 6)

    # Half past one in the morning still belongs to the night that began
    # yesterday evening: the drawer holds everything taken since the doors
    # opened, so the figure it reconciles against must not have reset at 00:00.
    freeze(monkeypatch, at(16, 1, 30))
    assert start_of_business_day(event) == at(15, 6)

    freeze(monkeypatch, at(16, 7))
    assert start_of_business_day(event) == at(16, 6)


@pytest.mark.django_db
def test_the_boundary_is_clear_of_the_hours_daylight_saving_moves(event):
    # DST switches happen between two and three in the morning.
    assert BUSINESS_DAY_STARTS_AT.hour == 6


@pytest.mark.django_db
def test_a_sale_made_before_midnight_still_counts_at_half_past_one(
    till, event, device, sold, monkeypatch
):
    entry(event, sold, device, at(15, 23, 30), total="12.00")
    freeze(monkeypatch, at(16, 1, 30))

    body = till.get("summary").json()

    assert body["event"]["cash"] == "12.00"
    assert body["since"].startswith("2026-08-15T06:00")


@pytest.mark.django_db
def test_last_night_is_gone_by_the_next_evening(till, event, device, sold, monkeypatch):
    entry(event, sold, device, at(15, 23, 30), total="12.00")
    freeze(monkeypatch, at(16, 20))

    assert till.get("summary").json()["event"]["cash"] == "0.00"


@pytest.mark.django_db
def test_cash_and_card_are_reported_apart(till, event, device, sold, monkeypatch):
    entry(event, sold, device, at(15, 21), total="12.00")
    entry(event, sold, device, at(15, 22), total="30.00", payment_type="card")
    freeze(monkeypatch, at(15, 23))

    takings = till.get("summary").json()["event"]

    assert takings["cash"] == "12.00"
    assert takings["card"] == "30.00"
    assert takings["total"] == "42.00"


@pytest.mark.django_db
def test_a_cancellation_nets_off_but_is_not_counted_as_a_sale(
    till, event, ticket, monkeypatch
):
    sale = sell(till, [{"item": ticket.pk, "count": 2}]).json()
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-key-1"})

    takings = till.get("summary").json()["event"]

    # Counting a reversal as a sale would say two customers were served when
    # one was; its money is another matter and nets out on its own.
    assert takings["count"] == 1
    assert takings["cancellations"] == 1
    assert takings["total"] == "0.00"


@pytest.mark.django_db
def test_test_mode_money_is_kept_out_of_the_drawer_figure(
    till, event, device, sold, monkeypatch
):
    entry(event, sold, device, at(15, 21), total="12.00")
    entry(event, sold, device, at(15, 22), total="99.00", testmode=True)
    freeze(monkeypatch, at(15, 23))

    body = till.get("summary").json()

    assert body["event"]["total"] == "12.00"
    # Reported separately rather than silently dropped.
    assert body["testmode"]["total"] == "99.00"


@pytest.mark.django_db
def test_nothing_is_said_about_test_mode_when_there_was_none(till, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}])

    assert till.get("summary").json()["testmode"] is None


@pytest.mark.django_db
def test_a_till_sees_its_own_takings_next_to_everyone_s(
    till, another_till, event, ticket
):
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="mine-one-xx")
    sell(another_till, [{"item": ticket.pk, "count": 2}], idempotency_key="theirs-one")

    body = till.get("summary").json()

    assert body["device"]["total"] == "10.00"
    assert body["event"]["total"] == "30.00"


@pytest.mark.django_db
def test_the_amounts_keep_their_trailing_zeros(till, ticket):
    # SQLite hands Sum() back with the trailing zeros gone — "50" where
    # PostgreSQL says "50.00" — and this string is API surface.
    sell(till, [{"item": ticket.pk, "count": 5}])

    assert till.get("summary").json()["event"]["cash"] == "50.00"
