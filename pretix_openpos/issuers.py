"""
Invoices in the name of the association that received the money.

pretix issues every invoice of an event in one name: the address, the footer
and the numbering of the event's invoice settings. An evening several
associations run is several sellers (:mod:`pretix_openpos.associations`), and
a French invoice is numbered in its seller's own unbroken series. So each
invoice of an event this plugin runs on is issued by the association that
received its money, once that association's profile has what an invoice needs
(:attr:`~pretix_openpos.models.PosAssociation.can_issue`):

- in its name, with its address and VAT number at the top, and its SIRET and
  legal wording at the foot of every page. The event's own footer is left
  out: it is the event's issuer's, and wrong under anybody else's name.
- in its series of numbers: its prefix, then the next number of that prefix
  across all of the organizer's events. pretix numbers per organizer and
  prefix already — it is how two of its events given one prefix share one
  range — so this is that range, owned by the association and running on from
  one evening to the next. An event can start one of its own instead
  (:data:`~pretix_openpos.associations.SERIES_SETTING`): its part goes after
  the association's prefix, and the numbers of that new prefix start from 1.
  Always numbers, whatever the event chose between numbers and order codes for
  its own invoices: that choice is about the event's series, not this one.

A credit note follows the invoice it cancels into the same series, and a new
invoice of an order already invoiced goes to the association of the first: it
is the same sale, and a reissue is not a change of seller. Whatever no
association is ready for — nobody named for the webshop, a drawer nobody
keeps, a profile without its address — is invoiced as pretix always did, in
the event's name and series, and the invoices page says so.

pretix picks the prefix and the number inside ``Invoice.save``, with no hook
before it, so the choice is made as the row is written: Django's ``pre_save``,
which runs inside pretix' own loop around the insert. The association's prefix
and next number replace the event's there, and pretix' guard against two
invoices taking one number still holds — it retries on a duplicate, and every
retry comes back through here. What an invoice says about its seller is
written again every time pretix builds it (``build_invoice_data``), because a
rebuild from the back office starts over from the event's settings.

A failure here never stops an invoice: it is logged, and the invoice goes out
in the event's name.
"""
import logging
from collections import defaultdict
from dataclasses import dataclass
from decimal import Decimal

from django.db import transaction
from django.db.models import Sum
from django.utils.translation import gettext, gettext_lazy as _
from pretix.base.i18n import language
from pretix.base.models import Invoice, InvoiceLine

from .associations import event_series, online_invoicer, sumup_holder
from .channels import POS_CHANNEL
from .models import PosAssociation, PosDrawer, PosInvoiceIssuer, PosSale

logger = logging.getLogger(__name__)

PLUGIN = "pretix_openpos"

ZERO = Decimal("0.00")
CENT = Decimal("0.01")

#: What an invoice says about its seller, all of which this module writes.
SELLER_FIELDS = (
    "invoice_from_name",
    "invoice_from",
    "invoice_from_zipcode",
    "invoice_from_city",
    "invoice_from_state",
    "invoice_from_country",
    "invoice_from_tax_id",
    "invoice_from_vat_id",
    "footer_text",
)


@dataclass(frozen=True)
class Seller:
    """Who received the money an invoice is for, how, and into which drawer."""

    association: PosAssociation | None
    via: str
    drawer_id: int | None = None


def seller_of(invoice):
    """
    Who received the money ``invoice`` is for, or ``None`` to leave it be.

    ``None`` is an invoice this module never had anything to say about: a
    credit note for an invoice issued in the event's name, or a till's order
    with no sale in the journal. A seller whose association is ``None`` is
    money nobody has said anything about.
    """
    if invoice.is_cancellation:
        cancelled = (
            PosInvoiceIssuer.objects.filter(invoice_id=invoice.refers_id)
            .select_related("association")
            .first()
        )
        if cancelled is None:
            return None
        return Seller(cancelled.association, cancelled.via, cancelled.drawer_id)

    first = (
        PosInvoiceIssuer.objects.filter(
            invoice__order_id=invoice.order_id, invoice__is_cancellation=False
        )
        .select_related("association")
        .order_by("invoice_id")
        .first()
    )
    if first is not None:
        return Seller(first.association, first.via, first.drawer_id)

    order = invoice.order
    if order.sales_channel.identifier != POS_CHANNEL:
        return Seller(online_invoicer(invoice.event), PosInvoiceIssuer.VIA_ONLINE)

    sale = (
        PosSale.objects.filter(
            event_id=invoice.event_id, order_id=order.pk, kind=PosSale.KIND_SALE
        )
        .select_related("drawer_session__drawer__held_by")
        .order_by("seq")
        .first()
    )
    if sale is None:
        return None
    if sale.payment_type == PosSale.PAYMENT_CARD:
        # Every card taken on site lands in the SumUp account, reader or not:
        # it is the one account the tills take cards on.
        return Seller(sumup_holder(invoice.event.organizer), PosInvoiceIssuer.VIA_CARD)
    drawer = sale.drawer_session.drawer if sale.drawer_session_id else None
    return Seller(
        drawer.held_by if drawer is not None else None,
        PosInvoiceIssuer.VIA_CASH,
        drawer.pk if drawer is not None else None,
    )


