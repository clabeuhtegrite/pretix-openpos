"""
Which events a paired device is told about, and which of them it may switch to.

The answer is the whole of what the app knows about the organizer's other
events. Leaving one out of it does not refuse anything — it hides it, from the
one screen that could have said why.
"""
from datetime import timedelta

import pytest
from django.test import Client
from django.utils.timezone import now
from pretix.base.models import Device, Event, Item, Quota, Team, TeamAPIToken
from pretix.base.models.devices import generate_api_token

from .conftest import Till, sell


def another_event(organizer, slug, *, days=7, plugins="pretix_openpos", live=True):
    return Event.objects.create(
        organizer=organizer,
        name=slug.replace("-", " ").capitalize(),
        slug=slug,
        date_from=now() + timedelta(days=days),
        plugins=plugins,
        live=live,
        currency="EUR",
    )


def listing(client, organizer, authorization=None):
    headers = {"HTTP_AUTHORIZATION": authorization} if authorization else {}
    response = client.get(f"/api/v1/organizers/{organizer.slug}/openpos/", **headers)
    assert response.status_code == 200
    return response.json()


def ask(till, organizer):
    return listing(till.client, organizer, f"Device {till.device.api_token}")


def slugs(entries):
    return [entry["slug"] for entry in entries]


@pytest.mark.django_db
def test_every_event_that_runs_open_pos_is_offered(till, event, organizer):
    later = another_event(organizer, "soiree-suivante")

    assert slugs(ask(till, organizer)["results"]) == [event.slug, later.slug]


@pytest.mark.django_db
def test_an_event_whose_shop_is_not_online_is_offered_all_the_same(till, event, organizer):
    # The next evening, copied from the last and not published yet — or one that
    # only ever sells at the door. Its shop being offline is the public's
    # business; this list used to drop it, and a device with access to two
    # events then showed no choice at all.
    draft = another_event(organizer, "en-preparation", live=False)

    assert slugs(ask(till, organizer)["results"]) == [event.slug, draft.slug]


@pytest.mark.django_db
def test_an_event_without_open_pos_is_named_with_the_reason(till, event, organizer):
    without = another_event(organizer, "sans-caisse", plugins="")

    body = ask(till, organizer)

    # Not offered: its endpoints would refuse the device the moment it switched.
    assert slugs(body["results"]) == [event.slug]
    # But not hidden either. It is the one somebody is looking for when the
    # event they expected is missing, and the fix is one tick in the back office.
    assert body["unavailable"] == [
        {
            "slug": without.slug,
            "organizer": organizer.slug,
            "name": "Sans caisse",
            "currency": "EUR",
            "testmode": False,
            "date_from": without.date_from.isoformat(),
            "reason": "plugin_disabled",
        }
    ]


@pytest.mark.django_db
def test_the_events_come_in_date_order(till, event, organizer):
    last_week = another_event(organizer, "la-semaine-derniere", days=-7)
    next_month = another_event(organizer, "le-mois-prochain", days=30)

    assert slugs(ask(till, organizer)["results"]) == [last_week.slug, event.slug, next_month.slug]


@pytest.mark.django_db
def test_a_device_limited_to_some_events_hears_of_no_other(organizer, event):
    elsewhere = another_event(organizer, "pas-pour-elle")
    another_event(organizer, "pas-pour-elle-non-plus", plugins="")
    device = Device.objects.create(
        organizer=organizer,
        name="Caisse prêtée",
        all_events=False,
        security_profile="openpos",
        api_token=generate_api_token(),
        initialized=now(),
    )
    device.limit_events.add(event)

    body = ask(Till(device, event), organizer)

    assert slugs(body["results"]) == [event.slug]
    assert body["unavailable"] == []
    assert elsewhere.slug not in str(body)


@pytest.mark.django_db
def test_a_team_token_hears_only_of_its_own_events(organizer, event):
    another_event(organizer, "pas-pour-elle", live=False)
    team = Team.objects.create(organizer=organizer, name="Intégration", all_events=False)
    team.limit_events.add(event)
    token = TeamAPIToken.objects.create(team=team, name="Script")

    body = listing(Client(), organizer, f"Token {token.token}")

    assert slugs(body["results"]) == [event.slug]
    assert body["unavailable"] == []


@pytest.mark.django_db
def test_a_back_office_user_hears_only_of_the_events_their_team_reaches(
    backoffice, event, organizer
):
    # The answer names events that are not on sale yet. A draft's name is not
    # public, so it must not reach somebody whose team was never given it.
    another_event(organizer, "en-preparation", live=False)

    body = listing(backoffice, organizer)

    assert slugs(body["results"]) == [event.slug]
    assert body["unavailable"] == []


@pytest.mark.django_db
def test_a_till_sells_on_an_event_whose_shop_is_not_online(device, organizer, channel):
    # What makes offering such an event safe rather than a trap: nothing on the
    # till's side ever depended on the shop being live.
    draft = another_event(organizer, "porte-seulement", live=False)
    entry = Item.objects.create(
        event=draft, name="Entrée sur place", default_price=8, all_sales_channels=False
    )
    entry.limit_sales_channels.add(channel)
    Quota.objects.create(event=draft, name="Salle", size=None).items.add(entry)
    till = Till(device, draft)

    assert till.get("config").status_code == 200
    response = sell(till, [{"item": entry.pk, "count": 2}])

    assert response.status_code == 201
    assert draft.orders.get(code=response.json()["order"]["code"]).total == 16
