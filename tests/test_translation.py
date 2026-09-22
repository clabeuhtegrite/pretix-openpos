"""
The French catalogue, and the one bug shipping it could have caused.

Open POS is used in French. Everything the volunteers see is already French —
the till app carries its own strings — but the back office and the messages the
server sends a till were not, and the plugin shipped no catalogue at all.

The reason this file exists rather than a line in the changelog is the second
half. Translating a message is only safe if nothing *branches* on its wording,
and this plugin came within one release of exactly that: the SumUp client used
to recognise "the cardholder has not answered yet" by looking for an English
phrase inside an operator-facing message. Those messages are what a catalogue
replaces. The first French install would have turned the normal state of every
reader payment into a refusal, two seconds after it started, with the whole
suite still green because it runs in English.

So these tests run *in French*, through the real endpoints, and check that a
card payment still behaves.
"""
import pytest
from django.utils import translation

from pretix_openpos.models import PosTerminalPayment

from .conftest import sell


@pytest.fixture
def french():
    """Everything inside this test speaks French, as a French install does."""
    with translation.override("fr"):
        yield


def test_the_catalogue_is_installed_and_bound_to_this_app(french):
    from django.utils.translation import gettext

    # A string only this plugin defines. Its coming back in French proves the
    # catalogue was found, compiled, and bound — which is the whole mechanism.
    assert gettext("SumUp refused this request.") == "SumUp a refusé cette demande."


def test_the_compiled_catalogue_matches_its_source():
    """
    The trap of shipping a compiled catalogue: it is a binary, and a .po edited
    without recompiling ships yesterday's wording for ever, silently. Nothing
    else in this repo would notice — the tests read the .mo too.

    Comparing the two is what turns that into a failing test. Git does not
    preserve modification times, so it has to be the contents.
    """
    import gettext as gettext_module
    import re
    from pathlib import Path

    catalogue = Path(__file__).resolve().parent.parent / "pretix_openpos/locale/fr/LC_MESSAGES"
    with (catalogue / "django.mo").open("rb") as handle:
        compiled = gettext_module.GNUTranslations(handle)._catalog

    def unquote(block):
        return "".join(
            part.replace('\\"', '"').replace("\\n", "\n").replace("\\\\", "\\")
            for part in re.findall(r'"((?:[^"\\]|\\.)*)"', block)
        )

    source = (catalogue / "django.po").read_text()
    block = r'(?:"(?:[^"\\]|\\.)*"\n)+'
    pairs = re.findall(
        rf'\n(?:msgctxt ({block}))?msgid ({block})msgstr ({block})', source
    )

    def key(context, msgid):
        # How gettext itself stores a contextual message: the two joined by an
        # EOT. Without this a `{% trans … context %}` string would be looked up
        # under its bare text, miss, and be reported as stale for ever.
        return f"{unquote(context)}\x04{unquote(msgid)}" if context else unquote(msgid)

    stale = [
        key(context, msgid)
        for context, msgid, msgstr in pairs
        if unquote(msgid) and compiled.get(key(context, msgid)) != unquote(msgstr)
    ]

    assert stale == [], (
        "django.mo is out of date with django.po. Recompile it:\n"
        "  msgfmt -o pretix_openpos/locale/fr/LC_MESSAGES/django.mo \\\n"
        "         pretix_openpos/locale/fr/LC_MESSAGES/django.po"
    )


@pytest.mark.django_db
def test_a_refusal_the_till_reads_comes_back_in_french(till, ticket):
    """
    Not through ``translation.override``: an HTTP request picks its own
    language, and the question is what a French tablet actually gets back. The
    app runs in a browser whose ``Accept-Language`` is French, so that is what
    is sent here.
    """
    response = till.client.post(
        till.url("checkout"),
        data={
            "idempotency_key": "refus-01",
            "positions": [{"item": ticket.pk, "count": 1}],
            "payment_type": "cash",
            "cash_given": "1.00",
        },
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Device {till.device.api_token}",
        HTTP_ACCEPT_LANGUAGE="fr",
    )

    assert response.status_code == 400
    assert "inférieur au total dû" in str(response.json())


