"""
The organizer-level page that answers "when do people actually show up?".

Read-only, and the totals are the whole point: every scan it must ignore —
an automatic check-in, a test order, an exit, an event that has not happened —
would put arrivals at hours nobody arrived, and a staffing decision would be
taken on it.
"""
import zoneinfo
from datetime import datetime, timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import Checkin, Event, Order, OrderPosition, Team

from pretix_openpos.arrivals import chart_geometry, hour_label, px


def past_event(organizer, slug="hier", timezone="Europe/Paris"):
    event = Event.objects.create(
        organizer=organizer,
        name="Soirée passée",
        slug=slug,
        date_from=now() - timedelta(days=30),
        date_to=now() - timedelta(days=30) + timedelta(hours=6),
        plugins="pretix_openpos",
        live=True,
        currency="EUR",
    )
    event.settings.set("timezone", timezone)
    return event


def arrival(event, item, when, kind=Checkin.TYPE_ENTRY, auto=False, testmode=False):
    order = Order.objects.create(
        event=event,
        status=Order.STATUS_PAID,
        datetime=when,
        expires=when,
        total=Decimal("10.00"),
        testmode=testmode,
        sales_channel=event.organizer.sales_channels.get(identifier="web"),
    )
    position = OrderPosition.objects.create(
        order=order, item=item, positionid=1, price=Decimal("10.00")
    )
    clist = event.checkin_lists.first() or event.checkin_lists.create(
        name="Porte", all_products=True
    )
    return Checkin.objects.create(
        position=position, list=clist, type=kind, datetime=when, auto_checked_in=auto
    )


@pytest.fixture
def readable(backoffice, organizer, event):
    """The back-office session, with a finished event it may read."""
    from pretix.base.models import Team

    past = past_event(organizer)
    Team.objects.get(organizer=organizer).limit_events.add(past)
    return backoffice, past


def load(client, organizer):
    return client.get(f"/control/organizer/{organizer.slug}/openpos/arrivals/")


@pytest.mark.django_db
def test_scans_are_bucketed_by_the_hour_on_the_clock_at_that_door(
    readable, organizer, ticket
):
    client, past = readable
    paris = zoneinfo.ZoneInfo("Europe/Paris")
    item = past.items.create(name="Entrée", default_price=10, admission=True)
    for minute in (0, 20, 40):
        arrival(past, item, datetime(2026, 7, 4, 21, minute, tzinfo=paris))
    arrival(past, item, datetime(2026, 7, 4, 23, 10, tzinfo=paris))

    context = load(client, organizer).context

    assert context["total"] == 4
    assert context["hours"][21]["count"] == 3
    assert context["hours"][23]["count"] == 1
    assert context["peak"]["label"] == "21:00–22:00"


@pytest.mark.django_db
def test_every_event_counts_in_its_own_timezone(readable, organizer):
    client, past = readable
    item = past.items.create(name="Entrée", default_price=10, admission=True)
    # 21:00 in Paris is 15:00 in New York, and "21:00" has to mean 21:00 at the
    # door or the histogram answers nothing.
    elsewhere = past_event(organizer, slug="ailleurs", timezone="America/New_York")
    from pretix.base.models import Team

    Team.objects.get(organizer=organizer).limit_events.add(elsewhere)
    other_item = elsewhere.items.create(name="Entrée", default_price=10, admission=True)

    paris = zoneinfo.ZoneInfo("Europe/Paris")
    when = datetime(2026, 7, 4, 21, 0, tzinfo=paris)
    arrival(past, item, when)
    arrival(elsewhere, other_item, when)

    hours = load(client, organizer).context["hours"]

    assert hours[21]["count"] == 1
    assert hours[15]["count"] == 1


@pytest.mark.django_db
def test_what_the_page_must_not_count(readable, organizer):
    client, past = readable
    item = past.items.create(name="Entrée", default_price=10, admission=True)
    paris = zoneinfo.ZoneInfo("Europe/Paris")
    when = datetime(2026, 7, 4, 21, 0, tzinfo=paris)

    arrival(past, item, when)
    # Checked in at payment: nobody walked in at this hour.
    arrival(past, item, when, auto=True)
    # Money that never existed.
    arrival(past, item, when, testmode=True)
    # Somebody leaving is not somebody arriving.
    arrival(past, item, when, kind=Checkin.TYPE_EXIT)

    # Every leak would change the grand total, so one number audits every filter.
    assert load(client, organizer).context["total"] == 1


