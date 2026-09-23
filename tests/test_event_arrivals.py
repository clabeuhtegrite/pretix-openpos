"""
One event's arrivals, as the back office reads them after the evening.

The page is only worth anything if it tells the same story as the door: the
arrivals it charts must add up to the "admitted" figure the phones show, and
its refusals to their "refused" column. Most tests here are that sum, from a
different side.
"""
import zoneinfo
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from django.utils import translation
from django.utils.timezone import now
from pretix.base.models import Checkin, Event, Order, OrderPosition, Team

from pretix_openpos.arrivals import by_half_hour, span_label, timeline_geometry
from pretix_openpos.attendance import arrivals, attendance, is_over

from .test_series import a_date, an_item, series_event

PARIS = zoneinfo.ZoneInfo("Europe/Paris")


def at(day, hour, minute=0):
    """A moment of July 2026, on the clock at the door."""
    return datetime(2026, 7, day, hour, minute, tzinfo=PARIS)


@pytest.fixture
def evening(organizer, channel, backoffice):
    """
    Last summer's concert, with its door list and an admission ticket on sale
    both online and at the till, readable by the back office.
    """
    event = Event.objects.create(
        organizer=organizer,
        name="Concert d'été",
        slug="concert",
        date_from=at(4, 20),
        date_to=at(5, 2),
        plugins="pretix_openpos",
        live=True,
        currency="EUR",
    )
    event.settings.set("timezone", "Europe/Paris")
    Team.objects.get(organizer=organizer).limit_events.add(event)
    item = event.items.create(name="Entrée", default_price=10, admission=True)
    clist = event.checkin_lists.create(name="Porte", all_products=True)
    return event, item, clist


def sold(event, item, channel="web", subevent=None):
    """One ticket, bought online unless said otherwise."""
    order = Order.objects.create(
        event=event,
        status=Order.STATUS_PAID,
        datetime=now(),
        expires=now(),
        total=Decimal("10.00"),
        sales_channel=event.organizer.sales_channels.get(identifier=channel),
    )
    return OrderPosition.objects.create(
        order=order, item=item, positionid=1, price=Decimal("10.00"), subevent=subevent
    )


def let_in(position, clist, when, kind=Checkin.TYPE_ENTRY, scanned=True, device=None):
    """
    A check-in at ``when``: scanned at a door, or — ``scanned=False`` — written
    by a till with the sale, which carries no code.
    """
    return Checkin.objects.create(
        position=position,
        list=clist,
        type=kind,
        datetime=when,
        raw_source_type="barcode" if scanned else None,
        device=device,
    )


def turned_away(event, clist, when, reason, position=None, device=None):
    return Checkin.all.create(
        position=position,
        list=clist,
        type=Checkin.TYPE_ENTRY,
        datetime=when,
        successful=False,
        error_reason=reason,
        raw_barcode="ABCDEF",
        raw_source_type="barcode",
        device=device,
    )


def page(client, event, **params):
    url = f"/control/event/{event.organizer.slug}/{event.slug}/openpos/arrivals/"
    if params:
        url += "?" + "&".join(f"{key}={value}" for key, value in params.items())
    return client.get(url)


@pytest.mark.django_db
def test_the_arrivals_add_up_to_the_admitted_figure_of_the_door(evening, backoffice, device):
    event, item, clist = evening
    for minute in (2, 7, 20):
        let_in(sold(event, item), clist, at(4, 21, minute), device=device)
    # Sold at the till and let in with the sale: an arrival like any other,
    # at the moment it was sold.
    let_in(sold(event, item, "openpos"), clist, at(4, 21, 10), scanned=False, device=device)
    # Bought, never came.
    sold(event, item)

    context = page(backoffice, event).context

    assert context["figures"]["entered"] == 4
    assert context["figures"]["expected"] == 5
    assert sum(row["total"] for night in context["nights"] for row in night["rows"]) == 4
    assert context["entered_percent"] == 80
    assert context["figures"]["not_arrived"] == 1
    # The till sale is told apart from the tickets bought ahead.
    assert (context["ahead"], context["till"]) == (3, 1)
    assert context["split"] is True
    first = context["nights"][0]["rows"][0]
    assert (first["label"], first["ahead"], first["till"]) == ("21:00–21:15", 2, 1)


@pytest.mark.django_db
def test_somebody_scanned_out_and_back_in_arrives_once(evening, backoffice):
    event, item, clist = evening
    regular = sold(event, item)
    let_in(regular, clist, at(4, 21))
    let_in(regular, clist, at(4, 22), kind=Checkin.TYPE_EXIT)
    let_in(regular, clist, at(4, 22, 30))
    let_in(sold(event, item), clist, at(4, 22, 40))

    context = page(backoffice, event).context

    assert sum(row["total"] for row in context["nights"][0]["rows"]) == 2
    assert context["figures"]["entered"] == 2
    # Somebody went out, so the room is worth showing: both are back in, and
    # the fullest it got was the two of them.
    assert context["figures"]["inside"] == 2
    assert context["room"] == {"count": 2, "at": "22:40"}


