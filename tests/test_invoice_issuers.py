"""
Invoices in the name of the association that received the money.

Every invoice here is made the way pretix makes it — ``generate_invoice`` for a
webshop order, the till's own checkout for a sale, pretix' ``cancel_order``,
``generate_cancellation`` and ``regenerate_invoice`` for what follows — and
what is checked is what pretix wrote down: the number, and the seller printed
at the top and the foot of the page. That is what an association's treasurer
receives, and what its books are kept from.
"""
import logging
from datetime import timedelta
from decimal import Decimal

import pytest
from django.utils.timezone import now
from pretix.base.models import Event, Invoice, Item, Order, OrderPayment, OrderPosition
from pretix.base.services.invoices import (
    build_preview_invoice_pdf, generate_cancellation, generate_invoice, regenerate_invoice,
)
from pretix.base.services.orders import cancel_order

from pretix_openpos import issuers
from pretix_openpos.models import PosAssociation, PosInvoiceIssuer

from .conftest import order_of, sell
from .test_drawers import give_drawer, open_it

D = Decimal


def a_seller(organizer, name, prefix, **fields):
    """An association with everything an invoice needs."""
    profile = {
        "address": "12 rue des Lilas",
        "zipcode": "75011",
        "city": "Paris",
        "country": "FR",
        "siret": "123 456 789 00012",
        "invoice_footer": "Association loi 1901\nTVA non applicable, art. 293 B du CGI",
    }
    profile.update(fields)
    return PosAssociation.objects.create(
        organizer=organizer, name=name, invoice_prefix=prefix, **profile
    )


@pytest.fixture
def portiers(organizer):
    """Sells the tickets online, and keeps the door's drawer."""
    return a_seller(organizer, "Les Portiers", "PORT-")


@pytest.fixture
def comptoir(organizer):
    """Runs the bar, and owns the SumUp account. Registered for VAT, no SIRET."""
    return a_seller(
        organizer, "Le Comptoir", "COMPT-", siret="", invoice_footer="", vat_id="FR12345678901",
        address="3 quai du Port", zipcode="13002", city="Marseille",
    )


@pytest.fixture(autouse=True)
def event_issuer(event):
    """What pretix prints on the event's own invoices, to tell them apart."""
    event.settings.set("invoice_address_from_name", "Collectif")
    event.settings.set("invoice_address_from", "1 place du Marché")
    event.settings.set("invoice_address_from_zipcode", "75001")
    event.settings.set("invoice_address_from_city", "Paris")
    event.settings.set("invoice_address_from_country", "FR")
    event.settings.set("invoice_address_from_tax_id", "FR-TAX-1")
    event.settings.set("invoice_footer_text", "Collectif · merci de votre visite")
    return event


def online_by(event, association):
    event.settings.set("openpos_online_holder", str(association.pk))


def another_event(organizer, slug="soiree-2", plugins="pretix_openpos"):
    other = Event.objects.create(
        organizer=organizer, name="Soirée suivante", slug=slug,
        date_from=now() + timedelta(days=8), plugins=plugins, live=True, currency="EUR",
    )
    Item.objects.create(event=other, name="Entrée", default_price=10, admission=True)
    return other


def bought_online(event, price="10.00", testmode=False):
    """A paid webshop order, as Stripe leaves one."""
    item = event.items.first()
    order = Order.objects.create(
        event=event,
        status=Order.STATUS_PAID,
        datetime=now(),
        expires=now() + timedelta(days=1),
        total=D(price),
        testmode=testmode,
        sales_channel=event.organizer.sales_channels.get(identifier="web"),
    )
    OrderPosition.objects.create(order=order, item=item, positionid=1, price=D(price))
    OrderPayment.objects.create(
        order=order, amount=D(price), provider="stripe",
        state=OrderPayment.PAYMENT_STATE_CONFIRMED, payment_date=now(),
    )
    return order


def invoiced(order):
    """The order's invoice, as pretix makes it on payment."""
    invoice = generate_invoice(order, trigger_pdf=False)
    invoice.refresh_from_db()
    return invoice


def rung_up(till, beer, payment_type="cash", key="sale-00001"):
    """A sale at the till, and the invoice the till made for it."""
    response = sell(till, [{"item": beer.pk, "count": 1}], idempotency_key=key, payment_type=payment_type)
    assert response.status_code == 201, response.content
    order = order_of(till.event, response.json()["order"]["code"])
    return order, order.invoices.get()


def issuer(invoice):
    record = PosInvoiceIssuer.objects.filter(invoice=invoice).first()
    return (record.association, record.via, record.drawer) if record else None


