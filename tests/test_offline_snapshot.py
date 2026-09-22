"""
The guest list a till carries so a dropout does not close the door.

The endpoint is the one place in the plugin where the work is proportional to
the size of the event — up to twenty thousand tickets in one answer — so the
tests here are as much about *how* it reads them as about what it says.
"""
from datetime import timedelta
from decimal import Decimal

import pytest
from django.db import connection
from django.test.utils import CaptureQueriesContext
from django.utils.dateparse import parse_datetime
from django.utils.timezone import now
from pretix.base.models import Checkin, Order, OrderPosition

from pretix_openpos.api.views import OFFLINE_SNAPSHOT_LIMIT


def admit(event, item, names):
    """One paid order holding a ticket per name, as sold online."""
    order = Order.objects.create(
        event=event,
        status=Order.STATUS_PAID,
        datetime=now(),
        expires=now(),
        total=Decimal("10.00") * len(names),
        sales_channel=event.organizer.sales_channels.get(identifier="web"),
    )
    positions = []
    for index, name in enumerate(names, start=1):
        positions.append(
            OrderPosition.objects.create(
                order=order,
                item=item,
                positionid=index,
                price=Decimal("10.00"),
                attendee_name_parts={"_scheme": "full", "full_name": name},
            )
        )
    return order, positions


@pytest.mark.django_db
def test_the_snapshot_names_every_ticket_on_the_list(till, event, ticket, checkin_list):
    admit(event, ticket, ["Alice Martin", "Bob Durand"])

    body = till.get("offline", list=checkin_list.pk).json()

    assert body["list"] == {"id": checkin_list.pk, "name": "Porte"}
    assert {t["name"] for t in body["tickets"]} == {"Alice Martin", "Bob Durand"}
    assert all(t["item"] == ticket.pk for t in body["tickets"])
    assert all(len(t["secret"]) > 8 for t in body["tickets"])
    assert body["truncated"] is False


@pytest.mark.django_db
def test_a_ticket_already_scanned_is_marked_used(till, event, ticket, checkin_list):
    _order, positions = admit(event, ticket, ["Alice Martin", "Bob Durand"])
    Checkin.objects.create(
        position=positions[0], list=checkin_list, type=Checkin.TYPE_ENTRY
    )

    tickets = {t["name"]: t for t in till.get("offline", list=checkin_list.pk).json()["tickets"]}

    # So the second scan of the same ticket is refused at the door rather than
    # discovered hours later at reconciliation.
    assert tickets["Alice Martin"]["used"] is True
    assert tickets["Bob Durand"]["used"] is False


@pytest.mark.django_db
def test_an_exit_scan_does_not_mark_a_ticket_used(till, event, ticket, checkin_list):
    _order, positions = admit(event, ticket, ["Alice Martin"])
    Checkin.objects.create(
        position=positions[0], list=checkin_list, type=Checkin.TYPE_EXIT
    )

    tickets = till.get("offline", list=checkin_list.pk).json()["tickets"]

    # Someone who stepped outside for a cigarette has to be able to come back in.
    assert tickets[0]["used"] is False


@pytest.mark.django_db
def test_a_blocked_ticket_says_so(till, event, ticket, checkin_list):
    _order, positions = admit(event, ticket, ["Alice Martin", "Bob Durand"])
    OrderPosition.objects.filter(pk=positions[0].pk).update(blocked=["admin"])

    tickets = {t["name"]: t for t in till.get("offline", list=checkin_list.pk).json()["tickets"]}

    # pretix refuses it at the door. With no network it used to walk in: the
    # guest list said nothing about it.
    assert tickets["Alice Martin"]["blocked"] is True
    # An ordinary ticket carries nothing more than it did.
    assert set(tickets["Bob Durand"]) == {"secret", "item", "name", "used"}


@pytest.mark.django_db
def test_a_ticket_valid_for_a_while_carries_its_window(till, event, ticket, checkin_list):
    _order, positions = admit(event, ticket, ["Alice Martin"])
    opens, closes = now() + timedelta(hours=1), now() + timedelta(hours=5)
    OrderPosition.objects.filter(pk=positions[0].pk).update(valid_from=opens, valid_until=closes)

    carried = till.get("offline", list=checkin_list.pk).json()["tickets"][0]

    # The moments rather than a verdict: the app checks them when the ticket
    # is scanned, which may well be after it has become valid.
    assert parse_datetime(carried["valid_from"]) == opens
    assert parse_datetime(carried["valid_until"]) == closes
    assert "blocked" not in carried


@pytest.mark.django_db
def test_reading_the_guest_list_costs_the_same_whatever_its_size(
    till, event, ticket, checkin_list, django_assert_num_queries
):
    """
    The regression this file exists for.

    ``attendee_name`` is a property that reads ``attendee_name_parts`` and, if
    that carries no name scheme, the event's settings — neither of which the
    query fetches. Reading it per row turned one query into two per ticket:
    forty thousand of them for a full guest list, every five minutes, per
    tablet. Nothing about the answer changed, which is exactly why it needs a
    test that counts queries rather than one that compares JSON.
    """
    admit(event, ticket, ["Solo Ticket"])
    with CaptureQueriesContext(connection) as one_ticket:
        assert till.get("offline", list=checkin_list.pk).status_code == 200

    admit(event, ticket, [f"Guest {n}" for n in range(40)])
    with django_assert_num_queries(len(one_ticket.captured_queries)):
        body = till.get("offline", list=checkin_list.pk).json()

    assert len(body["tickets"]) == 41


@pytest.mark.django_db
def test_the_snapshot_says_so_when_it_had_to_stop(
    till, event, ticket, checkin_list, monkeypatch
):
    monkeypatch.setattr("pretix_openpos.api.views.OFFLINE_SNAPSHOT_LIMIT", 2)
    admit(event, ticket, ["A", "B", "C"])

    body = till.get("offline", list=checkin_list.pk).json()

    # An event too big to carry says so, rather than letting a till believe it
    # holds the whole guest list.
    assert len(body["tickets"]) == 2
    assert body["truncated"] is True


@pytest.mark.django_db
def test_the_limit_is_high_enough_to_be_worth_having():
    # Named here so that lowering it is a deliberate act with a test to answer
    # to: the doors this runs at sell in the hundreds.
    assert OFFLINE_SNAPSHOT_LIMIT >= 10000


@pytest.mark.django_db
def test_an_unknown_list_is_refused_rather_than_answered_with_another(
    till, event, ticket, checkin_list
):
    admit(event, ticket, ["Alice Martin"])

    response = till.get("offline", list=checkin_list.pk + 999)

    # A door count is only worth something if the operator knows which door it
    # counts; falling back to another list would be worse than refusing.
    assert response.status_code == 400


@pytest.mark.django_db
def test_a_ticket_on_another_list_is_not_in_this_one(till, event, ticket, beer, checkin_list):
    other = event.checkin_lists.create(name="Bar", all_products=False)
    other.limit_products.add(beer)
    admit(event, ticket, ["Alice Martin"])

    assert till.get("offline", list=other.pk).json()["tickets"] == []
    assert len(till.get("offline", list=checkin_list.pk).json()["tickets"]) == 1
