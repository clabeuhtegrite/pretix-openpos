"""
What the event took, as the till shows it at closing time.

The unit is the event, not the day. A till day that started at six in the
morning answered the evening that crosses midnight, and it was still the wrong
unit: the question at closing time is what the evening took, and the evening is
the event — or, in a series, the date the till is selling.

The detail is what makes the figure worth trusting: by payment type, by
category and product, with the deposits apart, by device, and by evening when
the event spans several — and every section adds up to the total.
"""
import zoneinfo
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import ItemCategory

from pretix_openpos.api.evenings import BUSINESS_DAY_STARTS_AT, evening_subevent, start_of_business_day
from pretix_openpos.models import PosSale

from .conftest import Till, sell
from .test_series import a_date, an_item, series_event

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
        positions=kwargs.pop("positions", []),
        idempotency_key=f"entry-{when.isoformat()}-{total}-{payment_type}",
        recorded_at=when,
        **kwargs,
    )


def line(item, count, unit_price, **extra):
    """One journal line, as the checkout writes it."""
    return {
        "item": item.pk,
        "item_name": str(item.name),
        "variation": None,
        "variation_name": None,
        "count": count,
        "unit_price": str(unit_price),
        "line_total": str(Decimal(str(unit_price)) * count),
        **extra,
    }


@pytest.fixture
def sold(event, ticket):
    """
    An order to hang hand-placed journal rows off.

    Built directly rather than sold through the till, so that the only journal
    rows in these tests are the ones a test placed itself, at a moment it chose.
    """
    from pretix.base.models import Order

    return Order.objects.create(
        event=event,
        status=Order.STATUS_PAID,
        datetime=now(),
        expires=now(),
        total=Decimal("10.00"),
        sales_channel=event.organizer.sales_channels.get(identifier="openpos"),
    )


@pytest.fixture
def bar(event, beer):
    category = ItemCategory.objects.create(event=event, name="Bar", position=1)
    beer.category = category
    beer.save()
    return category


@pytest.fixture
def entries(event, ticket):
    category = ItemCategory.objects.create(event=event, name="Entrées", position=0)
    ticket.category = category
    ticket.save()
    return category


def freeze(monkeypatch, when):
    """Pretend the till is asking at this moment."""
    monkeypatch.setattr("pretix_openpos.api.evenings.now", lambda: when)
    monkeypatch.setattr("pretix_openpos.api.views.now", lambda: when)


def adds_up(body):
    """Every section of the report, summed back to the event's total."""
    parts = sum(
        (Decimal(group["total"]) for group in body["categories"]), Decimal("0.00")
    )
    if body["deposits"]:
        parts += Decimal(body["deposits"]["total"])
    if body["unallocated"]:
        parts += Decimal(body["unallocated"])
    return parts == Decimal(body["event"]["total"])


# -- the evening is the event ----------------------------------------------


@pytest.mark.django_db
def test_the_evening_is_still_one_figure_at_half_past_one(
    till, event, device, sold, monkeypatch
):
    entry(event, sold, device, at(15, 23, 30), total="12.00")
    freeze(monkeypatch, at(16, 1, 30))

    assert till.get("summary").json()["event"]["cash"] == "12.00"


@pytest.mark.django_db
def test_the_event_is_not_cut_at_six_in_the_morning(
    till, event, device, sold, monkeypatch
):
    """
    The complaint this answers: a figure that went back to zero when the
    event had not ended, because the clock had passed an hour nobody chose.
    """
    entry(event, sold, device, at(15, 23, 30), total="12.00")
    entry(event, sold, device, at(16, 20), total="8.00")
    freeze(monkeypatch, at(16, 21))

    assert till.get("summary").json()["event"]["total"] == "20.00"


@pytest.mark.django_db
def test_an_event_over_several_evenings_is_split_by_evening(
    till, event, device, sold, monkeypatch
):
    # Friday night, into the small hours, then Saturday.
    entry(event, sold, device, at(14, 22), total="12.00")
    entry(event, sold, device, at(15, 2), total="3.00")
    entry(event, sold, device, at(15, 21), total="8.00")
    freeze(monkeypatch, at(15, 23))

    nights = till.get("summary").json()["nights"]

    assert [(n["date"], n["total"]) for n in nights] == [
        ("2026-08-14", "15.00"),
        ("2026-08-15", "8.00"),
    ]