# -- who issues what ---------------------------------------------------------


@pytest.mark.django_db
def test_a_ticket_bought_online_is_invoiced_by_the_association_paid_online(event, ticket, portiers):
    online_by(event, portiers)

    invoice = invoiced(bought_online(event))

    assert invoice.number == "PORT-00001"
    assert invoice.invoice_from_name == "Les Portiers"
    assert invoice.invoice_from == "12 rue des Lilas"
    assert (invoice.invoice_from_zipcode, invoice.invoice_from_city) == ("75011", "Paris")
    assert str(invoice.invoice_from_country) == "FR"
    # pretix prints its tax ID as a VAT number in French: the event's is not
    # left behind, and the SIRET is in the footer under its own name.
    assert invoice.invoice_from_tax_id == ""
    assert invoice.invoice_from_vat_id == ""
    assert invoice.footer_text == (
        "SIRET: 123 456 789 00012\nAssociation loi 1901\nTVA non applicable, art. 293 B du CGI"
    )
    assert "Collectif" not in invoice.full_invoice_from
    assert issuer(invoice) == (portiers, "online", None)


@pytest.mark.django_db
def test_a_card_at_the_till_is_invoiced_by_the_sumup_account_s_association(
    organizer, event, till, beer, comptoir, portiers
):
    organizer.settings.set("openpos_sumup_holder", str(comptoir.pk))
    online_by(event, portiers)

    _order, invoice = rung_up(till, beer, payment_type="card")

    assert invoice.number == "COMPT-00001"
    assert invoice.invoice_from_name == "Le Comptoir"
    assert invoice.invoice_from_vat_id == "FR12345678901"
    # No SIRET and no wording: nothing at the foot, the event's included.
    assert invoice.footer_text == ""
    assert issuer(invoice) == (comptoir, "card", None)


@pytest.mark.django_db
def test_cash_is_invoiced_by_the_association_keeping_the_drawer(
    organizer, event, till, device, beer, comptoir, portiers
):
    organizer.settings.set("openpos_sumup_holder", str(comptoir.pk))
    drawer = give_drawer(device, name="Porte")
    drawer.held_by = portiers
    drawer.save()
    open_it(till)

    _order, invoice = rung_up(till, beer)

    assert invoice.number == "PORT-00001"
    assert invoice.invoice_from_name == "Les Portiers"
    assert issuer(invoice) == (portiers, "cash", drawer)


@pytest.mark.django_db
def test_each_association_numbers_its_own_invoices(
    organizer, event, till, device, ticket, beer, comptoir, portiers
):
    """Three associations' worth of money in one evening: three series, each from 1."""
    online_by(event, portiers)
    organizer.settings.set("openpos_sumup_holder", str(comptoir.pk))

    first_online = invoiced(bought_online(event))
    _order, card = rung_up(till, beer, payment_type="card", key="sale-00001")
    second_online = invoiced(bought_online(event))
    _order, second_card = rung_up(till, beer, payment_type="card", key="sale-00002")

    assert [first_online.number, second_online.number] == ["PORT-00001", "PORT-00002"]
    assert [card.number, second_card.number] == ["COMPT-00001", "COMPT-00002"]


# -- the numbering -----------------------------------------------------------


@pytest.mark.django_db
def test_numbers_run_on_from_one_event_to_the_next(organizer, event, ticket, portiers):
    online_by(event, portiers)
    tomorrow = another_event(organizer)
    online_by(tomorrow, portiers)

    tonight = invoiced(bought_online(event))
    next_week = invoiced(bought_online(tomorrow))
    later_tonight = invoiced(bought_online(event))

    assert [tonight.number, next_week.number, later_tonight.number] == [
        "PORT-00001", "PORT-00002", "PORT-00003",
    ]


@pytest.mark.django_db
def test_an_event_can_start_a_numbering_of_its_own(organizer, event, ticket, portiers):
    online_by(event, portiers)
    festival = another_event(organizer, slug="festival")
    online_by(festival, portiers)
    festival.settings.set("openpos_invoice_series", "FEST-")

    before = invoiced(bought_online(event))
    first = invoiced(bought_online(festival))
    second = invoiced(bought_online(festival))
    after = invoiced(bought_online(event))

    assert [first.number, second.number] == ["PORT-FEST-00001", "PORT-FEST-00002"]
    # The association's own series carries on as if the festival had not happened.
    assert [before.number, after.number] == ["PORT-00001", "PORT-00002"]


