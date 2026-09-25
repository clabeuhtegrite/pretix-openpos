"""
Fixtures for the plugin's test suite.

Everything here builds real pretix objects and talks to the plugin over HTTP,
through pretix' own API stack: the device token, the security profile, the
router, the permission checks. A test that called the viewset directly would
prove the arithmetic and nothing about whether a paired till can actually reach
the endpoint — which is a bug this project has already had, twice, on
permission strings that were merely plausible.
"""
from datetime import timedelta

import pytest
from django.core.cache import cache
from django.test import Client
from django.utils import translation
from django.utils.timezone import now
from django_scopes import scopes_disabled
from pretix.base.models import Device, Event, Item, ItemVariation, Order, Organizer, Quota, Team, User
from pretix.base.models.devices import generate_api_token


@pytest.fixture(autouse=True)
def _scopes_off():
    """
    Every fixture and assertion runs outside pretix' organizer scoping.

    Requests are unaffected: pretix' middleware opens the real scope for the
    organizer being addressed, which is what the endpoints run under.
    """
    with scopes_disabled():
        yield


@pytest.fixture(autouse=True)
def _clean_cache():
    """Nothing a test cached may reach the next one."""
    cache.clear()
    yield
    cache.clear()


@pytest.fixture(autouse=True)
def _default_language():
    """
    Nor the language a test left active.

    A request picks its language and leaves it active on the thread when it is
    done, so one test asking in French had the tests after it read French —
    passing or failing by the order they ran in.
    """
    yield
    translation.deactivate()


@pytest.fixture
def real_cache(settings):
    """
    A cache that actually stores, for the two things that are about caching.

    The suite otherwise runs on pretix' dummy cache; asking for this one is how
    a test says it means to exercise a checkpoint rather than to be handed a
    miss every time.
    """
    settings.CACHES = {
        "default": {"BACKEND": "django.core.cache.backends.locmem.LocMemCache"}
    }
    cache.clear()
    yield cache
    cache.clear()


@pytest.fixture
def organizer():
    return Organizer.objects.create(name="Association", slug="asso")


@pytest.fixture
def event(organizer):
    event = Event.objects.create(
        organizer=organizer,
        name="Soirée",
        slug="soiree",
        date_from=now() + timedelta(days=1),
        plugins="pretix_openpos",
        live=True,
        currency="EUR",
    )
    event.settings.set("timezone", "Europe/Paris")
    return event


@pytest.fixture
def channel(organizer):
    """The POS sales channel, created the way the plugin creates it."""
    from pretix_openpos.api.views import get_pos_channel

    return get_pos_channel(organizer)


@pytest.fixture
def ticket(event, channel):
    """An admission product on sale at the till, with room for 100 people."""
    item = Item.objects.create(
        event=event,
        name="Entrée",
        default_price=10,
        admission=True,
        all_sales_channels=False,
    )
    item.limit_sales_channels.add(channel)
    quota = Quota.objects.create(event=event, name="Entrées", size=100)
    quota.items.add(item)
    return item


@pytest.fixture
def beer(event, channel):
    """A non-admission product: a merch line has no door."""
    item = Item.objects.create(
        event=event,
        name="Bière",
        default_price=3,
        admission=False,
        all_sales_channels=False,
    )
    item.limit_sales_channels.add(channel)
    quota = Quota.objects.create(event=event, name="Bar", size=None)
    quota.items.add(item)
    return item


@pytest.fixture
def shirt(event, channel):
    """A product with variations, for the paths that only exist with one."""
    item = Item.objects.create(
        event=event,
        name="T-shirt",
        default_price=15,
        admission=False,
        all_sales_channels=False,
    )
    item.limit_sales_channels.add(channel)
    small = ItemVariation.objects.create(item=item, value="S", default_price=15)
    large = ItemVariation.objects.create(item=item, value="L", default_price=18)
    quota = Quota.objects.create(event=event, name="Textile", size=50)
    quota.items.add(item)
    quota.variations.add(small, large)
    return item, small, large


@pytest.fixture
def misc(event, channel):
    """The product free amounts are booked against, and the setting naming it."""
    item = Item.objects.create(
        event=event,
        name="Divers",
        default_price=0,
        admission=False,
        all_sales_channels=False,
    )
    item.limit_sales_channels.add(channel)
    quota = Quota.objects.create(event=event, name="Divers", size=None)
    quota.items.add(item)
    event.settings.set("openpos_custom_item", str(item.pk))
    return item


@pytest.fixture
def deposit(event, channel):
    """A one-euro cup deposit, with the till's return button switched on."""
    item = Item.objects.create(
        event=event,
        name="Consigne gobelet",
        default_price=1,
        admission=False,
        all_sales_channels=False,
    )
    item.limit_sales_channels.add(channel)
    quota = Quota.objects.create(event=event, name="Gobelets", size=None)
    quota.items.add(item)
    event.settings.set("openpos_deposit_item", str(item.pk))
    return item


