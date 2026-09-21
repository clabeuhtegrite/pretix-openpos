"""
What a device is for, and what follows from it.

Two questions, and they are not the same one. The first is cosmetic: which
screen the app opens on, which the server only reports. The second is not: a
till with a card reader assigned may not record a card payment that reader did
not validate, and the whole point of storing the role server-side is that this
holds whatever the app on the tablet believes. So the refusals below are
checked over HTTP, against a real device token, the way a stale or edited app
would actually reach the endpoint.
"""
import pytest
from django.utils.timezone import now
from pretix.base.models import Device
from pretix.base.models.devices import generate_api_token

from pretix_openpos.models import PosDevice, PosSale

from .conftest import sell


def devices_url(organizer):
    return f"/control/organizer/{organizer.slug}/openpos/devices/"


def assign(device, role="", reader=""):
    return PosDevice.objects.create(device=device, role=role, sumup_reader_id=reader)


# -- what the app is told ---------------------------------------------------


@pytest.mark.django_db
def test_an_unassigned_device_is_told_nothing_has_been_decided(till):
    """
    Which is how every device paired before roles existed reaches this.

    The empty role is what the app reads as "keep doing both jobs", so it has
    to survive the round trip rather than being helpfully filled in.
    """
    config = till.get("config").json()

    assert config["device"]["role"] == ""
    assert config["device"]["card"] == "declared"


@pytest.mark.django_db
@pytest.mark.parametrize("role", [PosDevice.ROLE_TILL, PosDevice.ROLE_DOOR])
def test_an_assigned_device_is_told_its_role(till, device, role):
    assign(device, role=role)

    assert till.get("config").json()["device"]["role"] == role


@pytest.mark.django_db
def test_a_reader_makes_card_payments_the_terminal_s_business(till, device):
    assign(device, role=PosDevice.ROLE_TILL, reader="rdr_3MSAFM23CK82VSTT4BN6RWSQ65")

    assert till.get("config").json()["device"]["card"] == "terminal"


@pytest.mark.django_db
def test_a_door_without_a_reader_still_declares_its_card_payments(till, device):
    """The door takes cards on somebody's phone, and always will."""
    assign(device, role=PosDevice.ROLE_DOOR)

    assert till.get("config").json()["device"]["card"] == "declared"


# -- what the server refuses ------------------------------------------------


@pytest.mark.django_db
def test_a_till_with_a_reader_refuses_a_card_sale_it_did_not_validate(till, device, ticket):
    assign(device, role=PosDevice.ROLE_TILL, reader="rdr_ABC")

    response = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="card"
    )

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_required"
    # And nothing was written: not the order, not the journal row.
    assert not PosSale.objects.exists()


@pytest.mark.django_db
def test_the_same_till_still_takes_cash(till, device, ticket):
    """
    The refusal is about one payment method, not about the till.

    A reader that is offline, or a customer with a note in their hand, must not
    leave the bar unable to sell anything.
    """
    assign(device, role=PosDevice.ROLE_TILL, reader="rdr_ABC")

    response = sell(
        till, [{"item": ticket.pk, "count": 1}], payment_type="cash", cash_given="10.00"
    )

    assert response.status_code == 201
    assert PosSale.objects.get().payment_type == PosSale.PAYMENT_CASH


@pytest.mark.django_db
def test_a_till_without_a_reader_takes_cards_as_it_always_has(till, device, ticket):
    assign(device, role=PosDevice.ROLE_TILL)

    response = sell(till, [{"item": ticket.pk, "count": 1}], payment_type="card")

    assert response.status_code == 201
    assert PosSale.objects.get().payment_type == PosSale.PAYMENT_CARD


@pytest.mark.django_db
def test_a_card_sale_replayed_from_a_reader_till_is_refused_too(till, device, ticket):
    """
    The one place this endpoint refuses a sale that has already been paid for.

    Elsewhere a replay is recorded whatever the catalogue has since done,
    because refusing strands money that genuinely changed hands. Here the money
    cannot have changed hands: the reader is driven through SumUp's cloud, so a
    till with no network could not have started a reader payment in the first
    place. A queued card sale from such a till is a stale app, and recording it
    would be writing down a card payment nobody can point at.
    """
    assign(device, role=PosDevice.ROLE_TILL, reader="rdr_ABC")

    response = sell(
        till,
        [{"item": ticket.pk, "count": 1, "price": "10.00"}],
        payment_type="card",
        offline={"recorded_at": "2026-09-19T21:30:00+02:00", "charged_total": "10.00"},
    )

    assert response.status_code == 400
    assert response.json()["code"] == "terminal_required"


@pytest.mark.django_db
def test_a_sale_already_committed_is_still_handed_back(till, device, ticket):
    """
    Assigning a reader mid-evening must not turn a retry into a refusal.

    The sale below was taken while the till had no reader; the retry arrives
    after one was assigned, which is exactly what happens when an organizer
    sets a till up while it is open. There is an order behind it either way,
    and answering the retry with a refusal would send the app looking for a
    sale it had in fact already made.
    """
    first = sell(till, [{"item": ticket.pk, "count": 1}], payment_type="card")
    assert first.status_code == 201

    assign(device, role=PosDevice.ROLE_TILL, reader="rdr_ABC")
    again = sell(till, [{"item": ticket.pk, "count": 1}], payment_type="card")

    assert again.status_code == 200
    assert again.json()["order"]["code"] == first.json()["order"]["code"]
    assert PosSale.objects.count() == 1