@pytest.mark.django_db
def test_the_association_s_numbers_follow_on_whatever_the_event_numbers_by(event, ticket, portiers):
    """An event numbering its own invoices by order code still gets numbers here."""
    online_by(event, portiers)
    event.settings.set("invoice_numbers_consecutive", False)
    event.settings.set("invoice_numbers_counter_length", 3)

    invoice = invoiced(bought_online(event))

    assert invoice.number == "PORT-001"


@pytest.mark.django_db
def test_a_prefix_can_carry_the_year(organizer, event, ticket):
    yearly = a_seller(organizer, "Les Portiers", "PORT-%Y-")
    online_by(event, yearly)

    invoice = invoiced(bought_online(event))

    assert invoice.number == f"PORT-{invoice.date.year}-00001"


@pytest.mark.django_db
def test_test_mode_has_a_series_of_its_own(event, ticket, portiers):
    online_by(event, portiers)

    test = invoiced(bought_online(event, testmode=True))
    real = invoiced(bought_online(event))

    assert test.number == "PORT-TEST-00001"
    assert real.number == "PORT-00001"


@pytest.mark.django_db
def test_two_invoices_racing_for_one_number_both_get_one(event, ticket, portiers, monkeypatch):
    """
    pretix retries an insert that lost the race for its number, and the retry
    comes back through the association's series rather than out of it.
    """
    online_by(event, portiers)
    taken = invoiced(bought_online(event))
    assert taken.number == "PORT-00001"

    real = Invoice._get_numeric_invoice_number
    calls = []

    def stale(self, length):
        # The first round sees the world as it was before PORT-00001 existed:
        # both pretix' own guess and the one made for the association.
        calls.append(self.prefix)
        if len(calls) <= 2:
            return "00001"
        return real(self, length)

    monkeypatch.setattr(Invoice, "_get_numeric_invoice_number", stale)
    invoice = invoiced(bought_online(event))

    assert invoice.number == "PORT-00002"
    assert PosInvoiceIssuer.objects.filter(invoice=invoice).count() == 1
    assert len(calls) == 4


# -- what follows an invoice -------------------------------------------------


@pytest.mark.django_db
def test_a_credit_note_goes_into_the_series_of_the_invoice_it_cancels(
    organizer, event, till, beer, comptoir
):
    organizer.settings.set("openpos_sumup_holder", str(comptoir.pk))
    order, invoice = rung_up(till, beer, payment_type="card")

    cancel_order(order.pk, cancel_invoice=True)

    credit = Invoice.objects.get(refers=invoice)
    assert credit.is_cancellation
    assert credit.number == "COMPT-00002"
    assert credit.invoice_from_name == "Le Comptoir"
    assert credit.invoice_from_vat_id == "FR12345678901"
    assert issuer(credit) == (comptoir, "card", None)


@pytest.mark.django_db
def test_a_credit_note_follows_its_invoice_even_if_the_account_changed_hands(
    organizer, event, ticket, portiers, comptoir
):
    online_by(event, portiers)
    invoice = invoiced(bought_online(event))
    online_by(event, comptoir)

    credit = generate_cancellation(invoice, trigger_pdf=False)
    credit.refresh_from_db()

    assert credit.number == "PORT-00002"
    assert credit.invoice_from_name == "Les Portiers"


@pytest.mark.django_db
def test_a_new_invoice_of_an_order_stays_with_the_first_one_s_association(
    organizer, event, ticket, portiers, comptoir
):
    """A reissue — cancel, then invoice again — is the same sale, by the same seller."""
    online_by(event, portiers)
    order = bought_online(event)
    first = invoiced(order)
    online_by(event, comptoir)

    generate_cancellation(first, trigger_pdf=False)
    second = invoiced(order)

    assert second.number == "PORT-00003"
    assert issuer(second) == (portiers, "online", None)


@pytest.mark.django_db
def test_a_rebuilt_invoice_keeps_its_seller_and_takes_its_new_address(event, ticket, portiers):
    online_by(event, portiers)
    invoice = invoiced(bought_online(event))
    portiers.address = "8 avenue des Tilleuls"
    portiers.save()

    regenerate_invoice(invoice)
    invoice.refresh_from_db()

    assert invoice.number == "PORT-00001"
    assert invoice.invoice_from_name == "Les Portiers"
    assert invoice.invoice_from == "8 avenue des Tilleuls"
    assert invoice.invoice_from_tax_id == ""


# -- what stays in the event's name ------------------------------------------


