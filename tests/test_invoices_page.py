"""
The event's page of invoices by association.

Who invoices the online ticketing and whether the event numbers on its own are
set here; who invoices the cards and each drawer's cash is set once for the
organizer and only shown. Then every invoice of the event, grouped by the
association that issued it and by how the money came in, with each group's
list and PDFs for its treasurer.
"""
import io
import re
from zipfile import ZipFile

import pytest
from pretix.base.models import Invoice
from pretix.base.services.orders import cancel_order

from pretix_openpos.issuers import report
from pretix_openpos.models import PosAssociation

from .conftest import staff
from .test_drawers import give_drawer, open_it
from .test_invoice_issuers import a_seller, bought_online, invoiced, online_by, rung_up


def invoices_url(event, query=""):
    return f"/control/event/{event.organizer.slug}/{event.slug}/openpos/invoices/{query}"


@pytest.fixture
def portiers(organizer):
    return a_seller(organizer, "Les Portiers", "PORT-")


@pytest.fixture
def comptoir(organizer):
    return a_seller(organizer, "Le Comptoir", "COMPT-")


@pytest.fixture
def evening(organizer, event, till, device, ticket, beer, portiers, comptoir):
    """
    An evening three ways: a ticket bought online and a cash sale at the door,
    both the Portiers'; a card at the bar, the Comptoir's, and cancelled; a cash
    sale rung up before the door's drawer was given to anybody.
    """
    online_by(event, portiers)
    organizer.settings.set("openpos_sumup_holder", str(comptoir.pk))
    invoiced(bought_online(event, price="12.00"))
    rung_up(till, beer, key="sale-00001")
    drawer = give_drawer(device, name="Porte")
    drawer.held_by = portiers
    drawer.save()
    open_it(till)
    rung_up(till, beer, key="sale-00002")
    order, _invoice = rung_up(till, beer, payment_type="card", key="sale-00003")
    cancel_order(order.pk, cancel_invoice=True, send_mail=False)
    return drawer


def lines_of(group):
    return [(str(line["label"]), line["invoices"], line["credit_notes"], str(line["total"])) for line in group["lines"]]


# -- who may -------------------------------------------------------------------


@pytest.mark.django_db
def test_the_page_is_read_with_the_orders_and_set_with_the_invoicing_settings(organizer, event, portiers):
    reader = staff(organizer, event, "benevole@example.org", ["event.orders:read"])
    keeper = staff(organizer, event, "tresorier@example.org", ["event.orders:read", "event.settings.invoicing:write"])
    nobody = staff(organizer, event, "personne@example.org", [])

    assert nobody.get(invoices_url(event)).status_code == 403
    page = reader.get(invoices_url(event)).content.decode()
    assert 'name="online"' not in page
    assert reader.post(invoices_url(event), {"online": portiers.pk}).status_code == 403

    assert 'name="online"' in keeper.get(invoices_url(event)).content.decode()
    assert keeper.post(invoices_url(event), {"online": portiers.pk}).status_code == 302
    assert event.settings.get("openpos_online_holder") == str(portiers.pk)


@pytest.mark.django_db
def test_the_sidebar_offers_it_under_open_pos(backoffice, event):
    page = backoffice.get(invoices_url(event)).content.decode()

    assert f'href="{invoices_url(event)}"' in page
    assert "Invoices by association" in page


# -- what it shows -------------------------------------------------------------


@pytest.mark.django_db
def test_each_association_gets_its_invoices_by_how_the_money_came_in(event, evening, portiers, comptoir):
    groups = report(event)

    assert [group["association"] for group in groups] == [comptoir, portiers, None]
    comptoir_group, portiers_group, event_group = groups
    assert lines_of(comptoir_group) == [("Card on site (SumUp)", 1, 1, "0.00")]
    assert lines_of(portiers_group) == [
        ("Online ticketing", 1, 0, "12.00"),
        ("Cash, drawer “Porte”", 1, 0, "3.00"),
    ]
    assert (portiers_group["invoices"], portiers_group["credit_notes"], str(portiers_group["total"])) == (
        2, 0, "15.00",
    )
    assert lines_of(event_group) == [("Cash", 1, 0, "3.00")]
    assert event_group["key"] == "event"


