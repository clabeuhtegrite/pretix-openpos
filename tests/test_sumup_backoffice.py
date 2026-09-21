"""
The two screens an organizer sets a card reader up from.

They are deliberately separate, and both are checked here: the SumUp screen is
about the account and the readers paired to it, the device screen is about
which till drives which one. The rules worth having tests are the ones that
would otherwise be found out at a bar: a reader given to two tills, a reader
given to the door, an API key in a log, and a SumUp outage closing the very
page an organizer came to in order to fix it.
"""
import pytest

from pretix_openpos.models import PosDevice

from .sumup_stub import FakeResponse


def sumup_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/sumup/"


def devices_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/devices/"


# -- the account ------------------------------------------------------------


@pytest.mark.django_db
def test_the_screen_asks_for_the_credentials_before_anything_else(backoffice, organizer):
    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "openpos_sumup_merchant_code" in page
    assert "openpos_sumup_api_key" in page


@pytest.mark.django_db
def test_saving_the_credentials_stores_them(backoffice, organizer):
    backoffice.post(
        sumup_url(organizer),
        {
            "action": "settings",
            "openpos_sumup_merchant_code": "MERCH1",
            "openpos_sumup_api_key": "sup_sk_secret",
        },
    )

    organizer.settings.flush()
    assert organizer.settings.get("openpos_sumup_merchant_code") == "MERCH1"
    assert organizer.settings.get("openpos_sumup_api_key") == "sup_sk_secret"


@pytest.mark.django_db
def test_the_api_key_never_reaches_the_organizer_log(backoffice, organizer):
    """
    pretix' own settings view logs every changed field's *value*. One of these
    fields is an API key, and a log entry is not where it belongs.
    """
    backoffice.post(
        sumup_url(organizer),
        {
            "action": "settings",
            "openpos_sumup_merchant_code": "MERCH1",
            "openpos_sumup_api_key": "sup_sk_secret",
        },
    )

    entry = organizer.all_logentries().first()
    assert entry.action_type == "pretix_openpos.sumup.settings"
    assert "sup_sk_secret" not in entry.data
    assert "openpos_sumup_api_key" in entry.data


@pytest.mark.django_db
def test_the_stored_key_is_not_rendered_back_into_the_page(backoffice, organizer, sumup):
    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "sup_sk_test" not in page


@pytest.mark.django_db
def test_half_the_credentials_is_refused(backoffice, organizer):
    """
    Which is the state that produces a reader accepting a basket and then no
    way of asking what happened to it.
    """
    response = backoffice.post(
        sumup_url(organizer),
        {
            "action": "settings",
            "openpos_sumup_merchant_code": "MERCH1",
            "openpos_sumup_api_key": "",
        },
    )

    assert response.status_code == 200
    organizer.settings.flush()
    assert not organizer.settings.get("openpos_sumup_merchant_code")


@pytest.mark.django_db
def test_neither_credential_is_a_fine_answer(backoffice, organizer):
    """An organizer turning the integration off, or one who has not set it up."""
    response = backoffice.post(
        sumup_url(organizer),
        {"action": "settings", "openpos_sumup_merchant_code": "", "openpos_sumup_api_key": ""},
    )

    assert response.status_code == 302


# -- the readers ------------------------------------------------------------


@pytest.mark.django_db
def test_the_readers_of_the_account_are_listed(backoffice, organizer, sumup):
    sumup.add_reader("rdr_A", name="Bar", model="solo")

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "Bar" in page
    assert "rdr_A" in page


@pytest.mark.django_db
def test_a_reader_still_waiting_for_its_device_says_so(backoffice, organizer, sumup):
    """
    SumUp answers a pairing request before the physical reader acknowledges.
    Showing it as paired would have an organizer assign one that is not ready
    and then wonder why the till refuses.
    """
    sumup.add_reader("rdr_A", status="processing")

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "Waiting for the reader" in page


