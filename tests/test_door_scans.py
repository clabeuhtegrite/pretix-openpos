"""
What the doors have scanned tonight, and which of it waited in a phone.

The scanner's own counter used to live in the app, and it went back to zero
whenever iOS reloaded the page — which is to say every time somebody at the
door stepped out of the app for a while. pretix writes every scan down anyway,
so the figure is counted from its rows: that one cannot be lost.

The same rows say which scans were made with no network and sent later, as long
as they were sent the way pretix expects an offline scan to be sent. A till
that forced every sale's check-in used to make that mark meaningless.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import Checkin, Order

from pretix_openpos.api.views import start_of_business_day

from .conftest import sell
from .test_attendance import sold_online


def redeem(till, clist, secret, **extra):
    """A scan, made the way the door screen makes it: pretix' own check-in RPC."""
    return till.client.post(
        f"/api/v1/organizers/{till.event.organizer.slug}/checkinrpc/redeem/",
        data={
            "lists": [clist.pk],
            "secret": secret,
            "source_type": "barcode",
            "type": "entry",
            "questions_supported": False,
            **extra,
        },
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Device {till.device.api_token}",
    )


def refused_offline(till, clist, secret, reason, at, nonce):
    """A refusal the door gave with no network, sent once it had one."""
    return till.client.post(
        f"/api/v1/organizers/{till.event.organizer.slug}/events/{till.event.slug}"
        f"/checkinlists/{clist.pk}/failed_checkins/",
        data={
            "raw_barcode": secret,
            "error_reason": reason,
            "datetime": at.isoformat(),
            "type": "entry",
            "nonce": nonce,
        },
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Device {till.device.api_token}",
    )


def scans(till, clist):
    return till.get("attendance", list=clist.pk).json()["scans"]


@pytest.mark.django_db
def test_the_counter_is_what_this_device_scanned_tonight(
    till, another_till, event, ticket, checkin_list
):
    positions = sold_online(event, ticket, 4)
    redeem(till, checkin_list, positions[0].secret)
    redeem(till, checkin_list, positions[1].secret)
    # Presented twice: pretix writes the second one down as a refusal.
    redeem(till, checkin_list, positions[1].secret)
    redeem(till, checkin_list, "not-a-ticket")
    redeem(another_till, checkin_list, positions[2].secret)

    body = scans(till, checkin_list)

    assert body["device"] == {"admitted": 2, "refused": 2, "other": 0, "offline": 0}
    # Every door, which is the figure of the evening.
    assert body["event"] == {"admitted": 3, "refused": 2, "other": 0, "offline": 0}
    assert body["since"] == start_of_business_day(event).isoformat()


@pytest.mark.django_db
def test_every_door_gets_a_line_and_this_one_is_named(
    till, another_till, event, ticket, checkin_list
):
    positions = sold_online(event, ticket, 3)
    redeem(till, checkin_list, positions[0].secret)
    redeem(another_till, checkin_list, positions[1].secret)
    redeem(another_till, checkin_list, positions[2].secret)

    devices = scans(till, checkin_list)["devices"]

    # Busiest first: it reads as a ranking of the doors, which is what it is.
    assert [(d["name"], d["admitted"], d["current"]) for d in devices] == [
        ("Caisse entrée", 2, False),
        ("Caisse bar", 1, True),
    ]


@pytest.mark.django_db
def test_a_device_that_has_not_scanned_yet_reads_zero(till, event, ticket, checkin_list):
    body = scans(till, checkin_list)

    assert body["device"] == {"admitted": 0, "refused": 0, "other": 0, "offline": 0}
    assert body["devices"] == []


@pytest.mark.django_db
def test_a_scan_from_the_back_office_counts_for_the_evening_under_no_device(
    till, event, ticket, checkin_list
):
    position = sold_online(event, ticket, 1)[0]
    Checkin.objects.create(position=position, list=checkin_list, raw_source_type="barcode")

    body = scans(till, checkin_list)

    assert body["event"]["admitted"] == 1
    assert body["devices"] == [
        {"name": None, "current": False, "admitted": 1, "refused": 0, "other": 0, "offline": 0}
    ]


@pytest.mark.django_db
def test_a_ticket_sold_at_the_till_is_not_a_scan(till, event, ticket, checkin_list):
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    sell(till, [{"item": ticket.pk, "count": 2}])

    # The two people are in the room, and the room says so — but nobody at the
    # door scanned anything.
    body = till.get("attendance", list=checkin_list.pk).json()
    assert body["entered"] == 2
    assert body["scans"]["device"]["admitted"] == 0


@pytest.mark.django_db
def test_a_t_shirt_scanned_at_the_door_is_not_somebody_let_in(
    till, event, ticket, beer, checkin_list
):
    shirt = sold_online(event, beer, 1)[0]

    redeem(till, checkin_list, shirt.secret)

    assert scans(till, checkin_list)["device"] == {
        "admitted": 0, "refused": 0, "other": 1, "offline": 0,
    }


@pytest.mark.django_db
def test_last_night_is_not_tonight(till, event, ticket, checkin_list):
    position = sold_online(event, ticket, 1)[0]
    redeem(till, checkin_list, position.secret)
    Checkin.all.update(datetime=start_of_business_day(event) - timedelta(minutes=1))

    assert scans(till, checkin_list)["device"]["admitted"] == 0


