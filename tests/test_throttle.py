"""
How much one tablet may ask of the server.

pretix runs on a handful of workers, and a till is a tablet left on a counter
all evening with a token in it. Nothing used to bound what that token could
send; now each device has a budget, spent by every Open POS endpoint alike, and
a device over it is told to come back — with a code the app reads as "not now",
so a queued sale answered this way stays queued.

The budget is counted in the cache, which the suite otherwise runs without:
every test here asks for the real one.
"""
import pytest
from django.test import Client
from pretix.base.models import Team, TeamAPIToken

from pretix_openpos.api.throttling import DeviceRateThrottle
from pretix_openpos.models import PosSale

from .conftest import sell


@pytest.fixture
def budget(monkeypatch, real_cache):
    """A budget small enough to run out of in a test: three requests a minute."""
    monkeypatch.setattr(DeviceRateThrottle, "rate", "3/min")
    return 3


def events_of(client, organizer, authorization):
    return client.get(
        f"/api/v1/organizers/{organizer.slug}/openpos/", HTTP_AUTHORIZATION=authorization
    )


@pytest.mark.django_db
def test_a_device_over_its_budget_is_told_when_to_come_back(till, budget):
    for _ in range(budget):
        assert till.get("config").status_code == 200

    response = till.get("config")

    assert response.status_code == 429
    assert 0 < int(response["Retry-After"]) <= 60
    body = response.json()
    assert body["code"] == "rate_limited"
    assert body["detail"] == "This device is sending too many requests. Try again in a moment."


@pytest.mark.django_db
def test_the_budget_is_spent_by_every_endpoint_alike(till, organizer, ticket, budget):
    till.get("config")
    till.get("catalog")
    events_of(till.client, organizer, f"Device {till.device.api_token}")

    response = sell(till, [{"item": ticket.pk, "count": 1}])

    # Refused before anything was written: sent again later under the same
    # key, the sale is a first attempt, not a replay of a half-done one.
    assert response.status_code == 429
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_the_organizer_level_list_counts_against_the_same_budget(till, organizer, budget):
    for _ in range(budget):
        till.get("config")

    response = events_of(till.client, organizer, f"Device {till.device.api_token}")

    assert response.status_code == 429
    assert response.json()["code"] == "rate_limited"


@pytest.mark.django_db
def test_each_device_has_a_budget_of_its_own(till, another_till, budget):
    for _ in range(budget):
        till.get("config")

    assert till.get("config").status_code == 429
    assert another_till.get("config").status_code == 200


@pytest.mark.django_db
def test_an_organizer_s_own_token_is_not_counted(organizer, event, monkeypatch, real_cache):
    monkeypatch.setattr(DeviceRateThrottle, "rate", "1/min")
    team = Team.objects.create(organizer=organizer, name="Intégration", all_events=True)
    token = TeamAPIToken.objects.create(team=team, name="Script")
    client = Client()

    for _ in range(3):
        assert events_of(client, organizer, f"Token {token.token}").status_code == 200


@pytest.mark.django_db
def test_a_busy_till_never_comes_near_its_budget(till, real_cache):
    """
    The worst minute of a till's evening: its network is back, it drains the
    hundred sales it queued without one, and it polls the reader for a card
    every two seconds all the while — a hundred and thirty requests. Not one of
    them may be told to wait. Every endpoint spends the budget alike (above),
    so the cheapest one stands in for all of them here.
    """
    answers = [till.get("config").status_code for _ in range(100 + 30)]

    assert set(answers) == {200}
    # And the budget has room for that minute four times over.
    assert DeviceRateThrottle().num_requests >= 4 * len(answers)