@pytest.mark.django_db
def test_without_an_exit_the_room_is_not_shown_twice(evening, backoffice):
    event, item, clist = evening
    let_in(sold(event, item), clist, at(4, 21))

    context = page(backoffice, event).context

    # Nobody was scanned out: "on site" would only repeat "admitted".
    assert "room" not in context


@pytest.mark.django_db
def test_the_rush_is_the_busiest_quarter_and_the_first_of_equals(evening, backoffice):
    event, item, clist = evening
    for when in (at(4, 21, 1), at(4, 21, 14), at(4, 22, 16), at(4, 22, 29), at(4, 23, 50)):
        let_in(sold(event, item), clist, when)

    context = page(backoffice, event).context

    assert context["rush"] == {"label": "21:00–21:15", "count": 2, "date": None}


@pytest.mark.django_db
def test_an_evening_that_crosses_midnight_is_one_night(evening, backoffice):
    event, item, clist = evening
    let_in(sold(event, item), clist, at(4, 23, 50))
    let_in(sold(event, item), clist, at(5, 0, 20))

    nights = page(backoffice, event).context["nights"]

    assert len(nights) == 1
    assert str(nights[0]["date"]) == "2026-07-04"
    # Every quarter from the first arrival to the last, the empty one included.
    assert [row["label"] for row in nights[0]["rows"]] == [
        "23:45–00:00", "00:00–00:15", "00:15–00:30",
    ]
    assert [row["cumulative"] for row in nights[0]["rows"]] == [1, 1, 2]


@pytest.mark.django_db
def test_two_nights_of_one_event_are_charted_apart(evening, backoffice):
    event, item, clist = evening
    let_in(sold(event, item), clist, at(4, 21))
    let_in(sold(event, item), clist, at(5, 21, 30))
    let_in(sold(event, item), clist, at(5, 21, 35))

    context = page(backoffice, event).context

    assert [night["total"] for night in context["nights"]] == [1, 2]
    # The rush of a two-night event says which night it was.
    assert context["rush"]["count"] == 2
    assert str(context["rush"]["date"]) == "2026-07-05"


@pytest.mark.django_db
def test_a_very_long_night_is_charted_by_the_half_hour(evening, backoffice):
    event, item, clist = evening
    # The afternoon's test scan, and the last latecomer: fifteen hours apart.
    let_in(sold(event, item), clist, at(4, 9, 5))
    let_in(sold(event, item), clist, at(5, 0, 50))

    night = page(backoffice, event).context["nights"][0]

    assert night["minutes"] == 30
    assert night["rows"][0]["label"] == "09:00–09:30"
    assert night["rows"][-1]["label"] == "00:30–01:00"
    assert len(night["chart"]["bars"]) == 32


@pytest.mark.django_db
def test_refusals_add_up_to_the_refused_scans_of_the_doors(evening, backoffice, device):
    event, item, clist = evening
    used = sold(event, item)
    let_in(used, clist, at(4, 21), device=device)
    turned_away(event, clist, at(4, 21, 5), "already_redeemed", used, device)
    turned_away(event, clist, at(4, 21, 6), "already_redeemed", used, device)
    turned_away(event, clist, at(4, 21, 7), "invalid", device=device)

    context = page(backoffice, event).context

    assert [(row["reason"], row["count"]) for row in context["reasons"]] == [
        ("already_redeemed", 2), ("invalid", 1),
    ]
    assert context["refused"] == 3 == sum(row["count"] for row in context["reasons"])
    # pretix's own words for them, which is what its check-in history says.
    assert str(context["reasons"][0]["label"]) == "Ticket already used"
    assert context["scans"]["devices"][0]["id"] == device.pk
    body = page(backoffice, event).content.decode()
    assert "status=already_redeemed" in body
    assert f"device={device.pk}" in body


@pytest.mark.django_db
def test_a_refusal_pretix_did_not_name_still_counts(evening, backoffice):
    event, item, clist = evening
    turned_away(event, clist, at(4, 21), None)

    reasons = page(backoffice, event).context["reasons"]

    assert [(row["reason"], row["count"]) for row in reasons] == [("", 1)]
    assert str(reasons[0]["label"]) == "Other reason"


