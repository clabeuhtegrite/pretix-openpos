"""
What pretix' history says the plugin did.

Every one of these entries used to render as its raw action type —
``pretix_openpos.prices.changed`` on a line of its own — with the data it
carried not shown at all. Two of them carried nothing worth showing anyway: a
count. "6 products were changed" answers none of the questions the history is
opened for, and the answer cannot be recovered afterwards, because by the time
anyone asks, the price list has moved on again.

So these tests check both halves: that what changed is written down, and that
it comes back out as a sentence. They go through the real screens rather than
calling ``log_action`` directly — a payload nobody writes is not worth
rendering, and the pairing of the two is the thing that breaks.
"""
from decimal import Decimal

import pytest

from pretix_openpos.models import PosDevice

from .conftest import sell


def devices_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/devices/"


def sumup_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/sumup/"


def latest(obj, action_type):
    return obj.all_logentries().filter(action_type=action_type).latest("datetime")


# -- the price list that no longer exists ---------------------------------
#
# The screen these were written from is gone: a product is worth what pretix
# says it is worth, at the door as in the shop. The entries are not gone. They
# sit in the history of every installation that ran an earlier version, and
# whoever reads that history a year from now is owed a sentence rather than an
# identifier. So they are written here by hand, which is also exactly how they
# now reach the renderer: out of the database, with no form behind them.

def price_change(event, changed):
    event.log_action("pretix_openpos.prices.changed", data={"changed": changed})
    return latest(event, "pretix_openpos.prices.changed")


def moved(item, name, before, after, variation=None, variation_name=None):
    return {
        "item": item.pk, "item_name": name,
        "variation": variation.pk if variation else None,
        "variation_name": variation_name,
        "from": before, "to": after,
    }


@pytest.mark.django_db
def test_a_price_change_says_which_price_and_from_what(event, ticket):
    entry = price_change(event, [moved(ticket, "Entrée", "10.00", "8.50")])

    shown = entry.display()
    assert "Entrée" in shown
    assert "10.00" in shown and "8.50" in shown
    # And never the bare identifier, which is what it rendered as before.
    assert "pretix_openpos" not in shown


@pytest.mark.django_db
def test_a_first_on_site_price_reads_as_one_rather_than_a_change(event, ticket):
    entry = price_change(event, [moved(ticket, "Entrée", None, "8.50")])

    # "None → 8.50" would be the lazy rendering of this and reads as a bug.
    assert "8.50" in entry.display()
    assert "None" not in entry.display()


@pytest.mark.django_db
def test_removing_an_on_site_price_says_the_normal_one_applies_again(event, ticket):
    entry = price_change(event, [moved(ticket, "Entrée", "10.00", None)])

    assert "10.00" in entry.display()


@pytest.mark.django_db
def test_a_variation_is_named_by_its_option_not_just_its_product(event, shirt):
    item, small, _large = shirt

    entry = price_change(event, [
        moved(item, str(item.name), None, "15.00",
              variation=small, variation_name=str(small.value)),
    ])

    # Two options of one product move independently, so the product name alone
    # would name the wrong thing half the time.
    assert str(small.value) in entry.display()


@pytest.mark.django_db
def test_a_save_that_moved_nothing_says_so(event):
    """Opening the screen and pressing Save wrote one of these every time."""
    shown = price_change(event, []).display()

    assert "nothing changed" in shown
    assert "pretix_openpos" not in shown


@pytest.mark.django_db
def test_a_product_deleted_since_is_named_as_one(event):
    """
    A season later the item is gone and the entry is all that is left. It has
    to read as a line about a product, not as a blank.
    """
    event.log_action("pretix_openpos.prices.changed", data={"changed": [
        {"item": 4242, "variation": None, "from": "3.00", "to": "3.50"},
    ]})

    shown = latest(event, "pretix_openpos.prices.changed").display()

    assert "deleted product" in shown
    assert "3.00" in shown and "3.50" in shown


@pytest.mark.django_db
def test_an_entry_written_before_the_detail_existed_still_renders(event):
    """
    Real rows in a real installation carry ``{"changed": 6}``. Nothing can
    recover what those six were, so the line says the true, smaller thing
    rather than rendering "?" six times or raising.
    """
    event.log_action("pretix_openpos.prices.changed", data={"changed": 6})

    shown = latest(event, "pretix_openpos.prices.changed").display()

    assert "6" in shown
    assert "pretix_openpos" not in shown


