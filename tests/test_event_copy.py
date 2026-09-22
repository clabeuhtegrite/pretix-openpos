"""
An event created as a copy of another keeps the till set up.

pretix copies every setting as it stands and then leaves each plugin to put its
own references right, through ``event_copy_data``. Three of the till's settings
name a row of the event by number, and "who sells what" hangs off the event's
categories. Before the plugin listened, a copied evening came up with the door
no longer checking in what it sold, the free-amount and deposit buttons gone,
and the beer back on sale at the door — all silently, since each lookup simply
found nothing and the till took that as "not set up".
"""
from datetime import timedelta

import pytest
from django.utils.timezone import now
from pretix.base.models import Event, ItemCategory

from pretix_openpos.api.views import checkin_list_for, custom_sale_item, deposit_item
from pretix_openpos.models import PosCategory, PosDevice

from .conftest import Till, sell


@pytest.fixture
def set_up(event, ticket, beer, misc, deposit, checkin_list):
    """The evening as Ad sets one up: every till setting in use."""
    event.settings.set("openpos_checkin_list", str(checkin_list.pk))
    bar = ItemCategory.objects.create(event=event, name="Bar", position=1)
    beer.category = bar
    beer.save()
    entries = ItemCategory.objects.create(event=event, name="Entrées", position=0)
    ticket.category = entries
    ticket.save()
    PosCategory.objects.create(category=bar, role=PosDevice.ROLE_TILL)
    PosCategory.objects.create(category=entries, role=PosDevice.ROLE_DOOR)
    return event


def copy_of(event, slug="soiree-2"):
    """Next week's evening, made the way pretix' wizard makes one."""
    copy = Event.objects.create(
        organizer=event.organizer,
        name="Soirée suivante",
        slug=slug,
        date_from=now() + timedelta(days=8),
        live=True,
        currency="EUR",
    )
    copy.copy_data_from(event)
    copy.refresh_from_db()
    return copy


@pytest.mark.django_db
def test_the_copy_checks_in_on_its_own_list(set_up):
    copy = copy_of(set_up)

    clist = checkin_list_for(copy)
    assert clist is not None
    assert clist.event == copy
    assert clist.name == "Porte"


@pytest.mark.django_db
def test_the_copy_keeps_its_free_amount_and_deposit_buttons(set_up):
    copy = copy_of(set_up)

    custom = custom_sale_item(copy)
    cup = deposit_item(copy)
    assert custom is not None and custom.event == copy and str(custom.name) == "Divers"
    assert cup is not None and cup.event == copy and str(cup.name) == "Consigne gobelet"


@pytest.mark.django_db
def test_the_copy_keeps_who_sells_what(set_up):
    copy = copy_of(set_up)

    roles = {
        str(row.category.name): row.role
        for row in PosCategory.objects.filter(category__event=copy)
    }
    assert roles == {"Bar": PosDevice.ROLE_TILL, "Entrées": PosDevice.ROLE_DOOR}
    # And the original is left exactly as it was.
    assert PosCategory.objects.filter(category__event=set_up).count() == 2


@pytest.mark.django_db
def test_a_ticket_sold_at_the_copied_door_walks_straight_in(set_up, device):
    """The one that costs the most, seen from the till: the door checks in again."""
    copy = copy_of(set_up)
    ticket = copy.items.get(name="Entrée")

    response = sell(Till(device, copy), [{"item": ticket.pk, "count": 1}])

    assert response.status_code == 201, response.content
    assert response.json()["checked_in"] == 1


@pytest.mark.django_db
def test_the_copied_till_is_offered_both_buttons(set_up, device):
    copy = copy_of(set_up)

    config = Till(device, copy).get("config").json()

    assert config["custom_sale"]["enabled"] is True
    assert config["deposit"]["enabled"] is True
    assert config["checkin"]["list_id"] == checkin_list_for(copy).pk


@pytest.mark.django_db
def test_a_setting_naming_a_deleted_row_is_not_carried_over(event, ticket):
    """
    Dead on the original already: nothing on either side answers to it, so the
    copy starts clean rather than with a number that means nothing.
    """
    event.settings.set("openpos_deposit_item", "999999")

    copy = copy_of(event)

    assert copy.settings.get("openpos_deposit_item") is None
    assert deposit_item(copy) is None


@pytest.mark.django_db
def test_an_evening_set_up_with_nothing_copies_nothing(event, ticket):
    copy = copy_of(event)

    assert checkin_list_for(copy) is None
    assert custom_sale_item(copy) is None
    assert deposit_item(copy) is None
    assert not PosCategory.objects.filter(category__event=copy).exists()


@pytest.mark.django_db
def test_a_category_sold_everywhere_needs_no_row_in_the_copy(event, beer):
    bar = ItemCategory.objects.create(event=event, name="Bar")
    beer.category = bar
    beer.save()
    PosCategory.objects.create(category=bar, role=PosCategory.ROLE_ALL)

    copy = copy_of(event)

    assert not PosCategory.objects.filter(category__event=copy).exists()


@pytest.mark.django_db
def test_a_setting_the_new_event_already_had_is_its_own(set_up):
    """
    pretix does not overwrite a setting the new event already carries, and a
    value of the new event's own is not the old event's to translate.
    """
    copy = Event.objects.create(
        organizer=set_up.organizer,
        name="Soirée suivante",
        slug="soiree-2",
        date_from=now() + timedelta(days=8),
        live=True,
        currency="EUR",
    )
    own = copy.checkin_lists.create(name="Porte B", all_products=True)
    copy.settings.set("openpos_checkin_list", str(own.pk))

    copy.copy_data_from(set_up)

    assert checkin_list_for(copy) == own


@pytest.mark.django_db
def test_an_event_without_the_plugin_is_left_alone(organizer, event, misc):
    """The signal only reaches plugins switched on for the event being made."""
    event.plugins = ""
    event.save()

    copy = copy_of(event)

    # Copied verbatim by pretix, and not translated: nothing asked for it.
    assert copy.settings.get("openpos_custom_item") == str(misc.pk)