@pytest.mark.django_db
def test_the_page_says_it_all_in_one_place(backoffice, event, evening, portiers):
    page = backoffice.get(invoices_url(event)).content.decode()

    assert "Les Portiers" in page and "Le Comptoir" in page
    assert "In the event's name" in page
    assert "Cash, drawer “Porte”" in page
    assert f"?export=csv&amp;association={portiers.pk}" in page
    assert "?export=pdf&amp;association=event" in page
    assert "invoices in its own name" in page


@pytest.mark.django_db
def test_an_event_before_any_invoice_says_so(backoffice, event):
    page = backoffice.get(invoices_url(event)).content.decode()

    assert "No invoice for this event yet." in page
    # No association to choose from: said as it is.
    assert 'name="online"' not in page


@pytest.mark.django_db
def test_what_is_not_ready_to_invoice_says_why(backoffice, organizer, event, device):
    unfinished = PosAssociation.objects.create(organizer=organizer, name="Les Portiers", invoice_prefix="PORT-")
    organizer.settings.set("openpos_sumup_holder", str(unfinished.pk))
    give_drawer(device, name="Bar")

    page = backoffice.get(invoices_url(event)).content.decode()

    assert "its profile lacks: address, zip code, city, country." in page
    assert "Invoiced in the event's name." in page


@pytest.mark.django_db
def test_test_mode_is_left_out_and_said(backoffice, event, ticket, portiers):
    online_by(event, portiers)
    invoiced(bought_online(event, testmode=True))

    page = backoffice.get(invoices_url(event)).content.decode()

    assert report(event) == []
    assert "1 invoice of test mode is left out." in page


@pytest.mark.django_db
@pytest.mark.parametrize("generate,channels,warned", [
    ("False", ["web", "openpos"], True),
    ("user", ["web", "openpos"], True),
    ("paid", ["openpos"], True),
    ("paid", ["web", "openpos"], False),
    ("True", ["web", "openpos"], False),
])
def test_the_page_warns_when_the_webshop_is_not_invoiced(backoffice, event, generate, channels, warned):
    event.settings.set("invoice_generate", generate)
    event.settings.set("invoice_generate_sales_channels", channels)

    page = backoffice.get(invoices_url(event)).content.decode()

    assert ("does not invoice this event's online orders automatically" in page) is warned


# -- what it sets ----------------------------------------------------------------


def invoicing_history(event):
    return [
        str(entry.display())
        for entry in event.all_logentries().filter(action_type="pretix_openpos.invoicing.changed").order_by("pk")
    ]


@pytest.mark.django_db
def test_who_invoices_online_and_the_event_s_numbering_are_saved_and_written_down(backoffice, event, portiers):
    backoffice.post(invoices_url(event), {"online": portiers.pk, "series": " FEST- "})
    event.settings.flush()
    assert event.settings.get("openpos_online_holder") == str(portiers.pk)
    assert event.settings.get("openpos_invoice_series") == "FEST-"

    page = backoffice.get(invoices_url(event)).content.decode()
    assert "PORT-FEST-00001" in page
    assert 'value="FEST-"' in page

    backoffice.post(invoices_url(event), {"online": "", "series": ""})
    backoffice.post(invoices_url(event), {"online": "", "series": ""})
    event.settings.flush()
    assert event.settings.get("openpos_online_holder") is None
    assert event.settings.get("openpos_invoice_series") is None

    first, second = invoicing_history(event)
    assert "online ticketing: nobody → Les Portiers" in first
    assert "the event's own numbering: — → FEST-" in first
    assert "online ticketing: Les Portiers → nobody" in second
    assert "the event's own numbering: FEST- → —" in second


@pytest.mark.django_db
def test_an_entry_that_changed_nothing_still_reads(event):
    event.log_action("pretix_openpos.invoicing.changed", data={})

    assert invoicing_history(event) == ["Who invoices what was saved with nothing changed."]