@pytest.mark.django_db
def test_a_device_role_change_names_the_device_and_both_roles(
    backoffice, organizer, device, another_till
):
    backoffice.post(devices_url(organizer), {
        f"role_{device.pk}": PosDevice.ROLE_TILL,
        f"role_{another_till.device.pk}": PosDevice.ROLE_DOOR,
    })

    entry = latest(organizer, "pretix_openpos.devices.changed")
    rows = {row["device"]: row for row in entry.parsed_data["changed"]}
    assert rows[device.pk]["role"] == PosDevice.ROLE_TILL
    assert rows[device.pk]["role_before"] == PosDevice.ROLE_UNSET

    shown = entry.display()
    assert device.name in shown and another_till.device.name in shown
    assert "pretix_openpos" not in shown


@pytest.mark.django_db
def test_moving_a_reader_between_tills_is_readable(
    backoffice, organizer, device, another_till, reader_till, sumup
):
    reader = sumup.add_reader("rdr_TWO", name="Bar")

    backoffice.post(devices_url(organizer), {
        f"role_{device.pk}": PosDevice.ROLE_TILL,
        f"reader_{device.pk}": "",
        f"role_{another_till.device.pk}": PosDevice.ROLE_TILL,
        f"reader_{another_till.device.pk}": reader,
    })

    shown = latest(organizer, "pretix_openpos.devices.changed").display()

    # The question this gets opened for is "why has this till stopped taking
    # cards", an hour after someone moved the reader to the other tablet.
    assert reader in shown
    assert another_till.device.name in shown


@pytest.mark.django_db
def test_the_sumup_settings_entry_names_the_fields_and_never_the_key(
    backoffice, organizer
):
    backoffice.post(sumup_url(organizer), {
        "action": "settings",
        "openpos_sumup_merchant_code": "MERCH1",
        "openpos_sumup_api_key": "sup_sk_dontwriteme",
    })

    entry = latest(organizer, "pretix_openpos.sumup.settings")
    shown = entry.display()

    assert "dontwriteme" not in shown
    assert "dontwriteme" not in str(entry.parsed_data)
    assert "pretix_openpos" not in shown


@pytest.mark.django_db
def test_clearing_a_reader_says_what_it_does_and_does_not_prove(
    backoffice, organizer, sumup
):
    reader = sumup.add_reader("rdr_ONE")

    backoffice.post(sumup_url(organizer), {"action": "free", "reader_id": reader})

    shown = latest(organizer, "pretix_openpos.sumup.reader.freed").display()

    assert reader in shown
    # The one thing this entry must not let anyone conclude.
    assert "SumUp" in shown


# -- the history pages themselves -------------------------------------------
#
# Everything above renders an entry by calling display() on it. The page an
# organiser actually opens asks pretix a second question about every line —
# which object it is about — and for an entry an event-level plugin registered
# and then wrote on the organizer, pretix answers that by raising. Every entry
# above rendered, and the organizer's history was a 500 from 0.12.0 to 0.15.1.
#
# So the pages are rendered here, whole, with the entries on them.

def organizer_history(client, organizer):
    return client.get(f"/control/organizer/{organizer.slug}/logs")


