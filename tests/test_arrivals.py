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
from pretix.base.models import Checkin, Event, Order, OrderPosition

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