@pytest.mark.django_db
def test_sumup_being_down_does_not_close_the_page_that_fixes_it(
    backoffice, organizer, sumup
):
    sumup.next_response = FakeResponse(401, {"message": "revoked"})

    response = backoffice.get(sumup_url(organizer))

    assert response.status_code == 200
    assert "API key" in response.content.decode()


@pytest.mark.django_db
def test_pairing_claims_the_reader_showing_the_code(backoffice, organizer, sumup):
    backoffice.post(
        sumup_url(organizer),
        {"action": "pair", "pairing_code": "ABCDEF", "reader_name": "Entrée"},
    )

    assert [r["name"] for r in sumup.readers.values()] == ["Entrée"]
    assert organizer.all_logentries().first().action_type == "pretix_openpos.sumup.reader.paired"


@pytest.mark.django_db
def test_pairing_with_no_code_asks_for_one(backoffice, organizer, sumup):
    backoffice.post(sumup_url(organizer), {"action": "pair", "pairing_code": " "})

    assert sumup.readers == {}


@pytest.mark.django_db
def test_a_reader_sumup_will_not_pair_says_why(backoffice, organizer, sumup):
    sumup.next_response = FakeResponse(404, {"message": "expired"})

    response = backoffice.post(
        sumup_url(organizer), {"action": "pair", "pairing_code": "ABCDEF"}
    )

    assert response.status_code == 302
    assert sumup.readers == {}


@pytest.mark.django_db
def test_a_reader_that_has_not_acknowledged_yet_is_not_called_paired(
    backoffice, organizer, sumup
):
    sumup.pairing_status = "processing"

    backoffice.post(sumup_url(organizer), {"action": "pair", "pairing_code": "ABCDEF"})

    assert len(sumup.readers) == 1


@pytest.mark.django_db
def test_forgetting_a_reader_takes_it_off_the_till_it_was_given_to(
    backoffice, organizer, device, sumup
):
    """
    A till still pointing at a removed reader refuses every card payment, with
    no way for the cashier to know why.
    """
    reader_id = sumup.add_reader("rdr_A")
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id=reader_id
    )

    backoffice.post(sumup_url(organizer), {"action": "forget", "reader_id": reader_id})

    assert sumup.readers == {}
    assert PosDevice.objects.get(device=device).sumup_reader_id == ""


@pytest.mark.django_db
def test_a_reader_sumup_will_not_remove_stays_on_its_till(
    backoffice, organizer, device, sumup
):
    reader_id = sumup.add_reader("rdr_A")
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id=reader_id
    )
    sumup.next_response = FakeResponse(500, {"message": "down"})

    backoffice.post(sumup_url(organizer), {"action": "forget", "reader_id": reader_id})

    assert PosDevice.objects.get(device=device).sumup_reader_id == reader_id


@pytest.mark.django_db
def test_a_till_pointing_at_a_reader_sumup_does_not_know_is_flagged(
    backoffice, organizer, device, sumup
):
    """
    It happens when a reader is unpaired from SumUp's own dashboard. The till
    then refuses every card payment, silently as far as the cashier can tell.
    """
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id="rdr_GONE"
    )

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "rdr_GONE" in page
    assert "no longer knows about" in page


@pytest.mark.django_db
def test_the_callback_address_is_shown_when_there_is_one(
    backoffice, organizer, sumup, settings
):
    settings.SITE_URL = "https://pretix.example.org"

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "https://pretix.example.org/openpos/sumup/" in page


@pytest.mark.django_db
def test_a_plain_http_install_is_told_why_there_is_none(
    backoffice, organizer, sumup, settings
):
    settings.SITE_URL = "http://localhost:8000"

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "not served over HTTPS" in page


@pytest.mark.django_db
def test_the_screen_is_closed_to_whoever_may_not_change_devices(reader, organizer):
    assert reader.get(sumup_url(organizer)).status_code == 403


# -- giving a reader to a till ----------------------------------------------


@pytest.mark.django_db
def test_the_device_screen_offers_the_readers_of_the_account(
    backoffice, organizer, device, sumup
):
    sumup.add_reader("rdr_A", name="Bar")

    page = backoffice.get(devices_url(organizer)).content.decode()

    assert f'name="reader_{device.pk}"' in page
    assert "rdr_A" in page