@pytest.mark.django_db
def test_the_organizer_history_opens_with_every_kind_of_entry_on_it(
    backoffice, organizer, device, sumup, till
):
    from pretix_openpos.logdisplay import organizer_entry_types
    from pretix_openpos.models import PosDrawer

    # An evening of setting up, through the real screens: a new key for the
    # account, a reader paired, given to a till, cleared and then removed.
    backoffice.post(sumup_url(organizer), {
        "action": "settings",
        "openpos_sumup_merchant_code": sumup.merchant,
        "openpos_sumup_api_key": "sup_sk_rotated",
    })
    backoffice.post(sumup_url(organizer), {
        "action": "pair", "pairing_code": "ABCDEF", "reader_name": "Porte",
    })
    (reader,) = sumup.readers
    backoffice.post(devices_url(organizer), {
        f"role_{device.pk}": PosDevice.ROLE_TILL,
        f"reader_{device.pk}": reader,
    })
    backoffice.post(sumup_url(organizer), {"action": "free", "reader_id": reader})
    backoffice.post(sumup_url(organizer), {"action": "forget", "reader_id": reader})
    # And the drawers: one created, renamed, given to the till, opened there
    # and closed from the back office; another created and deleted.
    drawers = f"/control/organizer/{organizer.slug}/openpos/drawers/"
    backoffice.post(drawers, {"action": "create", "new-name": "Bar", "new-opening_float": "100"})
    backoffice.post(drawers, {"action": "create", "new-name": "Vestiaire"})
    bar = PosDrawer.objects.get(name="Bar")
    backoffice.post(drawers, {
        "action": "save", "drawer": bar.pk,
        f"d{bar.pk}-name": "Bar du haut", f"d{bar.pk}-opening_float": "100",
    })
    backoffice.post(drawers, {
        "action": "delete", "drawer": PosDrawer.objects.get(name="Vestiaire").pk,
    })
    backoffice.post(devices_url(organizer), {
        f"role_{device.pk}": PosDevice.ROLE_TILL, f"drawer_{device.pk}": bar.pk,
    })
    till.post("drawer/open", {"idempotency_key": "open-00001", "amount": "100.00"})
    backoffice.post(f"{drawers}{bar.pk}/{bar.sessions.get().pk}/", {"amount": ""})
    # One of every kind the plugin writes on the organizer, or this proves less
    # than its name says.
    written = set(
        organizer.all_logentries().filter(event=None).values_list("action_type", flat=True)
    )
    assert set(organizer_entry_types) <= written

    response = organizer_history(backoffice, organizer)

    assert response.status_code == 200
    page = response.content.decode()
    assert "The SumUp account was changed: API key." in page
    assert f"A card reader was paired: {reader}" in page
    # Down to the line, since the device's name is on this page anyway, in the
    # filter's list of devices.
    assert f"{device.name}: no role → till, card reader {reader}" in page
    assert f"A card reader was asked to clear its screen: {reader}." in page
    assert f"A card reader was removed: {reader}" in page
    assert "A cash drawer was created: Bar, usual float" in page
    assert "A cash drawer was created: Vestiaire." in page
    assert "The cash drawer Bar du haut was changed: renamed from Bar." in page
    assert "The cash drawer Vestiaire was deleted." in page
    assert f"{device.name}: cash drawer Bar du haut" in page
    assert "The cash drawer Bar du haut was closed from the back office, without a count." in page
    for action_type in organizer_entry_types:
        assert action_type not in page
    # The key itself, which is the other thing this page must never show.
    assert "sup_sk_rotated" not in page


@pytest.mark.django_db
def test_an_organizer_entry_points_at_nothing_rather_than_raising(
    backoffice, organizer, device
):
    """
    The column the page crashed on, asked directly.

    Not in pretix' registry, the entry takes the old road to its object: the
    organizer it was written on, and a signal nobody answers for one. An empty
    column is the right answer — the page is the organizer's own history.
    """
    backoffice.post(devices_url(organizer), {f"role_{device.pk}": PosDevice.ROLE_TILL})

    entry = latest(organizer, "pretix_openpos.devices.changed")

    assert entry.display_object == ""


@pytest.mark.django_db
def test_the_event_history_still_opens_with_the_plugin_s_entries_on_it(
    backoffice, event, ticket
):
    # The other road: entries written on an event stay in pretix' registry,
    # where the plugin can be checked against the event they were written on.
    price_change(event, [moved(ticket, "Entrée", "10.00", "8.50")])

    response = backoffice.get(f"/control/event/{event.organizer.slug}/{event.slug}/logs/")

    assert response.status_code == 200
    assert "The on-site prices were changed:" in response.content.decode()


@pytest.mark.django_db
def test_an_ordinary_sale_writes_no_off_tariff_entry(till, ticket, event):
    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    from pretix.base.models import Order

    order = Order.objects.get(code=body["order"]["code"])
    assert not order.all_logentries().filter(
        action_type="pretix_openpos.order.off_tariff"
    ).exists()


# -- the upgrade that took the price list away ----------------------------
#
# Migration 0008 drops the table, and nothing can bring those rows back. What
# it writes on the way out is the only copy, and it goes into the event's own
# history rather than the container's startup log, because that is where the
# person who wants it can actually reach it.
#
# The migration is driven directly here, with a stand-in for the table it
# reads. It has to be: the unit suite builds its schema from the models, and
# PosPrice is not a model any more — which is the whole point of the migration
# and the reason this cannot be done by creating rows.

class FakeRow:
    """One row of the table as the migration sees it, through ``select_related``."""

    def __init__(self, event, item, price, variation=None):
        self.event = event
        self.item = item
        self.item_id = item.pk
        self.variation = variation
        self.variation_id = variation.pk if variation else None
        self.price = price


class FakeRows(list):
    def select_related(self, *args):
        return self

    def order_by(self, *args):
        return self


