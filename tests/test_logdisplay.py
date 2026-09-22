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


@pytest.mark.django_db
def test_an_ordinary_sale_writes_no_off_tariff_entry(till, ticket, event):
    body = sell(till, [{"item": ticket.pk, "count": 1}]).json()

    from pretix.base.models import Order

    order = Order.objects.get(code=body["order"]["code"])
    assert not order.all_logentries().filter(
        action_type="pretix_openpos.order.off_tariff"
    ).exists()
