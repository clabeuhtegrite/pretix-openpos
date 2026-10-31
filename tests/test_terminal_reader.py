"""
What a till's card reader says about itself, read from the till's settings.

Ad asked for it on the evening of 31 October 2026: the settings of a till with
a reader show how that reader is. The back office's card readers page already
asked SumUp the question for every reader on the account; ``terminal/reader``
asks it for the one this till drives, from the counter it sits on.

What matters, and what these tests hold it to: the reader asked is this till's
and no other's; SumUp is given no longer than a poll would give it; and a
reader SumUp says nothing about is "unknown", never "offline" — the same rule
the back office keeps, for the same reason.
"""
import pytest
import requests

from pretix_openpos.models import PosDevice
from pretix_openpos.sumup import POLL_TIMEOUT

from .sumup_stub import FakeResponse


def ask(till):
    return till.get("terminal/reader")


# -- what the till is told ----------------------------------------------------


@pytest.mark.django_db
def test_the_till_hears_how_its_reader_is(till, reader_till, sumup):
    sumup.set_state(
        reader_till, "IDLE", battery_level=72.6, connection_type="lte",
        firmware_version="3.3.41.0", last_activity="2026-10-31T20:04:12Z",
    )

    response = ask(till)

    assert response.status_code == 200
    assert response.json() == {
        "reader": {
            "status": "ONLINE",
            "state": "IDLE",
            # Rounded: nobody reads a battery to the decimal.
            "battery": 73,
            # SumUp's word, which the till turns into "4G".
            "connection": "lte",
            "firmware": "3.3.41.0",
            # The shape of JavaScript's toISOString(), which Safari parses.
            "last_activity": "2026-10-31T20:04:12.000Z",
        },
        "reason": "",
    }


@pytest.mark.django_db
def test_an_offline_reader_says_so_with_what_it_last_said(till, reader_till, sumup):
    sumup.set_state(
        reader_till, "IDLE", status="OFFLINE", battery_level=8,
        last_activity="2026-10-31T19:41:00+00:00",
    )

    reader = ask(till).json()["reader"]

    assert reader["status"] == "OFFLINE"
    assert reader["battery"] == 8
    assert reader["last_activity"] == "2026-10-31T19:41:00.000Z"


@pytest.mark.django_db
@pytest.mark.parametrize("state", ["WAITING_FOR_CARD", "UPDATING_FIRMWARE"])
def test_what_the_reader_is_busy_with_is_passed_on_as_sumup_says_it(till, reader_till, sumup, state):
    sumup.set_state(reader_till, state)

    assert ask(till).json()["reader"]["state"] == state


@pytest.mark.django_db
def test_the_reader_asked_is_this_till_s_and_no_other(till, device, sumup):
    sumup.set_state(sumup.add_reader("rdr_OTHER"), "WAITING_FOR_CARD")
    mine = sumup.set_state(sumup.add_reader("rdr_MINE"), "IDLE")
    PosDevice.objects.create(device=device, role=PosDevice.ROLE_TILL, sumup_reader_id=mine)

    assert ask(till).json()["reader"]["state"] == "IDLE"
    assert sumup.call_paths("GET") == [f"/v0.1/merchants/{sumup.merchant}/readers/rdr_MINE/status"]


@pytest.mark.django_db
def test_sumup_is_given_no_longer_than_a_poll_gives_it(till, reader_till, sumup):
    """
    A pretix runs on a handful of workers, and a SumUp slow to answer must not
    hold one of them for the back office's bound, let alone the full timeout,
    while the door and the other tills queue behind it.
    """
    sumup.set_state(reader_till)

    ask(till)

    assert [timeout for _method, _path, timeout in sumup.timeouts] == [POLL_TIMEOUT]


# -- when there is no state to show -------------------------------------------


@pytest.mark.django_db
def test_a_reader_that_cannot_be_asked_is_unknown_not_offline(till, reader_till, sumup):
    """
    No entry in the stub answers 404, as a Solo on firmware older than 3.3.39.0
    does: old enough to take payments, too old to be asked about itself.
    """
    response = ask(till)

    assert response.status_code == 200
    assert response.json() == {"reader": None, "reason": "no_answer"}


@pytest.mark.django_db
@pytest.mark.parametrize(
    "failure",
    [requests.Timeout("read timed out"), requests.ConnectionError("no route to host")],
)
def test_a_sumup_out_of_reach_is_no_answer_rather_than_an_error(till, reader_till, sumup, failure):
    sumup.next_exception = failure

    response = ask(till)

    assert response.status_code == 200
    assert response.json() == {"reader": None, "reason": "no_answer"}


@pytest.mark.django_db
def test_a_sumup_failing_on_its_side_is_no_answer_too(till, reader_till, sumup):
    sumup.next_response = FakeResponse(503, {"message": "maintenance"})

    assert ask(till).json() == {"reader": None, "reason": "no_answer"}


@pytest.mark.django_db
def test_without_a_sumup_account_nothing_is_asked_and_the_till_is_told_why(
    till, organizer, reader_till, sumup,
):
    organizer.settings.set("openpos_sumup_api_key", "")

    response = ask(till)

    assert response.json() == {"reader": None, "reason": "not_configured"}
    assert sumup.calls == []


# -- what SumUp sends that is not what it documents ---------------------------


@pytest.mark.django_db
@pytest.mark.parametrize("battery", ["72", True, None, [72]])
def test_a_battery_that_is_not_a_number_is_left_out(till, reader_till, sumup, battery):
    sumup.set_state(reader_till, battery_level=battery)

    assert ask(till).json()["reader"]["battery"] is None


@pytest.mark.django_db
@pytest.mark.parametrize("moment", ["yesterday", "2026-13-01T10:00:00Z", 1793476800, None, ""])
def test_a_last_activity_that_is_not_a_moment_is_left_out(till, reader_till, sumup, moment):
    sumup.set_state(reader_till, last_activity=moment)

    assert ask(till).json()["reader"]["last_activity"] is None


@pytest.mark.django_db
def test_a_moment_without_its_zone_is_read_as_utc(till, reader_till, sumup):
    sumup.set_state(reader_till, last_activity="2026-10-31T20:04:12")

    assert ask(till).json()["reader"]["last_activity"] == "2026-10-31T20:04:12.000Z"


@pytest.mark.django_db
def test_fields_sumup_leaves_out_come_back_empty(till, reader_till, sumup):
    # ``status`` is the one field SumUp's schema requires.
    sumup.next_response = FakeResponse(200, {"data": {"status": "ONLINE"}})

    assert ask(till).json()["reader"] == {
        "status": "ONLINE",
        "state": "",
        "battery": None,
        "connection": "",
        "firmware": "",
        "last_activity": None,
    }


# -- who may ask ----------------------------------------------------------------


@pytest.mark.django_db
def test_a_till_with_no_reader_has_nothing_to_ask_about(till, sumup):
    response = ask(till)

    assert response.status_code == 400
    assert response.json()["code"] == "no_terminal"
    assert sumup.calls == []


@pytest.mark.django_db
def test_a_door_is_no_different(till, device, sumup):
    PosDevice.objects.create(device=device, role=PosDevice.ROLE_DOOR)

    assert ask(till).json()["code"] == "no_terminal"


@pytest.mark.django_db
def test_a_scanning_device_may_not_ask(till, device, reader_till, sumup):
    """The Open POS profile lets a till ask; pretixSCAN's is not a till's."""
    device.security_profile = "pretixscan"
    device.save(update_fields=["security_profile"])

    assert ask(till).status_code == 403
    assert sumup.calls == []