class FakeApps:
    """
    ``apps`` as a ``RunPython`` gets it, with one model replaced.

    Everything but PosPrice resolves to the real model, so the LogEntry this
    writes is a real LogEntry, looked up afterwards through the same call the
    control panel uses.
    """

    def __init__(self, rows):
        self._rows = FakeRows(rows)

    def get_model(self, app_label, model_name):
        if (app_label, model_name) == ("pretix_openpos", "PosPrice"):
            return type("PosPrice", (), {"objects": self._rows})
        from django.apps import apps as installed

        return installed.get_model(app_label, model_name)


def drop_prices(rows):
    """Run the migration's own function over ``rows``, as ``RunPython`` would."""
    import importlib

    # By name through importlib: "0008_..." is not an identifier, so there is
    # no import statement that reaches this module.
    migration = importlib.import_module(
        "pretix_openpos.migrations.0008_remove_on_site_prices"
    )
    migration.say_what_is_being_dropped(FakeApps(rows), None)


def removal(event):
    return latest(event, "pretix_openpos.prices.removed")


@pytest.mark.django_db
def test_a_price_that_moves_is_named_with_both_figures(event, beer):
    # Beer was 2.50 at the bar and is 3.00 in pretix, so the till's figure
    # changes the moment this migration runs. That is the one thing the entry
    # exists to say.
    drop_prices([FakeRow(event, beer, Decimal("2.50"))])

    shown = removal(event).display()

    assert "Bière" in shown
    assert "2.50" in shown and "3.00" in shown
    assert "1" in shown


@pytest.mark.django_db
def test_a_price_that_does_not_move_is_counted_not_listed(event, beer, ticket):
    # One product moves, one was already worth its pretix price. A list of
    # products that stayed put is a haystack, so only the mover is named.
    drop_prices([
        FakeRow(event, beer, Decimal("2.50")),
        FakeRow(event, ticket, Decimal("10.00")),
    ])

    shown = removal(event).display()

    assert "Bière" in shown
    assert "Entrée" not in shown


@pytest.mark.django_db
def test_nothing_moving_says_so_rather_than_listing_nothing(event, beer):
    drop_prices([FakeRow(event, beer, Decimal("3.00"))])

    shown = removal(event).display()

    assert "None of them changed price" in shown


@pytest.mark.django_db
def test_a_variation_is_named_by_its_own_value(event, shirt):
    # The variation carries its own default price (18), so naming the item's
    # (15) would report the wrong replacement as well as the wrong name.
    item, _small, large = shirt
    drop_prices([FakeRow(event, item, Decimal("16.00"), variation=large)])

    shown = removal(event).display()

    assert "T-shirt" in shown and "L" in shown
    assert "16.00" in shown and "18.00" in shown


@pytest.mark.django_db
def test_each_event_gets_its_own_entry(event, organizer, beer):
    from pretix.base.models import Event, Item

    other = Event.objects.create(
        organizer=organizer, name="Autre", slug="autre",
        date_from=event.date_from, plugins="pretix_openpos", currency="EUR",
    )
    other_beer = Item.objects.create(event=other, name="Bière", default_price=4)

    drop_prices([
        FakeRow(event, beer, Decimal("2.50")),
        FakeRow(other, other_beer, Decimal("2.50")),
    ])

    # Two entries, each on its own event, each carrying only its own rows.
    assert "3.00" in removal(event).display()
    assert "4.00" in removal(other).display()


@pytest.mark.django_db
def test_an_empty_table_writes_no_entry_at_all(event):
    drop_prices([])

    assert not event.all_logentries().filter(
        action_type="pretix_openpos.prices.removed"
    ).exists()


@pytest.mark.django_db
def test_a_history_that_cannot_be_written_does_not_fail_the_upgrade(
    event, beer, monkeypatch
):
    """
    The entry is worth having. It is not worth a deployment.

    An upgrade that dies here leaves the ticketing down for as long as it takes
    somebody to work out why, and the list is already in the migration's own
    output by the time this runs.
    """
    import importlib

    migration = importlib.import_module(
        "pretix_openpos.migrations.0008_remove_on_site_prices"
    )

    def explode(*args, **kwargs):
        raise RuntimeError("this pretix keeps its history somewhere else")

    monkeypatch.setattr(migration, "_write_history", explode)

    migration.say_what_is_being_dropped(
        FakeApps([FakeRow(event, beer, Decimal("2.50"))]), None
    )

    assert not event.all_logentries().filter(
        action_type="pretix_openpos.prices.removed"
    ).exists()