@pytest.mark.django_db
def test_the_evening_still_starts_at_six_in_the_morning(event, monkeypatch):
    # What the split by evening and the back office's filter still stand on.
    freeze(monkeypatch, at(16, 1, 30))
    assert start_of_business_day(event) == at(15, 6)
    # DST switches happen between two and three in the morning.
    assert BUSINESS_DAY_STARTS_AT.hour == 6


@pytest.mark.django_db
def test_the_answer_names_the_event_it_is_about(till, event, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}])

    body = till.get("summary").json()

    assert body["scope"] == {"event": "Soirée", "series": False, "subevent": None}
    assert body["first"] == body["last"]


# -- figures ---------------------------------------------------------------


@pytest.mark.django_db
def test_cash_and_card_are_reported_apart(till, event, device, sold, monkeypatch):
    entry(event, sold, device, at(15, 21), total="12.00")
    entry(event, sold, device, at(15, 22), total="30.00", payment_type="card")
    freeze(monkeypatch, at(15, 23))

    takings = till.get("summary").json()["event"]

    assert takings["cash"] == "12.00"
    assert takings["card"] == "30.00"
    assert takings["total"] == "42.00"
    assert takings["count"] == 2


@pytest.mark.django_db
def test_a_cancellation_nets_off_but_is_not_counted_as_a_sale(till, event, ticket):
    sale = sell(till, [{"item": ticket.pk, "count": 2}]).json()
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-key-1"})

    takings = till.get("summary").json()["event"]

    # Counting a reversal as a sale would say two customers were served when
    # one was; its money is another matter and nets out on its own.
    assert takings["count"] == 1
    assert takings["cancellations"] == 1
    assert takings["cancelled_total"] == "-20.00"
    assert takings["total"] == "0.00"


@pytest.mark.django_db
def test_a_basket_with_cups_in_it_is_one_cancellation(till, event, beer, deposit):
    """
    Undoing two beers bought with three cups handed back writes two rows, one
    per half. "Two cancellations" for one customer sends somebody looking for
    the second.
    """
    sale = sell(
        till,
        [{"item": beer.pk, "count": 2}, {"item": deposit.pk, "count": 3, "refund": True}],
    ).json()
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-key-1"})

    body = till.get("summary").json()

    assert body["event"]["cancellations"] == 1
    # The customer put three euros on the counter and got three back.
    assert body["event"]["cancelled_total"] == "-3.00"
    assert body["event"]["total"] == "0.00"
    # Nothing left to list: the beers and the cups both went back.
    assert body["categories"] == []
    assert body["deposits"] is None


@pytest.mark.django_db
def test_last_week_s_sale_reversed_tonight_nets_off_the_event(till, event, ticket):
    """
    The case the old day-based figure had to explain in a note of its own: a
    sale rung up on an earlier evening and paid back tonight. Both are the
    event's, so both are in its takings, and nothing is left to explain.
    """
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="hier-0001")
    sale = PosSale.objects.get(event=event, idempotency_key="hier-0001")
    PosSale.objects.filter(pk=sale.pk).update(datetime=now() - timedelta(days=7))
    till.post("cancel", {"seq": sale.seq, "idempotency_key": "annule-0001"})

    takings = till.get("summary").json()["event"]

    assert takings["total"] == "0.00"
    assert "earlier_days" not in takings


@pytest.mark.django_db
def test_test_mode_money_is_kept_out_of_every_figure(
    till, event, device, sold, beer, monkeypatch
):
    entry(event, sold, device, at(15, 21), total="12.00", positions=[line(beer, 4, 3)])
    entry(
        event, sold, device, at(15, 22), total="99.00", testmode=True,
        positions=[line(beer, 33, 3)],
    )
    freeze(monkeypatch, at(15, 23))

    body = till.get("summary").json()

    assert body["event"]["total"] == "12.00"
    # Reported separately rather than silently dropped.
    assert body["testmode"]["total"] == "99.00"
    # And nowhere in the detail either: thirty-three beers nobody drank.
    assert body["categories"][0]["items"][0]["count"] == 4
    assert body["devices"][0]["total"] == "12.00"


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


# -- by category and product -----------------------------------------------


