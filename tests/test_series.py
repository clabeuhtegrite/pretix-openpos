"""
An event series at a door.

A series keeps a separate quota, and possibly a separate price, per date, and
pretix refuses an order position that does not name one. The till never sent
one, so the catalogue loaded cleanly — showing a hundred places left — and the
first sale came back "The product “Entrée” is not assigned to a quota", at the
payment, in front of a customer. The message names the wrong cause: the product
is assigned to a quota, just not to a date.

The till still sends no date. It never sends a price either, and for the same
reason: whoever is standing at it has one queue in front of them and no
business picking either off a list. The server decides, from the clock.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import Event, Item, Order, Quota, SubEvent

from .conftest import Till, sell


def series_event(organizer):
    event = Event.objects.create(
        organizer=organizer,
        name="Soirées",
        slug="soirees",
        date_from=now() + timedelta(days=1),
        plugins="pretix_openpos",
        live=True,
        currency="EUR",
        has_subevents=True,
    )
    event.settings.set("timezone", "Europe/Paris")
    return event


def a_date(event, name, starts, ends=None, active=True):
    return SubEvent.objects.create(
        event=event, name=name, date_from=starts, date_to=ends, active=active,
    )


def an_item(event, channel, subevent, *, price=10, size=100):
    item = Item.objects.create(
        event=event, name="Entrée", default_price=price, admission=True,
        all_sales_channels=False,
    )
    item.limit_sales_channels.add(channel)
    quota = Quota.objects.create(
        event=event, name="Entrées", size=size, subevent=subevent
    )
    quota.items.add(item)
    return item


@pytest.fixture
def tonight(organizer, channel, device):
    """A series with one date on right now, and a till paired to it."""
    event = series_event(organizer)
    date = a_date(event, "Ce soir", now() - timedelta(hours=1))
    item = an_item(event, channel, date)
    return event, date, item, Till(device, event)


@pytest.mark.django_db
def test_a_sale_on_a_series_goes_through(tonight):
    event, date, item, till = tonight

    body = sell(till, [{"item": item.pk, "count": 2}]).json()

    order = Order.objects.get(code=body["order"]["code"])
    # The thing that used to fail, and the thing that made it fail.
    assert order.total == Decimal("20.00")
    assert {p.subevent_id for p in order.positions.all()} == {date.pk}


@pytest.mark.django_db
def test_the_catalogue_counts_only_the_date_being_sold(organizer, channel, device):
    event = series_event(organizer)
    tonight = a_date(event, "Ce soir", now() - timedelta(hours=1))
    item = an_item(event, channel, tonight, size=40)
    # Another evening, with its own quota. Counting both would tell the door
    # it has a hundred and forty places when it has forty.
    another = a_date(event, "Samedi prochain", now() + timedelta(days=7))
    quota = Quota.objects.create(event=event, name="Entrées", size=100, subevent=another)
    quota.items.add(item)

    body = Till(device, event).get("catalog").json()

    assert body["categories"][0]["items"][0]["available"] == 40


@pytest.mark.django_db
def test_a_price_set_for_one_date_is_the_one_charged(organizer, channel, device):
    from pretix.base.models.items import SubEventItem

    event = series_event(organizer)
    tonight = a_date(event, "Ce soir", now() - timedelta(hours=1))
    item = an_item(event, channel, tonight, price=10)
    SubEventItem.objects.create(subevent=tonight, item=item, price=Decimal("14.00"))
    till = Till(device, event)

    assert till.get("catalog").json()["categories"][0]["items"][0]["price"] == "14.00"

    body = sell(till, [{"item": item.pk, "count": 1}]).json()
    assert body["order"]["total"] == "14.00"


@pytest.mark.django_db
def test_a_door_sells_before_it_opens(organizer, channel, device):
    event = series_event(organizer)
    # Doors in two hours, and the till is already ringing up a pre-sale.
    tonight = a_date(event, "Ce soir", now() + timedelta(hours=2))
    item = an_item(event, channel, tonight)

    body = sell(Till(device, event), [{"item": item.pk, "count": 1}]).json()

    order = Order.objects.get(code=body["order"]["code"])
    assert order.positions.first().subevent_id == tonight.pk


@pytest.mark.django_db
def test_at_one_in_the_morning_the_till_is_still_on_tonight(organizer, channel, device):
    """
    A business day runs six to six. A door still selling in the small hours is
    selling for the evening that is still going on, not for the next one.
    """
    event = series_event(organizer)
    started = now() - timedelta(hours=7)
    tonight = a_date(event, "Hier soir", started, ends=now() + timedelta(hours=2))
    item = an_item(event, channel, tonight)

    body = sell(Till(device, event), [{"item": item.pk, "count": 1}]).json()

    assert Order.objects.get(
        code=body["order"]["code"]
    ).positions.first().subevent_id == tonight.pk


@pytest.mark.django_db
def test_a_series_with_nothing_on_says_so_at_the_catalogue(organizer, channel, device):
    event = series_event(organizer)
    # Next month, and nothing tonight.
    later = a_date(event, "Le mois prochain", now() + timedelta(days=30))
    an_item(event, channel, later)

    response = Till(device, event).get("catalog")

    # At the catalogue, where a volunteer meets it while setting up — not at
    # the payment, and not as "the product is not assigned to a quota".
    assert response.status_code == 400
    assert response.json()["code"] == "series_closed"
    assert "Nothing is on tonight" in str(response.content)


@pytest.mark.django_db
def test_a_date_switched_off_does_not_count_as_on(organizer, channel, device):
    event = series_event(organizer)
    off = a_date(event, "Annulée", now() - timedelta(hours=1), active=False)
    an_item(event, channel, off)

    assert Till(device, event).get("catalog").status_code == 400


@pytest.mark.django_db
def test_a_replay_is_booked_against_the_night_it_was_rung_up_in(
    organizer, channel, device
):
    """
    The one case where "tonight" is not now. A till cut off at the door hands
    its sales over when it finds the network again, which can be the next
    morning — by which time tonight's date is yesterday's.
    """
    event = series_event(organizer)
    last_night = a_date(
        event, "Hier", now() - timedelta(hours=14), ends=now() - timedelta(hours=9)
    )
    an_item(event, channel, last_night)
    # And another evening on tonight, which is the one it would have been
    # booked against had the clock alone decided.
    tonight = a_date(event, "Ce soir", now() + timedelta(hours=3))
    item = an_item(event, channel, tonight)
    till = Till(device, event)

    rung_up = now() - timedelta(hours=12)
    body = sell(
        till,
        [{"item": item.pk, "count": 1, "price": "10.00"}],
        offline={"recorded_at": rung_up.isoformat(), "charged_total": "10.00"},
    ).json()

    order = Order.objects.get(code=body["order"]["code"])
    assert order.positions.first().subevent_id == last_night.pk


@pytest.mark.django_db
def test_a_paid_sale_is_never_refused_for_having_no_date(organizer, channel, device):
    """
    The money is already out of the customer's hands. Refusing does not give it
    back; it strands the sale outside pretix, where nothing can find it. The
    nearest date is a guess, and a guess somebody can move is better than a
    sale nobody can.
    """
    event = series_event(organizer)
    later = a_date(event, "Le mois prochain", now() + timedelta(days=30))
    item = an_item(event, channel, later)

    rung_up = now() - timedelta(hours=3)
    response = sell(
        Till(device, event),
        [{"item": item.pk, "count": 1, "price": "10.00"}],
        offline={"recorded_at": rung_up.isoformat(), "charged_total": "10.00"},
    )

    assert response.status_code == 201
    order = Order.objects.get(code=response.json()["order"]["code"])
    assert order.positions.first().subevent_id == later.pk


@pytest.mark.django_db
def test_the_journal_says_which_date_was_sold(tonight):
    from pretix_openpos.models import PosSale

    event, date, item, till = tonight

    body = sell(till, [{"item": item.pk, "count": 1}]).json()

    line = PosSale.objects.get(seq=body["journal_seq"]).positions[0]
    # The journal outlives the order and the date alike, so the name is copied
    # in rather than looked up later.
    assert line["subevent"] == date.pk
    assert line["subevent_name"] == "Ce soir"


@pytest.mark.django_db
def test_a_plain_event_carries_no_date_anywhere(till, ticket, event):
    from pretix_openpos.models import PosSale

    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    assert "subevent" not in PosSale.objects.get(seq=body["journal_seq"]).positions[0]
    assert Order.objects.get(code=body["order"]["code"]).positions.first().subevent_id is None