@pytest.mark.django_db
def test_a_ticket_sold_at_the_till_is_an_arrival_but_not_a_scan(evening, backoffice, device):
    event, item, clist = evening
    let_in(sold(event, item, "openpos"), clist, at(4, 21), scanned=False, device=device)

    context = page(backoffice, event).context

    assert context["figures"]["entered"] == 1
    assert context["scans"]["event"]["admitted"] == 0
    # Nothing to tell apart: one colour, no legend.
    assert context["split"] is False
    assert [piece["kind"] for piece in context["nights"][0]["chart"]["bars"][0]["pieces"]] == ["all"]


@pytest.mark.django_db
def test_an_event_nobody_has_come_to_yet_charts_nothing(evening, backoffice):
    event, item, _clist = evening
    sold(event, item)

    context = page(backoffice, event).context

    assert context["nights"] == []
    assert "rush" not in context
    assert context["figures"]["not_arrived"] == 1


@pytest.mark.django_db
def test_an_event_with_no_check_in_list_says_so(evening, backoffice):
    event, _item, clist = evening
    clist.delete()

    response = page(backoffice, event)

    assert response.status_code == 200
    assert response.context["clist"] is None
    assert "no check-in list" in response.content.decode()


@pytest.mark.django_db
def test_the_door_the_till_checks_into_is_the_one_counted(evening, backoffice):
    event, item, door = evening
    cloakroom = event.checkin_lists.create(name="A vestiaire", all_products=True)
    event.settings.set("openpos_checkin_list", str(door.pk))
    let_in(sold(event, item), door, at(4, 21))

    context = page(backoffice, event).context

    # Not the first list by name: the one the door screen counts on.
    assert context["clist"] == door
    assert context["figures"]["entered"] == 1
    # Another list can be asked for, and a list of another event cannot.
    assert page(backoffice, event, list=cloakroom.pk).context["clist"] == cloakroom
    assert page(backoffice, event, list=999999).context["clist"] == door


@pytest.mark.django_db
def test_one_date_of_a_series_is_counted_alone(organizer, channel, backoffice, device):
    event = series_event(organizer)
    Team.objects.get(organizer=organizer).limit_events.add(event)
    tonight = a_date(event, "Ce soir", now() - timedelta(hours=1))
    last_week = a_date(event, "La semaine dernière", now() - timedelta(days=7))
    item = an_item(event, channel, tonight)
    every_date = event.checkin_lists.create(name="Porte", all_products=True)
    let_in(sold(event, item, subevent=last_week), every_date, now() - timedelta(days=7))
    sold(event, item, subevent=last_week)
    sold(event, item, subevent=tonight)

    this_week = page(backoffice, event).context
    before = page(backoffice, event, subevent=last_week.pk).context

    # Tonight by default, as the door counts it.
    assert this_week["subevent"] == tonight
    assert (this_week["figures"]["entered"], this_week["figures"]["expected"]) == (0, 1)
    assert (before["figures"]["entered"], before["figures"]["expected"]) == (1, 2)


@pytest.mark.django_db
def test_the_door_screen_counts_tonight_on_a_list_for_every_date(organizer, channel, device):
    """
    The door counted a whole season's tickets as "expected" when its list was
    kept for every date: three thousand people expected, on a Tuesday.
    """
    from .conftest import Till

    event = series_event(organizer)
    tonight = a_date(event, "Ce soir", now() - timedelta(hours=1))
    last_week = a_date(event, "La semaine dernière", now() - timedelta(days=7))
    item = an_item(event, channel, tonight)
    door = event.checkin_lists.create(name="Porte", all_products=True)
    let_in(sold(event, item, subevent=last_week), door, now() - timedelta(days=7))
    sold(event, item, subevent=tonight)

    body = Till(device, event).get("attendance", list=door.pk).json()

    assert (body["expected"], body["entered"], body["not_arrived"]) == (1, 0, 1)


@pytest.mark.django_db
def test_the_page_is_for_whoever_may_read_orders(evening, reader, outsider, organizer):
    event, _item, _clist = evening
    for email in ("benevole@example.org", "personne@example.org"):
        Team.objects.get(members__email=email).limit_events.add(event)

    assert page(reader, event).status_code == 200
    assert page(outsider, event).status_code in (403, 404)


@pytest.mark.django_db
def test_the_event_menu_leads_to_it(evening, backoffice):
    event, _item, _clist = evening

    body = backoffice.get(
        f"/control/event/{event.organizer.slug}/{event.slug}/openpos/sales/"
    ).content.decode()

    assert f"/control/event/{event.organizer.slug}/{event.slug}/openpos/arrivals/" in body