def series(invoice, association):
    """The prefix ``invoice`` is numbered under, as pretix builds one."""
    prefix = association.invoice_prefix + event_series(invoice.event)
    if "%" in prefix:
        prefix = invoice.date.strftime(prefix)
    if invoice.order.testmode:
        prefix += "TEST-"
    return prefix


def describe(invoice, association):
    """Put ``association`` on ``invoice`` as its seller. Nothing is saved."""
    invoice.invoice_from_name = association.name
    invoice.invoice_from = association.address
    invoice.invoice_from_zipcode = association.zipcode
    invoice.invoice_from_city = association.city
    invoice.invoice_from_state = ""
    invoice.invoice_from_country = association.country or None
    # pretix prints its "tax ID" as a VAT number on a French invoice, so the
    # SIRET goes in the footer, under its own name, and this stays empty.
    invoice.invoice_from_tax_id = ""
    invoice.invoice_from_vat_id = association.vat_id
    lines = []
    if association.siret:
        with language(invoice.locale or invoice.event.settings.locale):
            lines.append(gettext("SIRET: {siret}").format(siret=association.siret))
    lines += [line.strip() for line in association.invoice_footer.splitlines()]
    invoice.footer_text = "\n".join(lines).strip()


def on_numbering(invoice):
    """
    ``pre_save`` of an invoice: a new one goes into its seller's series.

    Only a new row, and only once pretix has numbered it — the one invoice
    that comes with its number set is the preview of the event's settings,
    which is the event's own design and is never written.
    """
    if not invoice._state.adding or invoice.invoice_no == "PREVIEW":
        return
    event = invoice.event
    if event is None or PLUGIN not in event.get_plugins():
        return
    try:
        # A savepoint of its own: a query failing in here must not leave
        # pretix' transaction around the insert unusable.
        with transaction.atomic():
            seller = seller_of(invoice)
    except Exception:
        logger.exception("Could not tell who issues an invoice of order %s", invoice.order.code)
        return
    if seller is None or seller.association is None or not seller.association.can_issue:
        return
    invoice.prefix = series(invoice, seller.association)
    invoice.invoice_no = invoice._get_numeric_invoice_number(
        event.settings.invoice_numbers_counter_length
    )
    invoice.full_invoice_no = invoice.prefix + invoice.invoice_no
    describe(invoice, seller.association)
    invoice._openpos_seller = seller


def on_saved(invoice, created):
    """``post_save`` of an invoice: write down whose series it went into."""
    seller = invoice.__dict__.pop("_openpos_seller", None)
    if seller is None or not created:
        return
    PosInvoiceIssuer.objects.create(
        invoice=invoice,
        association=seller.association,
        via=seller.via,
        drawer_id=seller.drawer_id,
    )


def on_built(invoice):
    """``build_invoice_data``: put the seller back after pretix wrote the event's."""
    try:
        with transaction.atomic():
            issuer = (
                PosInvoiceIssuer.objects.filter(invoice=invoice)
                .select_related("association")
                .first()
            )
            if issuer is None:
                return
            describe(invoice, issuer.association)
            invoice.save(update_fields=list(SELLER_FIELDS))
    except Exception:
        logger.exception("Could not restate the seller of invoice %s", invoice.pk)


# -- what each association issued ---------------------------------------------


#: How the money came in, as a line of the invoices page says it.
VIA_LABELS = {
    PosInvoiceIssuer.VIA_ONLINE: _("Online ticketing"),
    PosInvoiceIssuer.VIA_CARD: _("Card on site (SumUp)"),
    PosInvoiceIssuer.VIA_CASH: _("Cash"),
}


def via_label(via, drawer=None):
    if via == PosInvoiceIssuer.VIA_CASH and drawer is not None:
        return _("Cash, drawer “{name}”").format(name=drawer.name)
    return VIA_LABELS[via]


