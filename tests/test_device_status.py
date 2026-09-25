"""
What a tablet was last heard saying, and where the back office shows it.

pretix keeps a device's creation and pairing dates and nothing after that, so
the back office could not tell a till quiet since 21:14 from one that sold a
round a minute ago — nor that the quiet one is holding fifteen cash sales it
has not sent. That is the question to ask before counting a drawer: the amount
it should hold is computed from the sales the server has, and a sale still on
the tablet is not one of them.

Two sources, tested apart. The server writes down when a device last reached
it, on every Open POS call, at most once a minute and never at the cost of the
call. The app reports what it holds through one endpoint, whose shape is a
contract with the app: ``POST /api/v1/organizers/{organizer}/openpos/status/``.
"""
from datetime import datetime, timedelta, timezone as dt_timezone
from zoneinfo import ZoneInfo

import pytest
from django.db import IntegrityError
from django.test import Client
from django.utils.timezone import now
from pretix.base.models import Device, Team, TeamAPIToken
from pretix.base.models.devices import generate_api_token

from pretix_openpos.models import PosDevice

from .conftest import sell
from .test_drawer_backoffice import drawer_url, drawers_url, session_url
from .test_drawers import count_it, give_drawer, open_it

PARIS = ZoneInfo("Europe/Paris")


def status_url(organizer):
    return f"/api/v1/organizers/{organizer.slug}/openpos/status/"


def report(device, body, client=None):
    return (client or Client()).post(
        status_url(device.organizer),
        data=body,
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Device {device.api_token}",
    )


def body(**changes):
    """A report as the app sends it: fifteen cash sales waiting since 21:14."""
    return {
        "pending_sales": 15,
        "oldest_pending_at": "2026-09-25T19:14:00.000Z",
        "last_sync_at": "2026-09-25T19:10:30.000Z",
        "version": "0.25.0",
        **changes,
    }


def row(device):
    return PosDevice.objects.get(device=device)


# -- the report -------------------------------------------------------------


@pytest.mark.django_db
def test_a_till_says_what_it_holds_and_is_given_the_server_s_clock(device):
    before = now()

    response = report(device, body())

    assert response.status_code == 200
    answer = response.json()
    assert set(answer) == {"server_time"}
    # ISO 8601, UTC, in the shape of JavaScript's toISOString(): the one form
    # every browser is required to parse.
    assert answer["server_time"].endswith("Z")
    assert len(answer["server_time"]) == len("2026-09-25T21:14:03.120Z")
    server_time = datetime.fromisoformat(answer["server_time"].replace("Z", "+00:00"))
    assert before - timedelta(seconds=1) <= server_time <= now()

    stored = row(device)
    assert stored.pending_sales == 15
    assert stored.oldest_pending_at == datetime(2026, 9, 25, 19, 14, tzinfo=dt_timezone.utc)
    assert stored.last_sync_at == datetime(2026, 9, 25, 19, 10, 30, tzinfo=dt_timezone.utc)
    assert stored.app_version == "0.25.0"
    # The report's own time is the server's, not the tablet's.
    assert before <= stored.status_reported_at <= now()
    assert stored.last_seen_at == stored.status_reported_at


@pytest.mark.django_db
def test_a_report_leaves_what_the_organizer_set_alone(device):
    PosDevice.objects.create(device=device, role=PosDevice.ROLE_TILL, sumup_reader_id="rdr_ABC")

    report(device, body())

    stored = row(device)
    assert (stored.role, stored.sumup_reader_id) == (PosDevice.ROLE_TILL, "rdr_ABC")


@pytest.mark.django_db
def test_nothing_waiting_has_no_oldest(device):
    report(device, body())

    report(device, body(pending_sales=0, oldest_pending_at="2026-09-25T19:14:00Z"))

    assert (row(device).pending_sales, row(device).oldest_pending_at) == (0, None)


@pytest.mark.django_db
def test_the_times_may_be_null_or_left_out(device):
    assert report(device, body(oldest_pending_at=None, last_sync_at=None)).status_code == 200
    assert (row(device).oldest_pending_at, row(device).last_sync_at) == (None, None)

    lean = {"pending_sales": 0, "version": "0.25.0"}
    assert report(device, lean).status_code == 200


