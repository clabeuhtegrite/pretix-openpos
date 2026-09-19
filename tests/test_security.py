"""
What a paired till may reach, and what it may not.

The device token lives in localStorage on a tablet that sits on a counter, so it
should be assumed to leak eventually. The security profile is what decides how
much a leaked one is worth — and a profile is only as good as the list in it,
which is a list nothing else in the codebase checks.
"""
import pathlib
import re

import pytest
from pretix.base.models import Device
from pretix.base.models.devices import generate_api_token

import pretix_openpos
from pretix_openpos.pwa import SHELL_CSP


def as_device(client, device, method, path, **kwargs):
    return getattr(client, method)(
        path, HTTP_AUTHORIZATION=f"Device {device.api_token}", **kwargs
    )


def api(event, path):
    return f"/api/v1/organizers/{event.organizer.slug}/events/{event.slug}/{path}"


@pytest.mark.django_db
@pytest.mark.parametrize(
    "action", ["config", "catalog", "history", "summary"]
)
def test_the_till_reaches_what_the_app_needs(till, action):
    assert till.get(action).status_code == 200


@pytest.mark.django_db
def test_the_till_cannot_read_the_general_order_api(till, event, ticket):
    from .conftest import sell

    sell(till, [{"item": ticket.pk, "count": 1}])

    response = as_device(till.client, till.device, "get", api(event, "orders/"))

    # Devices already cannot touch events, products or vouchers, but the default
    # profile still grants blanket read/write on every order of every event the
    # device can see. This one does not.
    assert response.status_code == 403


@pytest.mark.django_db
def test_the_till_cannot_change_an_order(till, event, ticket):
    from .conftest import sell

    sale = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    response = as_device(
        till.client, till.device, "post",
        api(event, f"orders/{sale['order']['code']}/mark_canceled/"),
        content_type="application/json", data={},
    )

    # Correcting a sale goes through the POS endpoint, which refuses anything
    # that is not this device's own.
    assert response.status_code == 403


@pytest.mark.django_db
def test_the_till_may_scan_through_pretix_own_check_in_rpc(till, event, checkin_list):
    response = till.client.post(
        f"/api/v1/organizers/{event.organizer.slug}/checkinrpc/redeem/",
        data={
            "lists": [checkin_list.pk],
            "secret": "nothing-here",
            "source_type": "barcode",
            "type": "entry",
            "questions_supported": False,
        },
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Device {till.device.api_token}",
    )

    # The verdict is pretix' own — 404 for an unknown ticket — and what matters
    # here is that the profile let the call through at all.
    assert response.status_code != 403
    assert response.json()["status"] == "error"


@pytest.mark.django_db
def test_the_till_may_look_a_ticket_up_by_name(till, event, checkin_list):
    response = till.client.get(
        f"/api/v1/organizers/{event.organizer.slug}/checkinrpc/search/"
        f"?list={checkin_list.pk}&search=dupont",
        HTTP_AUTHORIZATION=f"Device {till.device.api_token}",
    )

    # Tickets carry a QR and nothing a human could retype; when the code will
    # not scan this is the only way through.
    assert response.status_code == 200


@pytest.mark.django_db
def test_a_device_on_the_default_profile_cannot_use_the_till_endpoints(
    organizer, event, ticket
):
    from django.test import Client
    from django.utils.timezone import now

    full = Device.objects.create(
        organizer=organizer, name="pretixSCAN", all_events=True,
        security_profile="pretixscan", api_token=generate_api_token(), initialized=now(),
    )

    response = as_device(Client(), full, "get", api(event, "openpos/config/"))

    # The profile cuts both ways: a scanning device has no business selling.
    assert response.status_code == 403


@pytest.mark.django_db
def test_a_revoked_till_is_locked_out(till, event):
    till.device.revoked = True
    till.device.save()

    assert till.get("config").status_code == 401


def directives(header):
    """A CSP header as ``{name: {source, ...}}``."""
    parsed = {}
    for part in header.split(";"):
        name, _space, sources = part.strip().partition(" ")
        if name:
            parsed[name] = set(sources.split())
    return parsed


@pytest.mark.django_db
def test_the_app_shell_is_served_to_anyone(client):
    response = client.get("/openpos/")

    # Deliberately unauthenticated: the bundle holds no secrets, and the token
    # that does is obtained through pairing and kept in the browser.
    assert response.status_code == 200
    assert "Content-Security-Policy" in response