@pytest.mark.django_db
def test_an_event_that_has_not_happened_yet_is_not_in_the_answer(
    readable, organizer, event, ticket
):
    client, past = readable
    item = past.items.create(name="Entrée", default_price=10, admission=True)
    paris = zoneinfo.ZoneInfo("Europe/Paris")
    arrival(past, item, datetime(2026, 7, 4, 21, 0, tzinfo=paris))
    # `event` runs tomorrow: scanning it would be scanning the future.
    arrival(event, ticket, now())

    context = load(client, organizer).context

    assert context["total"] == 1
    assert context["events_count"] == 1


@pytest.mark.django_db
def test_the_histogram_is_not_recomputed_on_every_load(
    readable, organizer, real_cache, monkeypatch
):
    client, past = readable
    item = past.items.create(name="Entrée", default_price=10, admission=True)
    paris = zoneinfo.ZoneInfo("Europe/Paris")
    arrival(past, item, datetime(2026, 7, 4, 21, 0, tzinfo=paris))

    assert load(client, organizer).context["total"] == 1

    # A scan added behind the cache's back. Reading every entry scan of every
    # past event is the one expensive thing this page does, and the answer
    # barely moves — an event that is over stops being scanned.
    arrival(past, item, datetime(2026, 7, 4, 22, 0, tzinfo=paris))

    assert load(client, organizer).context["total"] == 1


@pytest.mark.django_db
def test_reading_orders_is_enough_to_see_the_chart(readable, organizer, reader):
    _client, past = readable
    from pretix.base.models import Team

    Team.objects.get(members__email="benevole@example.org").limit_events.add(past)

    assert load(reader, organizer).status_code == 200


@pytest.mark.django_db
def test_a_team_that_may_read_nothing_is_refused(organizer, event, outsider):
    # The middleware has already checked membership of the organizer; this
    # narrows to the events whose orders the user may read, and the page
    # aggregates over exactly that set.
    response = load(outsider, organizer)

    assert response.status_code in (403, 404)


def test_a_coordinate_never_reaches_the_template_as_a_number():
    """
    Django localises bare numbers in templates.

    Under a French locale ``507.8`` renders as ``507,8``, and in an SVG
    attribute that comma makes a *list*: ``x="507,8"`` puts the first glyph at
    507 and every following glyph at 8. Each label then shows one character in
    place while the rest pile up at the edge of the chart.
    """
    assert px(507.8) == "507.8"
    assert px(46.0) == "46"
    assert px(0) == "0"

    geometry = chart_geometry([0] * 20 + [3, 7, 2, 0], 12)
    for bar in geometry["bars"]:
        assert isinstance(bar["cx"], str)
        assert isinstance(bar["band_x"], str)
    for tick in geometry["yticks"] + geometry["xticks"]:
        assert isinstance(next(iter(tick.values())), str)


def test_the_axis_reads_as_counting_rather_than_measuring():
    geometry = chart_geometry([0] * 23 + [7], 7)

    # The smallest 1/2/5-step that fits the peak in at most five intervals.
    assert [tick["label"] for tick in geometry["yticks"]] == [2, 4, 6, 8]


def test_an_hour_label_needs_no_translation():
    assert hour_label(21) == "21:00–22:00"
    assert hour_label(23) == "23:00–00:00"


def test_a_bar_too_short_to_round_is_drawn_square():
    # One arrival against a peak of a hundred is two pixels tall; a rounded cap
    # on it would be a rounding of nothing, and the path renders as a blob.
    by_hour = [0] * 24
    by_hour[21] = 100
    by_hour[3] = 1

    geometry = chart_geometry(by_hour, total=101)

    assert "Q" in geometry["bars"][21]["d"]
    assert "Q" not in geometry["bars"][3]["d"]


def test_an_hour_with_nobody_in_it_is_drawn_as_nothing_at_all():
    by_hour = [0] * 24
    by_hour[21] = 10

    geometry = chart_geometry(by_hour, total=10)

    assert geometry["bars"][0]["d"] is None


def test_the_axis_counts_in_round_numbers_rather_than_measuring():
    by_hour = [0] * 24
    by_hour[21] = 12

    geometry = chart_geometry(by_hour, total=12)

    # 12 arrivals, in steps of five: an axis topping out at 15, not at 12.
    assert [tick["label"] for tick in geometry["yticks"]] == [5, 10, 15]


def test_an_evening_bigger_than_any_step_still_gets_a_scale():
    # Past the largest step in the table the axis has to be worked out rather
    # than looked up, or the chart divides by a step that is None.
    by_hour = [0] * 24
    by_hour[21] = 120_000

    geometry = chart_geometry(by_hour, total=120_000)

    assert geometry["yticks"][-1]["label"] >= 120_000
    assert geometry["bars"][21]["d"] is not None


