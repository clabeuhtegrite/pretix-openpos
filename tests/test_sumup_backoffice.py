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
def test_a_reader_says_what_it_is_doing_right_now(backoffice, organizer, sumup):
    """
    The question an organizer actually has before a door opens: is the thing
    on, and is it charged. Pairing answers neither — a reader can be paired,
    flat, and in a drawer.
    """
    sumup.set_state(sumup.add_reader("rdr_A"), "IDLE", battery_level=64)

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "Ready" in page
    assert "64" in page
    assert "3.3.39.0" in page


@pytest.mark.django_db
def test_the_battery_is_read_out_in_whole_percent(backoffice, organizer, sumup):
    # SumUp sends a float. "72.5%" is a precision nobody at a counter wants.
    sumup.set_state(sumup.add_reader("rdr_A"), "IDLE", battery_level=72.4)

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "72.4" not in page
    assert "Battery 72%" in page


@pytest.mark.django_db
def test_a_reader_updating_itself_is_not_ready(backoffice, organizer, sumup):
    sumup.set_state(sumup.add_reader("rdr_A"), "UPDATING_FIRMWARE")

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "Updating itself" in page
    assert ">Ready<" not in page


@pytest.mark.django_db
def test_a_reader_with_a_card_waiting_on_it_is_not_ready(backoffice, organizer, sumup):
    sumup.set_state(sumup.add_reader("rdr_A"), "WAITING_FOR_CARD")

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "Taking a payment" in page
    # And the way out of it is offered on the row itself.
    assert 'value="free"' in page


@pytest.mark.django_db
def test_a_reader_that_is_off_says_so(backoffice, organizer, sumup):
    sumup.set_state(sumup.add_reader("rdr_A"), "IDLE", status="OFFLINE")

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "Offline" in page
    # Nothing is waiting on a reader that is not there, so no button offers to
    # clear it. (The paragraph explaining the button is always on the page.)
    assert 'value="free"' not in page


@pytest.mark.django_db
def test_a_reader_too_old_to_be_asked_is_unknown_rather_than_off(
    backoffice, organizer, sumup
):
    """
    The status endpoint wants firmware 3.3.39.0 on a Solo; taking payments
    wants 3.3.24.3. A reader in between works perfectly and cannot answer this
    question, so drawing it as offline would send somebody to look for a reader
    that is sitting there working.
    """
    sumup.add_reader("rdr_A")

    page = backoffice.get(sumup_url(organizer)).content.decode()

    assert "Unknown" in page
    assert "Offline" not in page


@pytest.mark.django_db
def test_a_reader_still_pairing_is_not_asked_at_all(backoffice, organizer, sumup):
    # One HTTP call per reader, on a page load. A reader that has not finished
    # acknowledging its pairing has nothing to say and is not worth the wait.
    sumup.add_reader("rdr_A", status="processing")

    backoffice.get(sumup_url(organizer))

    assert not [path for path in sumup.call_paths("GET") if path.endswith("/status")]


@pytest.mark.django_db
def test_a_reader_that_cannot_be_asked_does_not_take_the_page_down(
    backoffice, organizer, sumup
):
    import requests

    sumup.add_reader("rdr_A")
    sumup.next_exception = requests.ConnectTimeout("no route")

    # The first call is the reader list, so this lands on the status call.
    response = backoffice.get(sumup_url(organizer))

    assert response.status_code == 200


# -- freeing a stuck reader -------------------------------------------------


@pytest.mark.django_db
def test_clearing_a_screen_terminates_the_checkout(backoffice, organizer, sumup):
    reader_id = sumup.set_state(sumup.add_reader("rdr_A"), "WAITING_FOR_CARD")

    backoffice.post(sumup_url(organizer), {"action": "free", "reader_id": reader_id})

    assert f"/v0.1/merchants/{sumup.merchant}/readers/{reader_id}/terminate" in (
        sumup.call_paths("POST")
    )