@pytest.mark.django_db
def test_one_till_s_reader_does_not_bind_another(till, another_till, device, ticket):
    """The rule follows the device, which is the whole reason it lives there."""
    assign(device, role=PosDevice.ROLE_TILL, reader="rdr_ABC")

    assert sell(till, [{"item": ticket.pk, "count": 1}], payment_type="card").status_code == 400
    assert (
        sell(another_till, [{"item": ticket.pk, "count": 1}], payment_type="card").status_code
        == 201
    )


# -- the screen that assigns them -------------------------------------------


@pytest.mark.django_db
def test_the_screen_lists_the_till_devices(backoffice, organizer, device):
    page = backoffice.get(devices_url(organizer)).content.decode()

    assert device.name in page
    assert f'name="role_{device.pk}"' in page


@pytest.mark.django_db
def test_a_device_on_another_security_profile_is_not_offered_a_role(
    backoffice, organizer, device
):
    """
    A scanner from another app has no use for one, and offering it a role that
    nothing reads would be a setting that does nothing.
    """
    other = Device.objects.create(
        organizer=organizer,
        name="pretixSCAN",
        all_events=True,
        security_profile="pretixscan",
        api_token=generate_api_token(),
        initialized=now(),
    )

    page = backoffice.get(devices_url(organizer)).content.decode()

    assert f'name="role_{device.pk}"' in page
    assert f'name="role_{other.pk}"' not in page


@pytest.mark.django_db
def test_saving_a_role_stores_it(backoffice, organizer, device):
    backoffice.post(devices_url(organizer), {f"role_{device.pk}": "door"})

    assert PosDevice.objects.get(device=device).role == PosDevice.ROLE_DOOR


@pytest.mark.django_db
def test_leaving_a_device_unassigned_writes_no_row(backoffice, organizer, device):
    """
    "Nobody has said" is a state of its own, and the absence of a row is how it
    is spelled. A row saying nothing would read the same to the app and worse
    to anyone looking at the table.
    """
    backoffice.post(devices_url(organizer), {f"role_{device.pk}": ""})

    assert not PosDevice.objects.exists()


@pytest.mark.django_db
def test_clearing_a_role_keeps_the_row_and_empties_it(backoffice, organizer, device):
    assign(device, role=PosDevice.ROLE_DOOR)

    backoffice.post(devices_url(organizer), {f"role_{device.pk}": ""})

    assert PosDevice.objects.get(device=device).role == PosDevice.ROLE_UNSET


@pytest.mark.django_db
def test_an_invented_role_is_refused_and_nothing_is_written(backoffice, organizer, device):
    response = backoffice.post(devices_url(organizer), {f"role_{device.pk}": "admin"})

    assert response.status_code == 200
    assert not PosDevice.objects.exists()


@pytest.mark.django_db
def test_assigning_a_role_does_not_disturb_the_reader(backoffice, organizer, device):
    """
    The reader is not set from this screen, so saving it must not clear one.

    It matters the day the integration lands: an organizer correcting a role
    mid-evening would otherwise silently detach the terminal from the till.
    """
    assign(device, role=PosDevice.ROLE_TILL, reader="rdr_ABC")

    backoffice.post(devices_url(organizer), {f"role_{device.pk}": "door"})

    stored = PosDevice.objects.get(device=device)
    assert stored.role == PosDevice.ROLE_DOOR
    assert stored.sumup_reader_id == "rdr_ABC"


@pytest.mark.django_db
def test_saving_the_role_a_device_already_has_writes_nothing(backoffice, organizer, device):
    """
    An organizer who opens the screen and saves it unchanged — which is most of
    the times it will ever be saved — should not churn a row per device.
    """
    assign(device, role=PosDevice.ROLE_DOOR)
    before = PosDevice.objects.get(device=device).pk

    backoffice.post(devices_url(organizer), {f"role_{device.pk}": "door"})

    stored = PosDevice.objects.get(device=device)
    assert stored.pk == before
    assert stored.role == PosDevice.ROLE_DOOR


# -- the model itself -------------------------------------------------------


@pytest.mark.django_db
def test_a_device_with_no_row_answers_like_an_unassigned_one(device):
    """
    ``for_device`` never returns ``None``, so no caller has to ask twice.

    The API reads the role and the reader off whatever comes back, and an
    unassigned device has to answer those questions as readily as an assigned
    one — with the defaults.
    """
    blank = PosDevice.for_device(device)

    assert blank.pk is None
    assert blank.role == PosDevice.ROLE_UNSET
    assert blank.drives_terminal is False


@pytest.mark.django_db
def test_a_request_with_no_device_behind_it_answers_the_same(event, backoffice):
    """
    Session-authenticated calls exist — the integration suite makes them — and
    they arrive with no device at all.
    """
    blank = PosDevice.for_device(None)

    assert blank.role == PosDevice.ROLE_UNSET
    assert blank.drives_terminal is False


@pytest.mark.django_db
def test_a_row_names_the_device_and_its_role(device):
    assert str(assign(device, role=PosDevice.ROLE_DOOR)).endswith(": door")
    PosDevice.objects.all().delete()
    assert str(assign(device)).endswith(": unset")


@pytest.mark.django_db
def test_someone_who_may_not_change_devices_cannot_reach_the_screen(
    reader, organizer, device
):
    assert reader.get(devices_url(organizer)).status_code == 403
    reader.post(devices_url(organizer), {f"role_{device.pk}": "door"})
    assert not PosDevice.objects.exists()