@pytest.mark.django_db
@pytest.mark.parametrize("post,message", [
    ({"online": "999999"}, "One of the associations chosen no longer exists."),
    ({"series": "FÊTE!"}, "Use only the characters A-Z, a-z, 0-9, -./:# here."),
    ({"series": "X" * 51}, "The event&#x27;s part of the numbers is too long."),
])
def test_what_cannot_be_saved_changes_nothing(backoffice, event, portiers, post, message):
    response = backoffice.post(invoices_url(event), post, follow=True)

    assert message in response.content.decode()
    event.settings.flush()
    assert event.settings.get("openpos_online_holder") is None
    assert event.settings.get("openpos_invoice_series") is None
    assert invoicing_history(event) == []


# -- the files -------------------------------------------------------------------


def csv_rows(response):
    content = b"".join(response.streaming_content).decode("utf-8-sig")
    return [line.split(";") for line in content.strip().splitlines()]


@pytest.mark.django_db
def test_an_association_s_invoices_as_a_list(backoffice, event, evening, portiers, comptoir):
    response = backoffice.get(invoices_url(event, f"?export=csv&association={portiers.pk}"))

    assert response["Content-Disposition"] == (
        'attachment; filename="openpos-invoices-soiree-les-portiers.csv"'
    )
    header, *rows = csv_rows(response)
    assert header == ["number", "date", "kind", "order", "money", "drawer", "net", "tax", "gross"]
    assert [(row[0], row[2], row[4], row[5], row[8]) for row in rows] == [
        ("PORT-00001", "invoice", "online", "", "12.00"),
        ("PORT-00002", "invoice", "cash", "Porte", "3.00"),
    ]

    comptoir_rows = csv_rows(backoffice.get(invoices_url(event, f"?export=csv&association={comptoir.pk}")))[1:]
    assert [(row[0], row[2], row[8]) for row in comptoir_rows] == [
        ("COMPT-00001", "invoice", "3.00"),
        ("COMPT-00002", "credit_note", "-3.00"),
    ]

    event_rows = csv_rows(backoffice.get(invoices_url(event, "?export=csv&association=event")))[1:]
    assert [(row[0], row[4]) for row in event_rows] == [("SOIREE-00001", "cash")]


@pytest.mark.django_db
@pytest.mark.parametrize("key", ["", "nope", "999999"])
def test_a_group_that_is_not_there_is_not_found(backoffice, event, key):
    assert backoffice.get(invoices_url(event, f"?export=csv&association={key}")).status_code == 404


@pytest.mark.django_db
def test_an_association_s_invoices_as_their_pdfs(backoffice, event, ticket, portiers, monkeypatch):
    online_by(event, portiers)
    kept = invoiced(bought_online(event))
    gone = invoiced(bought_online(event))
    shredded = invoiced(bought_online(event))
    never = invoiced(bought_online(event))
    backoffice.get(invoices_url(event, f"?export=pdf&association={portiers.pk}"))
    kept.refresh_from_db()
    gone.refresh_from_db()
    # Its file lost from the storage, as after a restore without the media.
    gone.file.storage.delete(gone.file.name)
    Invoice.objects.filter(pk=shredded.pk).update(shredded=True)

    from pretix.base.services import invoices as invoice_services

    real = invoice_services.invoice_pdf_task.apply

    def renders_all_but_one(args=None, **kwargs):
        if args and args[0] == never.pk:
            return None
        return real(args=args, **kwargs)

    Invoice.objects.filter(pk=never.pk).update(file=None)
    monkeypatch.setattr(invoice_services.invoice_pdf_task, "apply", renders_all_but_one)
    response = backoffice.get(invoices_url(event, f"?export=pdf&association={portiers.pk}"))

    assert response["Content-Type"] == "application/zip"
    assert 'filename="openpos-invoices-soiree-les-portiers.zip"' in response["Content-Disposition"]
    archive = ZipFile(io.BytesIO(b"".join(response.streaming_content)))
    names = sorted(archive.namelist())
    assert names == sorted([
        f"PORT-00001-{kept.order.code}.pdf",
        f"PORT-00002-{gone.order.code}.pdf",
    ])
    assert all(archive.read(name).startswith(b"%PDF") for name in names)
    assert re.match(r"^PORT-", names[0])