@pytest.mark.django_db
def test_clearing_a_screen_does_not_decide_whether_the_card_was_charged(
    backoffice, organizer, device, sumup, event, ticket, reader_till, till
):
    """
    The mistake this plugin has already made once, in the other direction.
    Terminating is best-effort and SumUp confirms nothing, so it cannot say
    whether the cardholder had already paid — only SumUp's own transaction
    can, and that is what settling asks. Writing "failed" here would book a
    refusal over a card that went through.
    """
    from pretix_openpos.models import PosTerminalPayment

    till.post(
        "terminal/start",
        {"idempotency_key": "coincee-01", "positions": [{"item": ticket.pk, "count": 1}]},
    )
    payment = PosTerminalPayment.objects.get(idempotency_key="coincee-01")

    backoffice.post(sumup_url(organizer), {"action": "free", "reader_id": reader_till})

    payment.refresh_from_db()
    assert payment.status == PosTerminalPayment.STATUS_PENDING


@pytest.mark.django_db
def test_a_reader_sumup_will_not_clear_says_why(backoffice, organizer, sumup):
    sumup.set_state(sumup.add_reader("rdr_A"), "WAITING_FOR_CARD")
    sumup.next_response = FakeResponse(500, {"message": "down"})

    response = backoffice.post(
        sumup_url(organizer), {"action": "free", "reader_id": "rdr_A"}, follow=True
    )

    assert "having trouble" in response.content.decode()


@pytest.mark.django_db
def test_clearing_a_screen_is_closed_to_whoever_may_not_change_devices(
    reader, organizer, sumup
):
    sumup.set_state(sumup.add_reader("rdr_A"), "WAITING_FOR_CARD")

    response = reader.post(sumup_url(organizer), {"action": "free", "reader_id": "rdr_A"})

    assert response.status_code == 403
    assert not [p for p in sumup.call_paths("POST") if p.endswith("/terminate")]


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
def test_two_tills_may_share_one_reader(
    backoffice, organizer, device, another_till, sumup
):
    """
    A bar with two tablets and one machine between them.

    Safe because the server takes turns for them rather than because the
    assignment is forbidden: while one till has a basket on the reader the
    other is refused the card and sells for cash. Refusing here instead would
    only mean a second tablet that cannot take a card at all.
    """
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

    assert PosDevice.objects.filter(sumup_reader_id=reader_id).count() == 2


@pytest.mark.django_db
def test_a_shared_reader_says_so_on_the_screen(
    backoffice, organizer, device, another_till, sumup
):
    # Allowed, but never by accident: an organizer who gave the same machine to
    # two tablets has to be able to see that from the screen.
    reader_id = sumup.add_reader("rdr_A")
    for each in (device, another_till.device):
        PosDevice.objects.create(
            device=each, role=PosDevice.ROLE_TILL, sumup_reader_id=reader_id
        )

    page = backoffice.get(devices_url(organizer)).content.decode()

    assert "Shared with another till" in page


@pytest.mark.django_db
def test_a_reader_on_one_till_alone_says_nothing_about_sharing(
    backoffice, organizer, device, sumup
):
    reader_id = sumup.add_reader("rdr_A")
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id=reader_id
    )

    page = backoffice.get(devices_url(organizer)).content.decode()

    assert "Shared with another till" not in page


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


# -- who may change the account ------------------------------------------------


def organizer_staff(organizer, event, email, permissions):
    """A back-office user whose team holds exactly these organizer permissions."""
    from django.test import Client
    from pretix.base.models import Team, User

    user = User.objects.create_user(email, "dummy")
    team = Team.objects.create(
        organizer=organizer,
        name="Matériel",
        all_event_permissions=True,
        all_organizer_permissions=False,
        limit_organizer_permissions=dict.fromkeys(permissions, True),
    )
    team.members.add(user)
    team.limit_events.add(event)
    client = Client()
    assert client.login(email=email, password="dummy")
    return client


@pytest.fixture
def device_manager(organizer, event):
    """Whoever pairs the tablets on the evening: devices, and nothing else."""
    return organizer_staff(organizer, event, "materiel@example.org", ["organizer.devices:write"])