@pytest.mark.django_db
def test_giving_a_reader_to_a_till_stores_it(backoffice, organizer, device, sumup):
    reader_id = sumup.add_reader("rdr_A")

    backoffice.post(
        devices_url(organizer),
        {f"role_{device.pk}": "pos", f"reader_{device.pk}": reader_id},
    )

    assert PosDevice.objects.get(device=device).sumup_reader_id == reader_id


@pytest.mark.django_db
def test_a_reader_may_only_be_given_to_a_till(backoffice, organizer, device, sumup):
    """
    The rule the whole split exists for. A door takes cards on somebody's
    phone, and a reader on it would be a reader nobody drives.
    """
    reader_id = sumup.add_reader("rdr_A")

    backoffice.post(
        devices_url(organizer),
        {f"role_{device.pk}": "door", f"reader_{device.pk}": reader_id},
    )

    assert not PosDevice.objects.exists()


@pytest.mark.django_db
def test_two_tills_cannot_share_one_reader(
    backoffice, organizer, device, another_till, sumup
):
    reader_id = sumup.add_reader("rdr_A")

    backoffice.post(
        devices_url(organizer),
        {
            f"role_{device.pk}": "pos",
            f"reader_{device.pk}": reader_id,
            f"role_{another_till.device.pk}": "pos",
            f"reader_{another_till.device.pk}": reader_id,
        },
    )

    assert not PosDevice.objects.exists()


@pytest.mark.django_db
def test_a_reader_this_organizer_does_not_have_is_refused(
    backoffice, organizer, device, sumup
):
    backoffice.post(
        devices_url(organizer),
        {f"role_{device.pk}": "pos", f"reader_{device.pk}": "rdr_SOMEBODY_ELSE"},
    )

    assert not PosDevice.objects.exists()


@pytest.mark.django_db
def test_taking_a_reader_away_clears_it(backoffice, organizer, device, sumup):
    reader_id = sumup.add_reader("rdr_A")
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id=reader_id
    )

    backoffice.post(
        devices_url(organizer), {f"role_{device.pk}": "pos", f"reader_{device.pk}": ""}
    )

    assert PosDevice.objects.get(device=device).sumup_reader_id == ""


@pytest.mark.django_db
def test_a_reader_already_assigned_survives_a_save_made_during_an_outage(
    backoffice, organizer, device, sumup
):
    """
    SumUp cannot be asked which readers exist, so the select holds only what is
    already assigned. Saving the form must not detach a working reader.
    """
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id="rdr_A"
    )
    sumup.next_response = FakeResponse(503, {"message": "down"})

    response = backoffice.post(
        devices_url(organizer),
        {f"role_{device.pk}": "pos", f"reader_{device.pk}": "rdr_A"},
    )

    assert response.status_code == 302
    assert PosDevice.objects.get(device=device).sumup_reader_id == "rdr_A"


@pytest.mark.django_db
def test_an_unknown_reader_is_still_shown_rather_than_dropped(
    backoffice, organizer, device, sumup
):
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id="rdr_GONE"
    )

    page = backoffice.get(devices_url(organizer)).content.decode()

    assert "rdr_GONE" in page
    assert "unknown to SumUp" in page


@pytest.mark.django_db
def test_the_device_screen_still_works_with_no_sumup_account_at_all(
    backoffice, organizer, device
):
    """Which is every installation until somebody sets one up."""
    response = backoffice.get(devices_url(organizer))

    assert response.status_code == 200
    assert f'name="role_{device.pk}"' in response.content.decode()


@pytest.mark.django_db
def test_sumup_being_down_does_not_stop_a_role_being_changed(
    backoffice, organizer, device, sumup
):
    sumup.next_response = FakeResponse(503, {"message": "down"})

    response = backoffice.post(devices_url(organizer), {f"role_{device.pk}": "door"})

    assert response.status_code == 302
    assert PosDevice.objects.get(device=device).role == PosDevice.ROLE_DOOR