@pytest.mark.django_db
def test_products_are_listed_under_their_category_in_the_shop_s_order(
    till, event, ticket, beer, bar, entries, shirt
):
    tshirt, small, large = shirt
    sell(till, [{"item": beer.pk, "count": 4}], idempotency_key="the-beers-01")
    sell(till, [{"item": ticket.pk, "count": 2}], idempotency_key="the-entry-01")
    sell(
        till,
        [
            {"item": tshirt.pk, "variation": large.pk, "count": 1},
            {"item": tshirt.pk, "variation": small.pk, "count": 2},
        ],
        idempotency_key="the-shirts-1",
    )

    body = till.get("summary").json()

    # Entrées (position 0), Bar (position 1), then what has no category.
    assert [(g["name"], g["count"], g["total"]) for g in body["categories"]] == [
        ("Entrées", 2, "20.00"),
        ("Bar", 4, "12.00"),
        (None, 3, "48.00"),
    ]
    beers = body["categories"][1]["items"]
    assert beers == [
        {"item": beer.pk, "variation": None, "name": "Bière", "variation_name": None,
         "count": 4, "total": "12.00"},
    ]
    # One line per option: a large and a small are not the same thing sold.
    assert [(i["variation_name"], i["count"]) for i in body["categories"][2]["items"]] == [
        ("S", 2), ("L", 1),
    ]
    assert adds_up(body)


@pytest.mark.django_db
def test_a_cancelled_sale_comes_off_its_products(till, event, ticket, beer):
    sell(till, [{"item": beer.pk, "count": 4}], idempotency_key="the-beers-01")
    sale = sell(
        till,
        [{"item": beer.pk, "count": 2}, {"item": ticket.pk, "count": 1}],
        idempotency_key="the-mixed-01",
    ).json()
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "cancel-key-1"})

    items = till.get("summary").json()["categories"][0]["items"]

    # The beers sold before stay; the ones reversed go; and the ticket, sold
    # once and reversed once, is not left behind as a row of zeros.
    assert [(i["name"], i["count"], i["total"]) for i in items] == [("Bière", 4, "12.00")]


@pytest.mark.django_db
def test_a_product_deleted_since_keeps_the_name_it_was_sold_under(
    till, event, device, sold, monkeypatch
):
    ghost = {
        "item": 999999, "item_name": "Cocktail du soir", "variation": None,
        "variation_name": None, "count": 2, "unit_price": "6.00", "line_total": "12.00",
    }
    entry(event, sold, device, at(15, 21), total="12.00", positions=[ghost])
    freeze(monkeypatch, at(15, 23))

    body = till.get("summary").json()

    assert body["categories"] == [
        {"id": None, "name": None, "count": 2, "total": "12.00", "items": [
            {"item": 999999, "variation": None, "name": "Cocktail du soir",
             "variation_name": None, "count": 2, "total": "12.00"},
        ]},
    ]


@pytest.mark.django_db
def test_a_row_with_no_lines_is_said_rather_than_dropped(
    till, event, device, sold, monkeypatch
):
    entry(event, sold, device, at(15, 21), total="12.00")
    freeze(monkeypatch, at(15, 23))

    body = till.get("summary").json()

    assert body["unallocated"] == "12.00"
    assert adds_up(body)


@pytest.mark.django_db
def test_a_journal_the_till_wrote_leaves_nothing_unallocated(till, ticket):
    sell(till, [{"item": ticket.pk, "count": 3}])

    assert till.get("summary").json()["unallocated"] is None


@pytest.mark.django_db
def test_a_line_without_a_total_of_its_own_is_its_price_times_its_count(
    till, event, device, sold, ticket, monkeypatch
):
    # Every line the till writes carries its total; one written by hand may
    # carry only a unit price and a count, and is still worth something.
    bare = line(ticket, 3, "10.00")
    del bare["line_total"]
    entry(event, sold, device, at(15, 21), total="30.00", positions=[bare])
    freeze(monkeypatch, at(15, 23))

    body = till.get("summary").json()

    assert body["categories"][0]["items"][0]["total"] == "30.00"
    assert body["unallocated"] is None


# -- deposits --------------------------------------------------------------


@pytest.mark.django_db
def test_deposits_are_kept_apart_from_what_was_sold(till, event, beer, deposit):
    """
    A cup deposit is money held for somebody until the cup comes back, not
    something the evening sold. So it is out of the products, with what was
    taken and what was handed back side by side.
    """
    sell(
        till,
        [{"item": beer.pk, "count": 4}, {"item": deposit.pk, "count": 4}],
        idempotency_key="the-beers-01",
    )
    sell(till, [{"item": deposit.pk, "count": 3, "refund": True}], idempotency_key="the-cups-001")

    body = till.get("summary").json()

    assert [i["name"] for g in body["categories"] for i in g["items"]] == ["Bière"]
    assert body["deposits"] == {
        "taken": {"count": 4, "total": "4.00"},
        "returned": {"count": 3, "total": "-3.00"},
        "total": "1.00",
    }
    assert body["event"]["total"] == "13.00"
    assert body["event"]["deposit_refunds"] == 1
    assert adds_up(body)