@dataclass
class Issued:
    """An invoice as the invoices page and its files read it."""

    invoice: Invoice
    gross: Decimal
    tax: Decimal
    association_id: int | None
    via: str
    drawer_id: int | None


def invoices_of(event, testmode=False):
    """
    Every invoice of ``event``, test mode apart, with its figures and its seller.

    Each with its total and tax, from its lines. One issued in the event's name
    is given the kind of money it was for all the same, read from the order as
    :func:`seller_of` reads it, so that the page can say which money nobody
    invoices yet.
    """
    # Quantized: pretix keeps line amounts with their trailing zeros stripped.
    totals = {
        row["invoice"]: ((row["gross"] or ZERO).quantize(CENT), (row["tax"] or ZERO).quantize(CENT))
        for row in InvoiceLine.objects.filter(invoice__event=event)
        .order_by()
        .values("invoice")
        .annotate(gross=Sum("gross_value"), tax=Sum("tax_value"))
    }
    invoices = list(
        Invoice.objects.filter(event=event, order__testmode=testmode)
        .select_related("order__sales_channel", "openpos_issuer")
        .order_by("date", "pk")
    )

    def issuer(invoice):
        return getattr(invoice, "openpos_issuer", None)

    def from_a_till(invoice):
        return invoice.order.sales_channel.identifier == POS_CHANNEL

    sales = {
        row["order_id"]: row
        for row in PosSale.objects.filter(
            event=event,
            kind=PosSale.KIND_SALE,
            order_id__in=[
                invoice.order_id for invoice in invoices
                if issuer(invoice) is None and from_a_till(invoice)
            ],
        ).values("order_id", "payment_type", "drawer_session__drawer")
    }
    result = []
    for invoice in invoices:
        gross, tax = totals.get(invoice.pk, (ZERO, ZERO))
        known = issuer(invoice)
        if known is not None:
            association_id, via, drawer_id = known.association_id, known.via, known.drawer_id
        elif not from_a_till(invoice):
            association_id, via, drawer_id = None, PosInvoiceIssuer.VIA_ONLINE, None
        else:
            sale = sales.get(invoice.order_id) or {}
            association_id = None
            if sale.get("payment_type") == PosSale.PAYMENT_CARD:
                via, drawer_id = PosInvoiceIssuer.VIA_CARD, None
            else:
                via, drawer_id = PosInvoiceIssuer.VIA_CASH, sale.get("drawer_session__drawer")
        result.append(Issued(invoice, gross, tax, association_id, via, drawer_id))
    return result


#: The order a group lists how the money came in.
VIA_ORDER = (PosInvoiceIssuer.VIA_ONLINE, PosInvoiceIssuer.VIA_CARD, PosInvoiceIssuer.VIA_CASH)


def report(event):
    """
    The invoices of ``event``, by the association that issued them and by how
    the money came in: a group per association that issued any, then one for
    what went out in the event's name. Each group adds up to the money its
    association invoiced, credit notes included.
    """
    associations = {
        association.pk: association
        for association in PosAssociation.objects.filter(organizer=event.organizer)
    }
    drawers = {
        drawer.pk: drawer for drawer in PosDrawer.objects.filter(organizer=event.organizer)
    }
    groups = defaultdict(
        lambda: defaultdict(lambda: {"invoices": 0, "credit_notes": 0, "total": ZERO})
    )
    for issued in invoices_of(event):
        line = groups[issued.association_id][(issued.via, issued.drawer_id)]
        line["credit_notes" if issued.invoice.is_cancellation else "invoices"] += 1
        line["total"] += issued.gross

    result = []
    for association_id, lines in groups.items():
        association = associations.get(association_id)
        rows = [
            {"via": via, "drawer": drawers.get(drawer_id),
             "label": via_label(via, drawers.get(drawer_id)), **figures}
            for (via, drawer_id), figures in lines.items()
        ]
        rows.sort(key=lambda row: (
            VIA_ORDER.index(row["via"]), row["drawer"].name.lower() if row["drawer"] else "",
        ))
        result.append(
            {
                "association": association,
                "key": str(association.pk) if association is not None else "event",
                "lines": rows,
                "invoices": sum(row["invoices"] for row in rows),
                "credit_notes": sum(row["credit_notes"] for row in rows),
                "total": sum((row["total"] for row in rows), ZERO),
            }
        )
    result.sort(key=lambda group: (
        group["association"] is None,
        group["association"].name.lower() if group["association"] else "",
    ))
    return result
