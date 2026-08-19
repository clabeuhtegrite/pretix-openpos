"""
How many people are inside right now.

The question at a door is "how many people are in the room", not "how many
things were scanned" — which is a different number as soon as a check-in list
accepts merchandise, and pretix will dutifully record those scans.
"""
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import Checkin, Order, OrderPosition


def sold_online(event, item, count):
    order = Order.objects.create(
        event=event,
        status=Order.STATUS_PAID,
        datetime=now(),
        expires=now(),
        total=Decimal("10.00") * count,
        sales_channel=event.organizer.sales_channels.get(identifier="web"),
    )
    return [
        OrderPosition.objects.create(
            order=order, item=item, positionid=n, price=Decimal("10.00"),
            attendee_name_parts={"_scheme": "full", "full_name": f"Invité {n}"},
        )
        for n in range(1, count + 1)
    ]


def scan(position, clist, kind=Checkin.TYPE_ENTRY):
    return Checkin.objects.create(position=position, list=clist, type=kind)


@pytest.mark.django_db
def test_nobody_is_inside_before_the_doors_open(till, event, ticket, checkin_list):
    sold_online(event, ticket, 3)

    body = till.get("attendance", list=checkin_list.pk).json()

    assert body["expected"] == 3
    assert body["entered"] == 0
    assert body["inside"] == 0
    assert body["not_arrived"] == 3


@pytest.mark.django_db
def test_the_room_fills_up_as_tickets_are_scanned(till, event, ticket, checkin_list):
    positions = sold_online(event, ticket, 3)
    scan(positions[0], checkin_list)
    scan(positions[1], checkin_list)

    body = till.get("attendance", list=checkin_list.pk).json()

    assert body["entered"] == 2
    assert body["inside"] == 2
    assert body["not_arrived"] == 1


@pytest.mark.django_db
def test_somebody_scanned_back_out_is_no_longer_on_site(till, event, ticket, checkin_list):
    positions = sold_online(event, ticket, 2)
    scan(positions[0], checkin_list)
    scan(positions[1], checkin_list)
    scan(positions[0], checkin_list, Checkin.TYPE_EXIT)

    body = till.get("attendance", list=checkin_list.pk).json()

    # Everyone who was let in at least once, whether or not they have since left.
    assert body["entered"] == 2
    assert body["inside"] == 1
    assert body["exited"] == 1


@pytest.mark.django_db
def test_a_t_shirt_scanned_at_the_bar_does_not_join_the_head_count(
    till, event, ticket, beer, checkin_list
):
    people = sold_online(event, ticket, 2)
    merch = sold_online(event, beer, 3)
    scan(people[0], checkin_list)
    for position in merch:
        scan(position, checkin_list)

    body = till.get("attendance", list=checkin_list.pk).json()

    assert body["inside"] == 1
    assert body["expected"] == 2
    # Reported rather than hidden: it is the one thing that explains this figure
    # differing from the count pretix' own back office shows.
    assert body["non_admission_entered"] == 3


@pytest.mark.django_db
def test_the_breakdown_adds_up_to_the_totals(till, event, ticket, checkin_list):
    positions = sold_online(event, ticket, 4)
    scan(positions[0], checkin_list)
    scan(positions[1], checkin_list)
    scan(positions[1], checkin_list, Checkin.TYPE_EXIT)

    body = till.get("attendance", list=checkin_list.pk).json()

    assert sum(row["inside"] for row in body["items"]) == body["inside"]
    assert sum(row["entered"] for row in body["items"]) == body["entered"]
    assert sum(row["expected"] for row in body["items"]) == body["expected"]
    assert body["items"][0]["name"] == "Entrée"


@pytest.mark.django_db
def test_a_sale_at_the_till_shows_up_in_the_count(till, event, ticket, checkin_list):
    from .conftest import sell

    event.settings.set("openpos_checkin_list", checkin_list.pk)
    sell(till, [{"item": ticket.pk, "count": 2}])

    body = till.get("attendance", list=checkin_list.pk).json()

    # Counted server-side precisely because several doors and tills feed it: a
    # tally kept in one browser would only ever know about its own scans.
    assert body["inside"] == 2


@pytest.mark.django_db
def test_an_unknown_list_is_refused(till, event, ticket, checkin_list):
    assert till.get("attendance", list=checkin_list.pk + 999).status_code == 400