@pytest.mark.django_db
def test_nothing_is_said_about_deposits_on_an_evening_without_any(till, ticket, deposit):
    sell(till, [{"item": ticket.pk, "count": 1}])

    assert till.get("summary").json()["deposits"] is None


# -- by device -------------------------------------------------------------


@pytest.mark.django_db
def test_every_device_has_its_line_and_the_asking_one_is_marked(
    till, another_till, event, ticket, sold, monkeypatch
):
    sell(till, [{"item": ticket.pk, "count": 1}], idempotency_key="mine-one-xx")
    sell(another_till, [{"item": ticket.pk, "count": 2}], idempotency_key="theirs-one")
    # Written with no device at all, the way the back office writes.
    entry(event, sold, None, now(), total="5.00", payment_type="card")

    devices = till.get("summary").json()["devices"]

    assert [(d["name"], d["current"], d["total"]) for d in devices] == [
        ("Caisse entrée", False, "20.00"),
        ("Caisse bar", True, "10.00"),
        # Last whatever it holds: it is not a device anybody holds.
        (None, False, "5.00"),
    ]
    assert devices[0]["serial"] == another_till.device.unique_serial
    assert devices[2]["serial"] is None


@pytest.mark.django_db
def test_a_device_renamed_since_is_listed_under_its_name_now(till, device, ticket):
    sell(till, [{"item": ticket.pk, "count": 1}])
    device.name = "Bar du fond"
    device.save()

    assert till.get("summary").json()["devices"][0]["name"] == "Bar du fond"


# -- series ----------------------------------------------------------------


@pytest.fixture
def season(organizer, channel, device):
    """A series with a date on tonight and one a week ago, and a till on it."""
    event = series_event(organizer)
    last_week = a_date(event, "Samedi dernier", now() - timedelta(days=7, hours=1))
    tonight = a_date(event, "Ce soir", now() - timedelta(hours=1))
    item = an_item(event, channel, tonight)
    quota = item.quotas.create(event=event, name="Entrées", size=100, subevent=last_week)
    quota.items.add(item)
    return event, last_week, tonight, item, Till(device, event)


@pytest.mark.django_db
def test_a_series_reports_the_date_the_till_is_selling(season, monkeypatch):
    event, last_week, tonight, item, till = season
    # Last week's evening, rung up last week.
    monkeypatch.setattr(
        "pretix_openpos.api.evenings.now", lambda: now() - timedelta(days=7)
    )
    monkeypatch.setattr(
        "pretix_openpos.api.sales.now", lambda: now() - timedelta(days=7)
    )
    sell(till, [{"item": item.pk, "count": 3}], idempotency_key="last-week-1")
    monkeypatch.undo()
    sell(till, [{"item": item.pk, "count": 1}], idempotency_key="tonight-001")

    body = till.get("summary").json()

    assert body["scope"]["subevent"]["id"] == tonight.pk
    assert body["scope"]["subevent"]["name"] == "Ce soir"
    assert body["event"]["total"] == "10.00"
    assert evening_subevent(event) == tonight


@pytest.mark.django_db
def test_last_week_s_sale_reversed_tonight_corrects_last_week(season, monkeypatch):
    event, last_week, tonight, item, till = season
    monkeypatch.setattr(
        "pretix_openpos.api.evenings.now", lambda: now() - timedelta(days=7)
    )
    monkeypatch.setattr(
        "pretix_openpos.api.sales.now", lambda: now() - timedelta(days=7)
    )
    sale = sell(till, [{"item": item.pk, "count": 3}], idempotency_key="last-week-1").json()
    monkeypatch.undo()
    sell(till, [{"item": item.pk, "count": 1}], idempotency_key="tonight-001")
    till.post("cancel", {"seq": sale["journal_seq"], "idempotency_key": "annule-0001"})

    # Tonight's figure is tonight's sales. The reversal copies the lines it
    # reverses, date included, so it lands on the evening it corrects.
    assert till.get("summary").json()["event"]["total"] == "10.00"


@pytest.mark.django_db
def test_a_plain_event_has_no_date_to_pick(event):
    assert evening_subevent(event) is None


@pytest.mark.django_db
def test_a_series_with_nothing_switched_on_reports_the_whole_series(organizer):
    event = series_event(organizer)
    a_date(event, "Éteinte", now(), active=False)

    assert evening_subevent(event) is None