@pytest.fixture
def checkin_list(event, ticket):
    return event.checkin_lists.create(name="Porte", all_products=True)


@pytest.fixture
def device(organizer, event):
    """A paired till, on the security profile the plugin ships."""
    device = Device.objects.create(
        organizer=organizer,
        name="Caisse bar",
        all_events=True,
        security_profile="openpos",
        api_token=generate_api_token(),
        initialized=now(),
    )
    return device


@pytest.fixture
def another_till(organizer, event):
    """A second paired till, for everything that is scoped to one device."""
    return Till(
        Device.objects.create(
            organizer=organizer,
            name="Caisse entrée",
            all_events=True,
            security_profile="openpos",
            api_token=generate_api_token(),
            initialized=now(),
        ),
        event,
    )


@pytest.fixture
def till(device, event):
    """
    The till as the PWA sees it: a client that signs every call with the token.

    Returns a small object with ``get``/``post`` taking a POS action name, so a
    test reads as "the till asks for the catalogue" rather than as a URL.
    """
    return Till(device, event)


class Till:
    def __init__(self, device, event):
        self.device = device
        self.event = event
        self.client = Client()

    def url(self, action, **params):
        base = (
            f"/api/v1/organizers/{self.event.organizer.slug}"
            f"/events/{self.event.slug}/openpos/{action}/"
        )
        if params:
            base += "?" + "&".join(f"{k}={v}" for k, v in params.items())
        return base

    def get(self, action, **params):
        return self.client.get(
            self.url(action, **params),
            HTTP_AUTHORIZATION=f"Device {self.device.api_token}",
        )

    def post(self, action, body):
        return self.client.post(
            self.url(action),
            data=body,
            content_type="application/json",
            HTTP_AUTHORIZATION=f"Device {self.device.api_token}",
        )


def staff(organizer, event, email, permissions):
    """
    A back-office user on a team with exactly these permissions.

    Permissions are the namespaced strings pretix uses now, not the legacy
    ``can_*`` attributes: an unknown string is simply never in the permission
    set, so a screen guarded by a plausible-looking one locks out every team
    that is not all-powerful while still working for an admin — which is a bug
    this project shipped once already.
    """
    user = User.objects.create_user(email, "dummy")
    team = Team.objects.create(
        organizer=organizer,
        name="Équipe",
        all_event_permissions=permissions is None,
        limit_event_permissions={} if permissions is None else dict.fromkeys(permissions, True),
        all_organizer_permissions=permissions is None,
    )
    team.members.add(user)
    team.limit_events.add(event)
    client = Client()
    assert client.login(email=email, password="dummy")
    return client


@pytest.fixture
def sumup(organizer, monkeypatch):
    """
    A SumUp account this organizer is set up with, answered in memory.

    Patches the one function the plugin uses to reach SumUp, so a test that
    forgets to go through here gets a connection error rather than a live call.
    """
    from pretix_openpos import sumup as sumup_module

    from .sumup_stub import FakeSumUp

    fake = FakeSumUp()
    organizer.settings.set("openpos_sumup_merchant_code", fake.merchant)
    organizer.settings.set("openpos_sumup_api_key", "sup_sk_test")
    monkeypatch.setattr(sumup_module.requests, "request", fake.request)
    return fake


@pytest.fixture
def reader_till(device, sumup):
    """The till of the `till` fixture, with a paired reader assigned to it."""
    from pretix_openpos.models import PosDevice

    reader_id = sumup.add_reader()
    PosDevice.objects.create(
        device=device, role=PosDevice.ROLE_TILL, sumup_reader_id=reader_id
    )
    return reader_id


@pytest.fixture
def backoffice(organizer, event):
    """A logged-in session that may do everything on the event."""
    return staff(organizer, event, "boss@example.org", None)


@pytest.fixture
def reader(organizer, event):
    """A logged-in session that may read orders and nothing else."""
    return staff(organizer, event, "benevole@example.org", ["event.orders:read"])


@pytest.fixture
def outsider(organizer, event):
    """A member of the organizer who may read none of its events."""
    return staff(organizer, event, "personne@example.org", [])


def sell(till, positions, **kwargs):
    """Ring up a sale at the till and return the parsed answer."""
    body = {
        "idempotency_key": kwargs.pop("idempotency_key", "key-" + "0" * 8),
        "positions": positions,
        "payment_type": kwargs.pop("payment_type", "cash"),
        **kwargs,
    }
    return till.post("checkout", body)


def order_of(event, code):
    return Order.objects.get(event=event, code=code)