def in_the_event_s_name(invoice):
    return (
        invoice.invoice_from_name == "Collectif"
        and invoice.number.startswith("SOIREE-")
        and not PosInvoiceIssuer.objects.filter(invoice=invoice).exists()
    )


@pytest.mark.django_db
def test_nobody_named_for_the_webshop_leaves_its_invoices_to_the_event(event, ticket, portiers):
    invoice = invoiced(bought_online(event))

    assert in_the_event_s_name(invoice)
    assert invoice.footer_text == "Collectif · merci de votre visite"


@pytest.mark.django_db
def test_an_association_without_its_address_does_not_invoice_yet(organizer, event, ticket):
    unfinished = PosAssociation.objects.create(organizer=organizer, name="Les Portiers", invoice_prefix="PORT-")
    online_by(event, unfinished)

    assert unfinished.missing() == ["Address", "ZIP code", "City", "Country"]
    assert in_the_event_s_name(invoiced(bought_online(event)))


@pytest.mark.django_db
def test_cash_without_a_drawer_or_its_keeper_stays_with_the_event(
    organizer, event, till, device, beer, portiers
):
    _order, no_drawer = rung_up(till, beer, key="sale-00001")
    give_drawer(device, name="Bar")
    open_it(till)
    _order, nobody_keeps_it = rung_up(till, beer, key="sale-00002")

    assert in_the_event_s_name(no_drawer)
    assert in_the_event_s_name(nobody_keeps_it)


@pytest.mark.django_db
def test_a_card_with_nobody_named_for_the_sumup_account_stays_with_the_event(event, till, beer, portiers):
    _order, invoice = rung_up(till, beer, payment_type="card")

    assert in_the_event_s_name(invoice)


@pytest.mark.django_db
def test_a_credit_note_for_an_invoice_in_the_event_s_name_stays_there(event, ticket, portiers):
    invoice = invoiced(bought_online(event))
    online_by(event, portiers)

    credit = generate_cancellation(invoice, trigger_pdf=False)
    credit.refresh_from_db()

    assert in_the_event_s_name(credit)


@pytest.mark.django_db
def test_a_till_order_missing_from_the_journal_stays_with_the_event(event, channel, beer, portiers):
    order = Order.objects.create(
        event=event, status=Order.STATUS_PAID, datetime=now(), expires=now(),
        total=D("3.00"), sales_channel=channel,
    )
    OrderPosition.objects.create(order=order, item=beer, positionid=1, price=D("3.00"))

    assert in_the_event_s_name(invoiced(order))


@pytest.mark.django_db
def test_an_event_without_the_plugin_is_left_alone(organizer, portiers):
    elsewhere = another_event(organizer, slug="ailleurs", plugins="")
    online_by(elsewhere, portiers)

    invoice = invoiced(bought_online(elsewhere))

    assert invoice.number == "AILLEURS-00001"
    assert not PosInvoiceIssuer.objects.exists()


@pytest.mark.django_db
def test_the_preview_of_the_event_s_invoices_is_the_event_s(event, portiers, monkeypatch):
    online_by(event, portiers)
    seen = []
    renderer = type(event.invoice_renderer)
    monkeypatch.setattr(
        renderer, "generate",
        lambda self, invoice: seen.append((invoice.number, invoice.invoice_from_name)) or ("x.pdf", "application/pdf", b""),
    )

    build_preview_invoice_pdf(event)

    assert seen == [("SOIREE-PREVIEW", "Collectif")]


@pytest.mark.django_db
def test_an_invoice_is_never_stopped_by_a_failure_here(event, ticket, portiers, monkeypatch, caplog):
    online_by(event, portiers)

    def broken(invoice):
        raise RuntimeError("the database went away")

    monkeypatch.setattr(issuers, "seller_of", broken)
    with caplog.at_level(logging.ERROR, logger="pretix_openpos.issuers"):
        invoice = invoiced(bought_online(event))

    assert in_the_event_s_name(invoice)
    assert "Could not tell who issues an invoice" in caplog.text


@pytest.mark.django_db
def test_a_rebuild_that_cannot_restate_the_seller_still_goes_through(event, ticket, portiers, monkeypatch, caplog):
    online_by(event, portiers)
    invoice = invoiced(bought_online(event))

    def broken(invoice, association):
        raise RuntimeError("no")

    monkeypatch.setattr(issuers, "describe", broken)
    with caplog.at_level(logging.ERROR, logger="pretix_openpos.issuers"):
        regenerate_invoice(invoice)
    invoice.refresh_from_db()

    assert invoice.number == "PORT-00001"
    assert "Could not restate the seller" in caplog.text