@pytest.mark.django_db
def test_each_evening_that_has_begun_is_a_row_with_its_own_figures(
    readable, organizer, event, ticket
):
    client, past = readable
    item = past.items.create(name="Entrée", default_price=10, admission=True)
    paris = zoneinfo.ZoneInfo("Europe/Paris")
    for minute in (0, 5, 40):
        arrival(past, item, datetime(2026, 7, 4, 21, minute, tzinfo=paris))
    # Bought, never came.
    OrderPosition.objects.create(
        order=Order.objects.create(
            event=past, status=Order.STATUS_PAID, datetime=now(), expires=now(),
            total=Decimal("10.00"),
            sales_channel=organizer.sales_channels.get(identifier="web"),
        ),
        item=item, positionid=1, price=Decimal("10.00"),
    )
    tonight = past_event(organizer, slug="ce-soir")
    tonight.date_from = now() - timedelta(hours=1)
    tonight.date_to = now() + timedelta(hours=4)
    tonight.save()
    Team.objects.get(organizer=organizer).limit_events.add(tonight)
    tonight.checkin_lists.create(name="Porte", all_products=True)

    response = load(client, organizer)
    rows = response.context["evening_rows"]

    # Newest first; `event` has not begun, so it is not an evening yet.
    assert [row["event"] for row in rows] == [tonight, past]
    assert (rows[1]["entered"], rows[1]["expected"], rows[1]["percent"]) == (3, 4, 75)
    assert (rows[1]["rush"], rows[1]["rush_count"]) == ("21:00–21:15", 2)
    assert not rows[0]["over"] and rows[1]["over"]
    body = response.content.decode()
    assert f"/control/event/{organizer.slug}/{past.slug}/openpos/arrivals/" in body


@pytest.mark.django_db
def test_each_date_of_a_series_is_an_evening_of_its_own(readable, organizer, channel):
    from .test_series import a_date, an_item, series_event

    client, _past = readable
    series = series_event(organizer)
    Team.objects.get(organizer=organizer).limit_events.add(series)
    first = a_date(series, "Première", now() - timedelta(days=14), now() - timedelta(days=14) + timedelta(hours=5))
    second = a_date(series, "Seconde", now() - timedelta(days=7), now() - timedelta(days=7) + timedelta(hours=5))
    a_date(series, "À venir", now() + timedelta(days=7))
    item = an_item(series, channel, first)
    door = series.checkin_lists.create(name="Porte", all_products=True)
    for date, count in ((first, 2), (second, 1)):
        for _ in range(count):
            order = Order.objects.create(
                event=series, status=Order.STATUS_PAID, datetime=now(), expires=now(),
                total=Decimal("10.00"),
                sales_channel=organizer.sales_channels.get(identifier="web"),
            )
            position = OrderPosition.objects.create(
                order=order, item=item, positionid=1, price=Decimal("10.00"), subevent=date
            )
            Checkin.objects.create(position=position, list=door, datetime=date.date_from)

    rows = [row for row in load(client, organizer).context["evening_rows"] if row["event"] == series]

    assert [(row["subevent"], row["entered"]) for row in rows] == [(second, 1), (first, 2)]


@pytest.mark.django_db
def test_an_evening_that_is_over_is_not_recounted_on_every_load(
    readable, organizer, real_cache
):
    client, past = readable
    item = past.items.create(name="Entrée", default_price=10, admission=True)
    paris = zoneinfo.ZoneInfo("Europe/Paris")
    arrival(past, item, datetime(2026, 7, 4, 21, 0, tzinfo=paris))

    assert load(client, organizer).context["evening_rows"][0]["entered"] == 1

    # A scan added behind the cache's back: an evening that is over stops
    # being scanned, and a row per evening is a count per evening.
    arrival(past, item, datetime(2026, 7, 4, 22, 0, tzinfo=paris))

    assert load(client, organizer).context["evening_rows"][0]["entered"] == 1


@pytest.mark.django_db
def test_an_evening_with_nothing_to_count_on_says_so(readable, organizer):
    client, past = readable

    response = load(client, organizer)

    assert response.context["evening_rows"][0]["expected"] is None
    assert "no check-in list" in response.content.decode()


@pytest.mark.django_db
def test_the_organizer_page_reads_in_french(readable, organizer):
    from pretix.base.models import User

    client, past = readable
    User.objects.filter(email="boss@example.org").update(locale="fr")
    item = past.items.create(name="Entrée", default_price=10, admission=True)
    arrival(past, item, datetime(2026, 7, 4, 21, 0, tzinfo=zoneinfo.ZoneInfo("Europe/Paris")))

    body = load(client, organizer).content.decode()

    for french in (
        "Arrivées", "Par événement", "Entrés", "Attendus", "Vendus sur place",
        "Plus forte affluence", "Heure d’arrivée, toutes soirées passées confondues",
    ):
        assert french in body, french