@pytest.mark.django_db
@pytest.mark.parametrize(
    "bad",
    [
        {"pending_sales": -1},
        {"pending_sales": "many"},
        {"pending_sales": 1.5},
        {"pending_sales": None},
        {"pending_sales": 2 ** 31},
        {"oldest_pending_at": "yesterday evening"},
        {"last_sync_at": 1727291640},
        {"version": "x" * 65},
        {"version": None},
    ],
)
def test_a_report_that_does_not_parse_is_refused_and_nothing_is_kept(device, bad):
    response = report(device, body(**bad))

    assert response.status_code == 400
    assert set(response.json()) <= {"pending_sales", "oldest_pending_at", "last_sync_at", "version"}
    assert not PosDevice.objects.filter(device=device, status_reported_at__isnull=False).exists()


@pytest.mark.django_db
@pytest.mark.parametrize("missing", ["pending_sales", "version"])
def test_a_report_missing_a_figure_is_refused(device, missing):
    incomplete = body()
    del incomplete[missing]

    assert report(device, incomplete).status_code == 400


@pytest.mark.django_db
def test_only_a_device_has_anything_to_report(organizer, event, backoffice):
    """A logged-in organizer, or a team's API token, has no queue."""
    assert backoffice.post(
        status_url(organizer), data=body(), content_type="application/json"
    ).status_code == 403

    team = Team.objects.create(
        organizer=organizer, name="API", all_events=True, all_event_permissions=True,
        all_organizer_permissions=True,
    )
    token = TeamAPIToken.objects.create(team=team, name="Compta")
    response = Client().post(
        status_url(organizer), data=body(), content_type="application/json",
        HTTP_AUTHORIZATION=f"Token {token.token}",
    )

    assert response.status_code == 403
    assert not PosDevice.objects.exists()


@pytest.mark.django_db
def test_a_device_reports_to_its_own_organizer_only(device, organizer):
    from pretix.base.models import Organizer

    other = Organizer.objects.create(name="Voisins", slug="voisins")

    response = Client().post(
        status_url(other), data=body(), content_type="application/json",
        HTTP_AUTHORIZATION=f"Device {device.api_token}",
    )

    assert response.status_code == 403


@pytest.mark.django_db
def test_a_device_on_pretix_own_scanner_profile_may_not_report(organizer):
    """Only the Open POS profile lists the endpoint; pretixSCAN's does not."""
    scanner = Device.objects.create(
        organizer=organizer, name="Scanner", all_events=True, security_profile="pretixscan",
        api_token=generate_api_token(), initialized=now(),
    )

    assert report(scanner, body()).status_code == 403


# -- the last contact ---------------------------------------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("action", ["config", "catalog", "history"])
def test_every_open_pos_call_says_the_device_was_there(till, device, action):
    before = now()

    assert till.get(action).status_code == 200

    assert before <= row(device).last_seen_at <= now()


@pytest.mark.django_db
def test_the_list_of_events_counts_as_a_contact_too(device, organizer, event):
    response = Client().get(
        f"/api/v1/organizers/{organizer.slug}/openpos/",
        HTTP_AUTHORIZATION=f"Device {device.api_token}",
    )

    assert response.status_code == 200
    assert row(device).last_seen_at is not None


@pytest.mark.django_db
def test_nobody_but_a_device_is_written_down(backoffice, organizer, event):
    backoffice.get(f"/api/v1/organizers/{organizer.slug}/openpos/")

    assert not PosDevice.objects.exists()


@pytest.mark.django_db
def test_the_contact_is_written_at_most_once_a_minute(till, device, real_cache):
    till.get("config")
    long_ago = now() - timedelta(hours=2)
    PosDevice.objects.filter(device=device).update(last_seen_at=long_ago)

    till.get("config")
    assert row(device).last_seen_at == long_ago

    # Once the minute is up, the next call writes it again.
    real_cache.clear()
    till.get("config")
    assert row(device).last_seen_at > long_ago


@pytest.mark.django_db
def test_a_cache_that_is_down_costs_the_till_nothing(till, device, monkeypatch, caplog):
    class Down:
        def add(self, *args, **kwargs):
            raise ConnectionError("redis is gone")

    # This module's cache only: pretix reads its own through the same proxy.
    monkeypatch.setattr("pretix_openpos.api.views.cache", Down())

    assert till.get("config").status_code == 200
    assert "could not write down the last contact" in caplog.text