@pytest.mark.django_db
def test_the_evening_is_over_once_it_has_ended(organizer):
    event = Event.objects.create(
        organizer=organizer, name="Ce soir", slug="ce-soir",
        date_from=now() - timedelta(hours=2), plugins="pretix_openpos", currency="EUR",
    )
    event.settings.set("timezone", "Europe/Paris")
    assert not is_over(event)

    event.date_to = now() - timedelta(minutes=1)
    assert is_over(event)

    # With no end, the night it began in closes at six the next morning.
    event.date_to = None
    event.date_from = now() - timedelta(days=2)
    assert is_over(event)


@pytest.mark.django_db
def test_the_page_reads_in_french(evening, backoffice, device):
    from pretix.base.models import User

    User.objects.filter(email="boss@example.org").update(locale="fr")
    event, item, clist = evening
    regular = sold(event, item)
    let_in(regular, clist, at(4, 21), device=device)
    let_in(regular, clist, at(4, 22), kind=Checkin.TYPE_EXIT, device=device)
    let_in(sold(event, item, "openpos"), clist, at(4, 21, 20), scanned=False, device=device)
    sold(event, item)
    turned_away(event, clist, at(4, 21, 30), "already_redeemed", regular, device)

    body = page(backoffice, event).content.decode()

    for french in (
        "Arrivées", "Entrés", "Pas venus", "Plus forte affluence", "Refusés",
        "Sur place", "Prévente", "Vendus sur place", "Arrivées par quart d’heure",
        "Scans de l’événement, par appareil", "Hors ligne", "Refus par motif",
        "Motif", "billets attendus", "Billet déjà utilisé", "Mis à jour à",
        "Afficher sous forme de tableau", "Cumul",
    ):
        assert french in body, french
    # The night by its day, in pretix's own words for it — which capitalise.
    assert "samedi 4 juillet" in body.lower()
    for english in ("Admitted", "No-shows", "Bought ahead", "Refusals by reason"):
        assert english not in body, english


def test_a_stacked_bar_is_its_two_sales_apart_with_a_gap_between():
    start = datetime(2026, 7, 4, 21, 0)
    bars = [
        {"start": start, "ahead": 30, "till": 10, "total": 40},
        {"start": start + timedelta(minutes=15), "ahead": 1, "till": 0, "total": 1},
    ]

    # In English whatever the page rendered before this left active.
    with translation.override("en"):
        geometry = timeline_geometry(bars, 15, split=True, rush=start)

    first, second = geometry["bars"]
    assert [piece["kind"] for piece in first["pieces"]] == ["ahead", "till"]
    # Only the top of a stack is rounded: the join between two sales is flat.
    assert "Q" not in first["pieces"][0]["d"]
    assert "Q" in first["pieces"][1]["d"]
    assert first["is_rush"] and not second["is_rush"]
    # One arrival against a peak of forty is still a visible bar.
    assert [piece["kind"] for piece in second["pieces"]] == ["ahead"]
    assert first["title"].startswith("21:00–21:15 · 40 arrivals")


def test_hours_are_marked_every_hour_then_every_other_one():
    start = datetime(2026, 7, 4, 20, 0)
    evening = [
        {"start": start + timedelta(minutes=15 * i), "ahead": 1, "till": 0, "total": 1}
        for i in range(24)
    ]
    geometry = timeline_geometry(evening, 15, split=False, rush=start)
    assert [tick["label"] for tick in geometry["xticks"]] == [
        "20:00", "21:00", "22:00", "23:00", "00:00", "01:00",
    ]

    day = by_half_hour([
        {"start": start + timedelta(minutes=15 * i), "ahead": 1, "till": 0, "total": 1}
        for i in range(60)
    ])
    geometry = timeline_geometry(day, 30, split=False, rush=start)
    assert [tick["label"] for tick in geometry["xticks"]] == [
        "20:00", "22:00", "00:00", "02:00", "04:00", "06:00", "08:00", "10:00",
    ]


def test_a_quarter_is_named_by_its_two_ends():
    assert span_label(datetime(2026, 7, 4, 23, 45)) == "23:45–00:00"
    assert span_label(datetime(2026, 7, 4, 23, 30), 30) == "23:30–00:00"


@pytest.mark.django_db
def test_the_arrivals_and_the_door_count_the_same_tickets(evening, beer_for):
    """The calculation itself, without a page around it."""
    event, item, clist = evening
    t_shirt = beer_for(event)
    let_in(sold(event, item), clist, at(4, 21))
    # A T-shirt scanned at a list that takes everything is nobody arriving.
    let_in(sold(event, t_shirt), clist, at(4, 21))

    counted = attendance(clist)
    timeline = arrivals(clist)

    assert counted["entered"] == timeline["total"] == 1
    assert counted["non_admission_entered"] == 1


@pytest.fixture
def beer_for():
    def make(event):
        return event.items.create(name="T-shirt", default_price=15, admission=False)
    return make