@pytest.mark.django_db
def test_an_offline_scan_counts_when_it_happened_and_says_it_was_offline(
    till, event, ticket, checkin_list
):
    position = sold_online(event, ticket, 1)[0]
    scanned_at = max(now() - timedelta(minutes=30), start_of_business_day(event))

    response = redeem(
        till, checkin_list, position.secret,
        force=True, datetime=scanned_at.isoformat(), nonce="scan-1",
    )

    assert response.status_code == 201
    checkin = Checkin.objects.get(position=position)
    # pretix' own offline mark: its check-in history shows the scan with the
    # time it arrived, and its export has a column for it.
    assert checkin.force_sent is True
    assert checkin.forced is False
    assert abs(checkin.datetime - scanned_at) < timedelta(seconds=1)
    assert scans(till, checkin_list)["device"] == {
        "admitted": 1, "refused": 0, "other": 0, "offline": 1,
    }


@pytest.mark.django_db
def test_an_offline_scan_sent_twice_is_one_entry(till, event, ticket, checkin_list):
    position = sold_online(event, ticket, 1)[0]
    at = now().isoformat()

    redeem(till, checkin_list, position.secret, force=True, datetime=at, nonce="scan-2")
    # The answer to the first one was lost on the way back, so the queue sends
    # it again under the same nonce.
    again = redeem(till, checkin_list, position.secret, force=True, datetime=at, nonce="scan-2")

    assert again.status_code == 201
    assert Checkin.objects.filter(position=position).count() == 1


@pytest.mark.django_db
def test_a_scan_that_waited_in_a_phone_reads_as_offline_even_unflagged(
    till, event, ticket, checkin_list
):
    # How an app older than this one sent its queue: with the moment of the
    # scan, and nothing else to say it had been offline.
    position = sold_online(event, ticket, 1)[0]
    scanned_at = max(now() - timedelta(minutes=20), start_of_business_day(event))
    redeem(till, checkin_list, position.secret, datetime=scanned_at.isoformat(), nonce="old")
    Checkin.objects.filter(position=position).update(created=scanned_at + timedelta(minutes=15))

    assert scans(till, checkin_list)["device"]["offline"] == 1


@pytest.mark.django_db
def test_a_refusal_given_offline_is_written_down_once_sent(till, event, ticket, checkin_list):
    position = sold_online(event, ticket, 1)[0]
    at = now() - timedelta(minutes=5)

    first = refused_offline(till, checkin_list, position.secret, "invalid", at, "refusal-1")
    again = refused_offline(till, checkin_list, position.secret, "invalid", at, "refusal-1")

    # The profile lets it through, and pretix files it against the ticket it
    # names, under this device, marked as offline — once, however often sent.
    assert first.status_code == 201
    assert again.status_code == 201
    checkin = Checkin.all.get(position=position)
    assert checkin.successful is False
    assert checkin.force_sent is True
    assert checkin.device == till.device
    assert scans(till, checkin_list)["device"]["refused"] == 1


@pytest.mark.django_db
def test_a_ticket_sold_at_the_till_is_not_marked_as_an_offline_scan(
    till, event, ticket, checkin_list
):
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    # It used to be forced, and pretix shows every forced check-in as an
    # offline scan: every ticket sold at the door looked like one.
    checkin = Checkin.objects.get(position__order__code=body["order"]["code"])
    assert checkin.force_sent is False
    assert checkin.forced is False


@pytest.mark.django_db
def test_a_sale_the_list_would_refuse_still_walks_in_and_says_it_was_overridden(
    till, event, ticket, checkin_list
):
    # A list that takes no product at all: pretix refuses the plain check-in.
    checkin_list.all_products = False
    checkin_list.save()
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    # The customer has paid and is standing there, so in they go — and the
    # row says it took an override, which is the truth.
    assert body["checked_in"] == 1
    checkin = Checkin.objects.get(position__order__code=body["order"]["code"])
    assert checkin.forced is True


@pytest.mark.django_db
def test_a_ticket_sold_offline_walks_in_when_it_was_sold(till, event, ticket, checkin_list):
    event.settings.set("openpos_checkin_list", checkin_list.pk)
    sold_at = now() - timedelta(hours=1)

    body = sell(
        till,
        [{"item": ticket.pk, "count": 1, "price": "10.00"}],
        idempotency_key="sold-offline-1",
        offline={"recorded_at": sold_at.isoformat(), "charged_total": "10.00"},
    ).json()

    checkin = Checkin.objects.get(position__order__code=body["order"]["code"])
    # Not an hour later, when the till found the network again: the arrivals
    # chart would put this person in the wrong hour.
    assert abs(checkin.datetime - sold_at) < timedelta(seconds=1)
    assert checkin.force_sent is True


@pytest.mark.django_db
def test_a_replay_that_finishes_an_offline_sale_s_check_in_dates_it_too(
    till, event, ticket, checkin_list
):
    sold_at = now() - timedelta(hours=1)
    offline = {"recorded_at": sold_at.isoformat(), "charged_total": "10.00"}
    lines = [{"item": ticket.pk, "count": 1, "price": "10.00"}]
    # The first attempt committed the order with no list configured, standing
    # in for a connection that died before the check-in.
    body = sell(till, lines, idempotency_key="sold-offline-2", offline=offline).json()
    event.settings.set("openpos_checkin_list", checkin_list.pk)

    sell(till, lines, idempotency_key="sold-offline-2", offline=offline)

    order = Order.objects.get(code=body["order"]["code"])
    checkin = Checkin.objects.get(position__order=order)
    assert abs(checkin.datetime - sold_at) < timedelta(seconds=1)
    assert order.total == Decimal("10.00")
