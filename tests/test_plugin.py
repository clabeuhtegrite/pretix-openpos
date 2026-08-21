"""
What switching the plugin on does to an event, and what it registers globally.

Most of this is one-line glue, and glue is exactly where a rename goes
unnoticed: an identifier that no longer matches orphans every sale recorded
under it, a security profile that is not registered locks every till out at
pairing, and an invoicing switch that only half applies produces an event that
disagrees with itself about whether a till sale can be credited.
"""
import pytest
from pretix.api.auth.devicesecurity import get_all_security_profiles
from pretix.base.channels import get_all_sales_channel_types

from pretix_openpos.apps import PluginApp
from pretix_openpos.channels import POS_CHANNEL
from pretix_openpos.forms import OpenPosSettingsForm
from pretix_openpos.invoicing import SETTING, pos_invoices_enabled, set_pos_invoices
from pretix_openpos.payment import CARD, CASH
from pretix_openpos.security import OpenPosSecurityProfile


@pytest.mark.django_db
def test_the_till_channel_is_registered_under_the_name_products_are_limited_to():
    # Products are limited to this channel by identifier; renaming it takes
    # every product off the till at once.
    assert POS_CHANNEL in get_all_sales_channel_types()


@pytest.mark.django_db
def test_the_channel_is_hidden_on_events_that_do_not_run_the_till():
    channel = get_all_sales_channel_types()[POS_CHANNEL]

    assert channel.required_event_plugin == "pretix_openpos"


@pytest.mark.django_db
def test_the_channel_allows_the_things_a_door_actually_does():
    channel = get_all_sales_channel_types()[POS_CHANNEL]

    # A till operator sells more in one go than a webshop customer may, works
    # in test mode, and nobody logs into an account while queueing.
    assert channel.unlimited_items_per_order is True
    assert channel.testmode_supported is True
    assert channel.customer_accounts_supported is False


@pytest.mark.django_db
def test_both_payment_methods_are_registered(event):
    providers = event.get_payment_providers()

    assert CASH in providers
    assert CARD in providers


@pytest.mark.django_db
def test_the_security_profile_a_till_pairs_under_is_registered():
    # A device created with this profile and no profile registered for it
    # cannot authenticate at all; the till never gets past pairing.
    assert OpenPosSecurityProfile.identifier in get_all_security_profiles()


@pytest.mark.django_db
def test_the_plugin_declares_the_pretix_it_needs():
    # pretix refuses to start on an incompatible version rather than failing
    # subtly later, which is the behaviour we want.
    assert PluginApp.PretixPluginMeta.compatibility.startswith("pretix>=")


@pytest.mark.django_db
def test_switching_the_plugin_on_makes_till_sales_invoiceable(event):
    # No invoice, no credit note — and a cancellation from the till would be a
    # reversal with no paper behind it.
    event.settings.delete(SETTING)

    PluginApp("pretix_openpos", __import__("pretix_openpos")).installed(event)

    assert pos_invoices_enabled(event) is True
    assert POS_CHANNEL in event.settings.get(
        "invoice_generate_sales_channels", as_type=list
    )


@pytest.mark.django_db
def test_invoicing_is_on_for_an_event_nobody_has_touched(event):
    event.settings.delete(SETTING)

    assert pos_invoices_enabled(event) is True


@pytest.mark.django_db
def test_turning_it_off_takes_the_till_channel_out_of_pretix_own_list(event):
    # Leaving it behind produces an event that half agrees with itself: the
    # plugin says no invoice, pretix' own back office says otherwise.
    set_pos_invoices(event, True)

    set_pos_invoices(event, False)

    assert pos_invoices_enabled(event) is False
    assert POS_CHANNEL not in event.settings.get(
        "invoice_generate_sales_channels", as_type=list
    )


@pytest.mark.django_db
def test_the_webshop_keeps_whatever_the_organiser_set_for_it(event):
    event.settings.set("invoice_generate_sales_channels", ["web", "resellers"])

    set_pos_invoices(event, True)

    channels = event.settings.get("invoice_generate_sales_channels", as_type=list)
    assert "web" in channels and "resellers" in channels


@pytest.mark.django_db
def test_switching_it_on_twice_does_not_list_the_channel_twice(event):
    set_pos_invoices(event, True)

    set_pos_invoices(event, True)

    channels = event.settings.get("invoice_generate_sales_channels", as_type=list)
    assert channels.count(POS_CHANNEL) == 1


@pytest.mark.django_db
def test_an_event_with_no_channel_list_starts_from_the_webshop(event):
    # pretix' own default, which must not be lost by writing ours over it.
    event.settings.delete("invoice_generate_sales_channels")

    set_pos_invoices(event, True)

    assert "web" in event.settings.get("invoice_generate_sales_channels", as_type=list)


@pytest.mark.django_db
def test_the_settings_form_offers_every_check_in_list_and_the_option_of_none(
    event, checkin_list
):
    form = OpenPosSettingsForm(obj=event)

    choices = dict(form.fields["openpos_checkin_list"].choices)
    assert "" in choices
    assert str(checkin_list.pk) in choices


@pytest.mark.django_db
def test_the_settings_form_opens_on_the_invoicing_switch_as_it_stands(event):
    set_pos_invoices(event, False)

    form = OpenPosSettingsForm(obj=event)

    assert form.fields["openpos_invoices"].initial is False


@pytest.mark.django_db
def test_saving_the_form_keeps_pretix_own_channel_list_in_step(event, checkin_list):
    form = OpenPosSettingsForm(
        obj=event,
        data={"openpos_checkin_list": str(checkin_list.pk), "openpos_invoices": "on"},
    )
    assert form.is_valid(), form.errors

    form.save()

    assert POS_CHANNEL in event.settings.get(
        "invoice_generate_sales_channels", as_type=list
    )
    assert event.settings.get("openpos_checkin_list") == str(checkin_list.pk)


@pytest.mark.django_db
def test_unticking_the_box_turns_invoicing_off(event):
    set_pos_invoices(event, True)
    form = OpenPosSettingsForm(obj=event, data={"openpos_checkin_list": ""})
    assert form.is_valid(), form.errors

    form.save()

    assert pos_invoices_enabled(event) is False