@pytest.mark.django_db
def test_a_reader_payment_still_waits_for_the_cardholder_in_french(
    french, till, ticket, reader_till, sumup
):
    """
    The trap. "Not yet" is recognised by SumUp's status code, never by the
    wording of a message — and this is the test that would have caught the
    version that did it the other way, because here the messages are French.
    """
    response = till.post(
        "terminal/start",
        {"idempotency_key": "attente-01", "positions": [{"item": ticket.pk, "count": 1}]},
    )

    assert response.status_code == 201
    assert response.json()["status"] == "pending"

    # And polling it, which is what the till does every two seconds, still says
    # "waiting" rather than "refused".
    assert till.get("terminal/status", idempotency_key="attente-01").json()["status"] == (
        "pending"
    )


@pytest.mark.django_db
def test_a_card_paid_in_french_is_still_recognised_as_paid(
    french, till, ticket, reader_till, sumup
):
    till.post(
        "terminal/start",
        {"idempotency_key": "payee-01", "positions": [{"item": ticket.pk, "count": 1}]},
    )
    payment = PosTerminalPayment.objects.get(idempotency_key="payee-01")
    sumup.pay(payment.client_transaction_id, transaction_id="tx_1")

    body = till.get("terminal/status", idempotency_key="payee-01").json()

    assert body["status"] == "successful"


@pytest.mark.django_db
def test_the_back_office_renders_in_french(backoffice, event, till, ticket):
    # The control panel follows the logged-in user's own locale rather than the
    # browser's, which is how an organizer picks a language once and keeps it.
    from pretix.base.models import User

    User.objects.filter(email="boss@example.org").update(locale="fr")
    sell(till, [{"item": ticket.pk, "count": 1}])

    page = backoffice.get(
        f"/control/event/{event.organizer.slug}/{event.slug}/openpos/sales/"
    ).content.decode()

    assert "Recette" in page
    assert "Takings" not in page
    # The date filter's own label, which is the one contextual string in the
    # catalogue. A msgctxt that does not match the template's falls back to
    # English silently, so nothing but rendering the page catches it.
    assert "Soirées du" in page
    assert ">au</label>" in page


@pytest.mark.django_db
def test_the_new_screen_renders_in_french(backoffice, event, beer):
    """
    The screen that says which counter sells which category.

    Its longest strings live in the template rather than in Python, and a
    ``blocktrans`` whose wording drifts from the catalogue by one character
    falls back to English without failing anything else.
    """
    from pretix.base.models import ItemCategory, User

    User.objects.filter(email="boss@example.org").update(locale="fr")
    ItemCategory.objects.create(event=event, name="Bar")

    page = backoffice.get(
        f"/control/event/{event.organizer.slug}/{event.slug}/openpos/categories/"
    ).content.decode()

    assert "Qui vend quoi" in page
    assert "Who sells what" not in page
    assert "Toutes les caisses" in page
    assert "Un appareil de porte vend" in page
    # The paragraph that explains the default, which is the one nobody reads
    # until they are wondering why nothing changed.
    assert "n’affiche que ce qu’il est là pour vendre" in page


@pytest.mark.django_db
def test_a_till_told_it_may_not_sell_something_is_told_in_french(
    till, device, event, beer
):
    """
    The refusal a volunteer actually meets, with a customer in front of them.

    Sent the way the tablet sends it, ``Accept-Language`` and all, for the
    reason given above: an HTTP request picks its own language, and
    ``translation.override`` would prove something else.

    It names the category, so it has to be the category's own name and a French
    sentence around it — not a product id, and not English.
    """
    from pretix.base.models import ItemCategory

    from pretix_openpos.models import PosCategory, PosDevice

    category = ItemCategory.objects.create(event=event, name="Bar")
    beer.category = category
    beer.save()
    PosCategory.objects.create(category=category, role=PosDevice.ROLE_TILL)
    PosDevice.objects.create(device=device, role=PosDevice.ROLE_DOOR)

    response = till.client.post(
        till.url("checkout"),
        data={
            "idempotency_key": "role-0001",
            "positions": [{"item": beer.pk, "count": 1}],
            "payment_type": "cash",
        },
        content_type="application/json",
        HTTP_AUTHORIZATION=f"Device {till.device.api_token}",
        HTTP_ACCEPT_LANGUAGE="fr",
    )

    assert response.status_code == 400
    assert response.json()["positions"][0] == "Cette caisse ne vend pas Bar."