@pytest.fixture
def settings_manager(organizer, event):
    return organizer_staff(
        organizer, event, "bureau@example.org", ["organizer.settings.general:write"]
    )


@pytest.mark.django_db
def test_pairing_tablets_is_not_enough_to_change_the_sumup_account(
    device_manager, organizer, sumup
):
    """
    Whoever holds the merchant code and the key decides whose account every
    card payment lands in. The devices permission is the one handed to whoever
    sets the tablets up; it used to be enough to put in their own.
    """
    assert device_manager.get(sumup_url(organizer)).status_code == 403

    response = device_manager.post(sumup_url(organizer), {
        "action": "settings",
        "openpos_sumup_merchant_code": "THEIRS",
        "openpos_sumup_api_key": "sup_sk_theirs",
    })

    assert response.status_code == 403
    organizer.settings.flush()
    assert organizer.settings.get("openpos_sumup_merchant_code") == sumup.merchant


@pytest.mark.django_db
@pytest.mark.parametrize("action", ["pair", "forget", "free"])
def test_nor_to_pair_or_remove_the_account_s_readers(device_manager, organizer, sumup, action):
    sumup.add_reader("rdr_A")

    response = device_manager.post(
        sumup_url(organizer), {"action": action, "reader_id": "rdr_A", "pairing_code": "ABC123"}
    )

    assert response.status_code == 403
    assert sumup.calls == []


@pytest.mark.django_db
def test_the_organizer_settings_permission_opens_it(settings_manager, organizer, sumup):
    """The permission pretix asks for its own organizer settings pages."""
    from pretix.control.views.organizer import OrganizerSettingsFormView

    from pretix_openpos.sumup_views import SumUpView

    assert SumUpView.permission == OrganizerSettingsFormView.permission
    assert settings_manager.get(sumup_url(organizer)).status_code == 200


@pytest.mark.django_db
def test_the_menu_offers_the_card_readers_to_whoever_may_open_them(
    device_manager, settings_manager, organizer, event
):
    page = device_manager.get(devices_url(organizer)).content.decode()
    assert sumup_url(organizer) not in page
    # The device screen is still theirs.
    assert "Till devices" in page

    page = settings_manager.get(f"/control/organizer/{organizer.slug}/").content.decode()
    assert sumup_url(organizer) in page


@pytest.mark.django_db
def test_the_device_screen_links_the_card_readers_for_whoever_may_open_them(
    backoffice, organizer, device
):
    assert sumup_url(organizer) in backoffice.get(devices_url(organizer)).content.decode()


# -- a reader id is a reader id --------------------------------------------------


#: What a hand-made form could post as a reader id to turn one call into
#: another: up the path, into another path, into a query, into a fragment.
FORGED = [
    "rdr_A/../../../v1.0/merchants/MERCH1/payments/tx_1/refunds",
    "../../v1.0/merchants/MERCH1/payments/tx_1/refunds",
    "rdr_A/terminate",
    "rdr_A?status=1",
    "rdr_A#fragment",
    "..",
    ".",
    "rdr_A%2F..",
    "rdr_",
    "reader_A",
    "",
]


@pytest.mark.django_db
@pytest.mark.parametrize("action", ["forget", "free"])
@pytest.mark.parametrize("forged", FORGED)
def test_a_forged_reader_id_never_reaches_sumup(
    backoffice, organizer, device, sumup, action, forged
):
    sumup.add_reader("rdr_A")
    PosDevice.objects.create(device=device, role=PosDevice.ROLE_TILL, sumup_reader_id="rdr_A")

    response = backoffice.post(
        sumup_url(organizer), {"action": action, "reader_id": forged}, follow=True
    )

    assert "This is not a SumUp reader." in response.content.decode()
    # Not one call — and so not one made with the organizer's key.
    assert [call for call in sumup.calls if call[0] != "GET"] == []
    assert "rdr_A" in sumup.readers
    assert PosDevice.objects.get(device=device).sumup_reader_id == "rdr_A"
    assert not organizer.all_logentries().filter(
        action_type__startswith="pretix_openpos.sumup.reader."
    ).exists()