def test_no_template_explains_itself_to_the_customer():
    """
    Comments stay comments, in every template this plugin ships.

    Django's ``{#…#}`` is **single-line only**: written across several lines it
    stops being a comment and is rendered as text. The failure is silent — the
    page works, the markup is valid, the tests pass — and it had already put
    three lines of prose on the back-office order page before this test
    existed. Checked over the source rather than over one rendered page,
    because the templates that are hardest to render under test are exactly
    the ones nobody would notice.
    """
    templates = pathlib.Path(pretix_openpos.__file__).parent / "templates"
    offenders = [
        path.relative_to(templates)
        for path in templates.rglob("*.html")
        for comment in re.findall(r"\{#.*?#\}", path.read_text(), re.S)
        if "\n" in comment
    ]

    assert offenders == [], (
        "these comments span several lines and will be served as text; "
        "use {% comment %}"
    )


@pytest.mark.django_db
def test_the_shell_serves_no_prose_of_its_own(client):
    """The same thing again, on the one page a customer's till loads."""
    body = client.get("/openpos/").content.decode()

    assert "{#" not in body
    assert "{%" not in body
    # The word every comment in that template is about, and the one nobody
    # would put on screen on purpose.
    assert "palette" not in body


@pytest.mark.django_db
def test_no_script_may_run_that_did_not_come_from_this_server(client):
    """
    The one property the shell's CSP exists for.

    The device token lives in localStorage on a tablet on a counter, and a
    script injected from anywhere would walk off with it. Asserted on the header
    that is actually sent rather than on the constant: pretix' own middleware
    re-parses ours and merges its instance-wide policy into it, adding its site
    URL and widening some directives — so the constant is a request, and this is
    the answer.
    """
    sent = directives(client.get("/openpos/")["Content-Security-Policy"])

    assert "'unsafe-inline'" not in sent["script-src"]
    assert "'unsafe-eval'" not in sent["script-src"]
    assert "*" not in sent["script-src"]
    assert sent["object-src"] == {"'none'"}
    # React writes style attributes, which is the one allowance made.
    assert "'unsafe-inline'" in sent["style-src"]


@pytest.mark.django_db
def test_the_policy_the_shell_asks_for_is_the_narrow_one(client):
    asked = directives(SHELL_CSP)

    assert asked["script-src"] == {"'self'"}
    assert asked["connect-src"] == {"'self'"}
    assert asked["default-src"] == {"'self'"}
    # pretix' middleware refuses directives outside its own whitelist with a
    # 500 — found by serving the page, not by reading the docs. Framing is
    # already denied by the global X-Frame-Options and the page carries no
    # <base>, so neither is missed.
    assert "frame-ancestors" not in asked
    assert "base-uri" not in asked


@pytest.mark.django_db
def test_the_service_worker_is_never_cached(client):
    response = client.get("/openpos/sw.js")

    # A stale worker is how a PWA gets stuck on an old build.
    assert response.status_code == 200
    assert "no-cache" in response["Cache-Control"]
    assert "max-age=0" in response["Cache-Control"]


@pytest.mark.django_db
def test_the_manifest_points_at_the_installable_url(client):
    body = client.get("/openpos/manifest.webmanifest").json()

    assert body["start_url"] == "/openpos/"
    # The worker may only control URLs at or below its own path.
    assert body["scope"] == "/openpos/"
    assert body["display"] == "standalone"


@pytest.mark.django_db
def test_the_installed_app_can_be_given_the_venue_s_name(client):
    from pretix.base.settings import GlobalSettingsObject

    GlobalSettingsObject().settings.set("openpos_app_name", "Salle des fêtes")

    assert client.get("/openpos/manifest.webmanifest").json()["name"] == "Salle des fêtes"


@pytest.mark.django_db
def test_a_caller_that_is_not_a_till_gets_no_till_history(backoffice, till, event, ticket):
    # The journal is per-device by design. Answering a session-authenticated
    # user with the whole event's would quietly widen an endpoint whose whole
    # point is being narrow.
    from .conftest import sell

    sell(till, [{"item": ticket.pk, "count": 1}])

    response = backoffice.get(
        f"/api/v1/organizers/{event.organizer.slug}/events/{event.slug}/openpos/history/"
    )

    assert response.status_code == 200
    assert response.json() == {"device": None, "results": [], "truncated": False}


@pytest.mark.django_db
def test_a_caller_that_is_not_a_till_still_sees_which_events_run_one(
    backoffice, event, organizer
):
    # Same endpoint, no device: the answer comes from the organizer's events
    # rather than from a device's permissions.
    response = backoffice.get(f"/api/v1/organizers/{organizer.slug}/openpos/")

    assert response.status_code == 200
    assert [e["slug"] for e in response.json()["results"]] == [event.slug]