@pytest.mark.django_db
def test_a_row_that_cannot_be_written_costs_the_till_nothing(till, device, ticket, monkeypatch):
    """
    Two first calls racing to create the row: one loses, and must not take the
    sale with it. Nor may it leave the device believing in a row that was never
    written — its role is what decides which card payments it may take.
    """
    def lost_the_race(**kwargs):
        raise IntegrityError("UNIQUE constraint failed: pretix_openpos_posdevice.device_id")

    monkeypatch.setattr(PosDevice.objects, "create", lost_the_race)

    response = sell(till, [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 201
    assert not PosDevice.objects.filter(device=device).exists()


@pytest.mark.django_db
def test_a_device_nobody_assigned_stays_unassigned(till, device):
    """The row the contact writes says nothing about what the device is for."""
    till.get("config")

    assert row(device).role == PosDevice.ROLE_UNSET
    assert till.get("config").json()["device"]["role"] == ""


# -- the devices screen -------------------------------------------------------


def devices_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/devices/"


def in_french(client):
    from pretix.base.models import User

    User.objects.filter(email="boss@example.org").update(locale="fr")
    return client


def at_paris(hour, minute, day=25):
    return datetime(2026, 9, day, hour, minute, tzinfo=PARIS)


@pytest.fixture
def evening_clock(monkeypatch, organizer):
    """The organizer in Paris, and the screens reading the clock at 21:40 there."""
    organizer.settings.set("timezone", "Europe/Paris")
    monkeypatch.setattr("pretix_openpos.devices.now", lambda: at_paris(21, 40))


@pytest.mark.django_db
def test_the_screen_says_when_each_device_was_last_heard_from(
    backoffice, organizer, device, evening_clock
):
    PosDevice.objects.create(device=device, last_seen_at=at_paris(21, 14))

    page = in_french(backoffice).get(devices_url(organizer)).content.decode()

    assert "Dernier contact" in page
    # Absolute as well as relative: "an hour ago" is no use in tomorrow's notes.
    assert "25/09/2026 21:14" in page


@pytest.mark.django_db
def test_a_device_never_heard_from_says_so(backoffice, organizer, device):
    page = in_french(backoffice).get(devices_url(organizer)).content.decode()

    assert "Aucun contact enregistré" in page


@pytest.mark.django_db
def test_sales_waiting_on_a_tablet_are_said_with_the_report_s_own_time(
    backoffice, organizer, device, evening_clock
):
    PosDevice.objects.create(
        device=device,
        last_seen_at=at_paris(21, 40),
        status_reported_at=at_paris(21, 40),
        pending_sales=15,
        oldest_pending_at=at_paris(21, 14),
    )

    page = in_french(backoffice).get(devices_url(organizer)).content.decode()

    assert "15 ventes en attente depuis 21:14" in page
    assert "signalé à 21:40" in page
    assert "text-warning" in page
    # And what it means for the drawer, once, above the table.
    assert "avant de compter" in page


@pytest.mark.django_db
def test_one_sale_waiting_since_yesterday_says_the_day(
    backoffice, organizer, device, evening_clock
):
    PosDevice.objects.create(
        device=device,
        status_reported_at=at_paris(23, 50, day=24),
        pending_sales=1,
        oldest_pending_at=at_paris(23, 30, day=24),
    )

    page = in_french(backoffice).get(devices_url(organizer)).content.decode()

    assert "1 vente en attente depuis le 24/09/2026 23:30" in page
    assert "signalé le 24/09/2026 23:50" in page


@pytest.mark.django_db
def test_a_count_without_a_time_is_still_said(backoffice, organizer, device, evening_clock):
    PosDevice.objects.create(
        device=device, status_reported_at=at_paris(21, 40), pending_sales=2,
    )

    page = in_french(backoffice).get(devices_url(organizer)).content.decode()

    assert "2 ventes en attente d’envoi" in page


@pytest.mark.django_db
def test_nothing_is_said_when_nothing_waits(backoffice, organizer, device, evening_clock):
    PosDevice.objects.create(
        device=device, last_seen_at=at_paris(21, 39), status_reported_at=at_paris(21, 39),
        pending_sales=0,
    )

    page = in_french(backoffice).get(devices_url(organizer)).content.decode()

    assert "en attente" not in page
    assert "avant de compter" not in page


@pytest.mark.django_db
def test_the_screen_speaks_english_too(backoffice, organizer, device, evening_clock):
    PosDevice.objects.create(
        device=device, last_seen_at=at_paris(21, 40), status_reported_at=at_paris(21, 40),
        pending_sales=3, oldest_pending_at=at_paris(21, 14),
    )

    page = backoffice.get(devices_url(organizer)).content.decode()

    assert "3 sales waiting since 21:14" in page
    assert "(reported at 21:40)" in page
    assert "Last contact" in page


# -- the drawer screens -------------------------------------------------------


def holding(device, pending, oldest, reported=None):
    PosDevice.objects.filter(device=device).update(
        status_reported_at=reported or now(), pending_sales=pending, oldest_pending_at=oldest,
    )


@pytest.mark.django_db
def test_an_open_drawer_says_what_its_tills_have_not_sent(
    backoffice, organizer, till, device, beer
):
    drawer = give_drawer(device)
    open_it(till)
    sell(till, [{"item": beer.pk, "count": 1}], idempotency_key="sale-00001")
    holding(device, 4, now() - timedelta(minutes=20))
    session = drawer.sessions.get()

    for url in (drawers_url(organizer), drawer_url(drawer), session_url(session)):
        page = in_french(backoffice).get(url).content.decode()

        assert "Pas encore dans ce montant" in page, url
        assert "Caisse bar — 4 ventes en attente depuis" in page, url


@pytest.mark.django_db
def test_a_drawer_with_nothing_waiting_says_nothing(backoffice, organizer, till, device):
    drawer = give_drawer(device)
    open_it(till)
    holding(device, 0, None)

    page = backoffice.get(session_url(drawer.sessions.get())).content.decode()

    assert "Not in this amount yet" not in page


@pytest.mark.django_db
def test_a_revoked_tablet_is_not_waited_for(backoffice, organizer, till, device):
    drawer = give_drawer(device)
    open_it(till)
    holding(device, 4, now())
    Device.objects.filter(pk=device.pk).update(revoked=True)

    page = backoffice.get(session_url(drawer.sessions.get())).content.decode()

    assert "Not in this amount yet" not in page


@pytest.mark.django_db
def test_a_closed_evening_is_only_warned_about_sales_that_may_be_its_own(
    backoffice, organizer, till, device
):
    """
    Sales rung up before the drawer closed may still land in it, late. Sales
    rung up tonight, reported tonight, have nothing to do with last week's.
    """
    drawer = give_drawer(device)
    open_it(till)
    count = count_it(till, "100.00").json()["entry"]
    till.post("drawer/close", {"idempotency_key": "close-00001", "count_seq": count["seq"]})
    session = drawer.sessions.get()
    url = session_url(session)

    holding(device, 2, session.closed_at - timedelta(minutes=5))
    assert "Not in this amount yet" in backoffice.get(url).content.decode()

    holding(device, 2, session.closed_at + timedelta(minutes=5))
    assert "Not in this amount yet" not in backoffice.get(url).content.decode()

    holding(device, 2, None, reported=session.opened_at - timedelta(hours=1))
    assert "Not in this amount yet" not in backoffice.get(url).content.decode()


# -- going back ---------------------------------------------------------------


@pytest.mark.django_db
def test_a_row_written_without_the_new_columns_still_goes_in(device):
    """
    What 0.24 does if it is put back after this: it gives a device a role by
    writing a row that knows nothing of these columns. The ones that are not
    nullable keep their default in the database for exactly this insert.
    """
    from django.db import connection

    with connection.cursor() as cursor:
        cursor.execute(
            f"INSERT INTO {PosDevice._meta.db_table} (device_id, role, sumup_reader_id) "
            "VALUES (%s, %s, %s)",
            [device.pk, PosDevice.ROLE_TILL, ""],
        )

    written = row(device)
    assert (written.pending_sales, written.app_version, written.last_seen_at) == (0, "", None)
