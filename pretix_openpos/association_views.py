"""
The associations in the back office: who each one is on an invoice, and what
each one invoiced.

Three screens:

- **Associations**, on the organizer: the list, whether each is ready to
  invoice, and who invoices the money that arrives on site — the cards taken on
  the SumUp account, the cash of each drawer. Behind the permission to change
  the organizer's settings, like the card readers page: saying whose account a
  payment lands in decides whose name its invoice goes out in.
- **An association**, on the organizer: what its invoices say about it — name,
  address, SIRET, VAT number, legal wording — and what its numbers start with.
  Same permission.
- **Invoices by association**, on the event: who invoices the online ticketing,
  whether the event starts a numbering of its own, and then every invoice of
  the event by the association that issued it and by how the money came in,
  with each one's list and PDFs to download. Read by whoever may read the
  orders; set by whoever may change the event's invoicing settings.
"""
import csv
import tempfile
from zipfile import ZIP_DEFLATED, ZipFile

from django import forms
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import F
from django.http import FileResponse, Http404, StreamingHttpResponse
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.functional import cached_property
from django.utils.text import slugify
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from django.views.generic import TemplateView
from pretix.base.models import Invoice
from pretix.base.settings import country_choice_kwargs
from pretix.control.permissions import EventPermissionRequiredMixin, OrganizerPermissionRequiredMixin
from pretix.control.views.organizer import OrganizerDetailViewMixin

from .associations import (
    ONLINE_SETTING, SERIES_SETTING, SUMUP_HOLDER_SETTING, association_named, event_series, online_invoicer,
    prefix_validator, set_setting, sumup_holder, uses,
)
from .issuers import invoices_of, report
from .models import PosAssociation, PosDrawer, PosInvoiceIssuer
from .views import Echo, text_cell

#: pretix' number of digits after the prefix, when an event says nothing else.
DEFAULT_COUNTER_LENGTH = 5

#: The longest part an event may put between a prefix and its numbers.
SERIES_MAX_LENGTH = 50


def _name(association):
    return association.name if association is not None else None


def example_number(prefix, event=None):
    """The first number a prefix gives, as an invoice would show it."""
    length = DEFAULT_COUNTER_LENGTH
    if event is not None:
        length = event.settings.get("invoice_numbers_counter_length", as_type=int) or length
    if "%" in prefix:
        prefix = now().strftime(prefix)
    return prefix + "1".zfill(length)


class AssociationForm(forms.ModelForm):
    """What an association's invoices say about it."""

    class Meta:
        model = PosAssociation
        fields = (
            "name", "address", "zipcode", "city", "country", "siret", "vat_id",
            "invoice_prefix", "invoice_footer",
        )
        widgets = {
            "address": forms.Textarea(attrs={"rows": 2}),
            "invoice_footer": forms.Textarea(attrs={"rows": 3}),
        }
        help_texts = {
            "name": _("As printed at the top of its invoices."),
            "siret": _("Printed at the foot of its invoices."),
            "vat_id": _("Only if it is registered for VAT. Printed under its address."),
            "invoice_prefix": _(
                "Its invoice numbers start with this, then follow on from one event to the "
                "next: PORT- gives PORT-00001, PORT-00002… An event can start its own series "
                "from its invoices page. Changing the prefix starts a new series; invoices "
                "already issued keep their numbers. %Y puts in the year."
            ),
            "invoice_footer": _(
                "Printed at the foot of every page, under the SIRET, instead of the event's "
                "footer — for example “Association loi 1901 · TVA non applicable, art. 293 B "
                "du CGI”. One short line per mention: pretix does not wrap these lines."
            ),
        }

    def __init__(self, *args, organizer, **kwargs):
        self.organizer = organizer
        super().__init__(*args, **kwargs)
        self.fields["country"] = forms.ChoiceField(
            label=_("Country"), required=True, **country_choice_kwargs()
        )
        for name in PosAssociation.REQUIRED:
            self.fields[name].required = True
        self.fields["invoice_prefix"].validators.append(prefix_validator)

    def clean_name(self):
        name = self.cleaned_data["name"].strip()
        clash = PosAssociation.objects.filter(organizer=self.organizer, name__iexact=name)
        if self.instance.pk:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise forms.ValidationError(
                _("There is already an association called “{name}”.").format(name=name)
            )
        return name

    def clean_invoice_prefix(self):
        prefix = self.cleaned_data["invoice_prefix"].strip()
        others = PosAssociation.objects.filter(
            organizer=self.organizer, invoice_prefix__iexact=prefix
        )
        if self.instance.pk:
            others = others.exclude(pk=self.instance.pk)
        taken = others.first()
        if taken is not None:
            raise forms.ValidationError(
                _("“{name}” already numbers its invoices with this prefix.").format(name=taken.name)
            )
        # Numbers follow on per prefix: one that invoices in anybody else's
        # name already use would start this association's series in the middle
        # of theirs.
        written = now().strftime(prefix) if "%" in prefix else prefix
        issued = Invoice.objects.filter(
            organizer=self.organizer, prefix__in=[written, written + "TEST-"]
        )
        if self.instance.pk:
            issued = issued.exclude(openpos_issuer__association_id=self.instance.pk)
        if issued.exists():
            raise forms.ValidationError(
                _("Invoices numbered with this prefix already exist in another name. Choose "
                  "another one, so that this association's numbers start from 1.")
            )
        return prefix


class AssociationsMixin(OrganizerDetailViewMixin, OrganizerPermissionRequiredMixin):
    #: The one the card readers page asks: these pages say whose account the
    #: money lands in, and so in whose name its invoices go out.
    permission = "organizer.settings.general:write"

    def list_url(self):
        return reverse(
            "plugins:pretix_openpos:associations",
            kwargs={"organizer": self.request.organizer.slug},
        )


class AssociationsView(AssociationsMixin, TemplateView):
    """The associations of the organizer, and who invoices what is taken on site."""

    template_name = "pretix_openpos/associations.html"

    def _drawers(self):
        # Archived ones too, after the others: one can be brought back, and
        # its cash is then invoiced by whoever keeps it.
        return (
            PosDrawer.objects.filter(organizer=self.request.organizer)
            .select_related("held_by")
            .order_by(F("archived_at").asc(nulls_first=True), "name", "pk")
        )

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        organizer = self.request.organizer
        associations = list(PosAssociation.objects.filter(organizer=organizer))
        last = {
            issuer.association_id: issuer.invoice
            for issuer in PosInvoiceIssuer.objects.filter(association__organizer=organizer)
            .select_related("invoice")
            .order_by("invoice_id")
        }
        ctx["rows"] = [
            {
                "association": association,
                "missing": association.missing(),
                "uses": uses(association),
                "last": last.get(association.pk),
                "url": reverse(
                    "plugins:pretix_openpos:association",
                    kwargs={"organizer": organizer.slug, "association": association.pk},
                ),
            }
            for association in associations
        ]
        ctx["associations"] = associations
        ctx["new_url"] = reverse(
            "plugins:pretix_openpos:association.new", kwargs={"organizer": organizer.slug}
        )
        ctx["sumup_holder"] = sumup_holder(organizer)
        ctx["drawers"] = list(self._drawers())
        ctx["drawers_url"] = reverse(
            "plugins:pretix_openpos:drawers", kwargs={"organizer": organizer.slug}
        )
        return ctx

    def post(self, request, *args, **kwargs):
        if request.POST.get("action") != "holders":
            raise Http404()
        organizer = request.organizer

        def chosen(field):
            value = request.POST.get(field) or ""
            if not value:
                return None, True
            association = association_named(organizer, value)
            return association, association is not None

        sumup, known = chosen("sumup_holder")
        drawers = list(self._drawers())
        picks = {}
        for drawer in drawers:
            picks[drawer.pk], ok = chosen(f"drawer_{drawer.pk}")
            known = known and ok
        if not known:
            # A hand-made POST, or a form older than a deletion. Nothing is
            # written either way.
            messages.error(request, _("One of the associations chosen no longer exists."))
            return redirect(request.path)

        changed = []
        with transaction.atomic():
            before = sumup_holder(organizer)
            if _name(before) != _name(sumup):
                set_setting(organizer.settings, SUMUP_HOLDER_SETTING, sumup)
                changed.append({"what": "sumup", "name": _name(sumup), "name_before": _name(before)})
            for drawer in drawers:
                pick = picks[drawer.pk]
                if drawer.held_by_id != (pick.pk if pick else None):
                    changed.append(
                        {
                            "what": "drawer",
                            "drawer": drawer.pk,
                            "drawer_name": drawer.name,
                            "name": _name(pick),
                            "name_before": _name(drawer.held_by),
                        }
                    )
                    drawer.held_by = pick
                    drawer.save(update_fields=["held_by"])
        if changed:
            organizer.log_action(
                "pretix_openpos.holders.changed", user=request.user, data={"changed": changed}
            )
        messages.success(request, _("Who invoices what is taken on site has been saved."))
        return redirect(request.path)


class AssociationView(AssociationsMixin, TemplateView):
    """One association: what its invoices say about it, and its numbering."""

    template_name = "pretix_openpos/association.html"

    @cached_property
    def association(self):
        pk = self.kwargs.get("association")
        if pk is None:
            return None
        association = PosAssociation.objects.filter(
            organizer=self.request.organizer, pk=pk
        ).first()
        if association is None:
            raise Http404()
        return association

    def form(self, data=None):
        # A copy of the row, never the one the page shows: validating a model
        # form writes what was posted onto its instance, rejected or not.
        instance = (
            PosAssociation.objects.get(pk=self.association.pk)
            if self.association is not None
            else PosAssociation(organizer=self.request.organizer)
        )
        return AssociationForm(data, organizer=self.request.organizer, instance=instance)

    def get_context_data(self, form=None, **kwargs):
        ctx = super().get_context_data(**kwargs)
        association = self.association
        ctx["association"] = association
        ctx["form"] = form or self.form()
        ctx["uses"] = uses(association) if association is not None else []
        ctx["missing"] = association.missing() if association is not None else []
        ctx["list_url"] = self.list_url()
        return ctx

    def post(self, request, *args, **kwargs):
        association = self.association
        action = request.POST.get("action")
        if action == "delete" and association is not None:
            return self._delete(request, association)
        if action != "save":
            raise Http404()

        before = association.name if association is not None else None
        form = self.form(request.POST)
        if not form.is_valid():
            return self.render_to_response(self.get_context_data(form=form))
        saved = form.save()
        if association is None:
            request.organizer.log_action(
                "pretix_openpos.association.created",
                user=request.user,
                data={"association": saved.pk, "name": saved.name},
            )
            messages.success(
                request,
                _("“{name}” has been added. Say below what it invoices on site, and on the "
                  "invoices page of an event if it invoices the online ticketing.").format(
                    name=saved.name
                ),
            )
        else:
            if form.changed_data:
                request.organizer.log_action(
                    "pretix_openpos.association.changed",
                    user=request.user,
                    data={
                        "association": saved.pk,
                        "name": saved.name,
                        "name_before": before,
                        "fields": list(form.changed_data),
                    },
                )
            messages.success(request, _("The association has been saved."))
        return redirect(self.list_url())

    def _delete(self, request, association):
        still = uses(association)
        if still:
            messages.error(
                request,
                " ".join(
                    [str(_("“{name}” is still in use, so it stays.").format(name=association.name))]
                    + [str(line) for line in still]
                ),
            )
            return redirect(request.path)
        request.organizer.log_action(
            "pretix_openpos.association.deleted",
            user=request.user,
            data={"association": association.pk, "name": association.name},
        )
        association.delete()
        messages.success(request, _("The association has been deleted."))
        return redirect(self.list_url())


def invoicing_state(association):
    """
    Whether ``association`` gets the invoices it is named for, and why not.

    ``None`` is somebody nobody named; one whose profile lacks what an
    invoice needs is named but not used yet. Either way its money is invoiced
    in the event's name meanwhile.
    """
    if association is None:
        return {"ready": False, "association": None, "missing": []}
    missing = association.missing()
    return {"ready": not missing, "association": association, "missing": missing}


class InvoicesView(EventPermissionRequiredMixin, TemplateView):
    """
    Every invoice of the event, by the association that issued it.

    A whole event rather than a date of a series: an invoice belongs to an
    order, and an order bought online can hold tickets for several dates.
    """

    template_name = "pretix_openpos/invoices.html"
    permission = "event.orders:read"
    #: What saving who invoices the online ticketing, or the event's numbering,
    #: asks: both decide how the event's invoices are made.
    configure_permission = "event.settings.invoicing:write"

    def can_configure(self):
        return self.request.user.has_event_permission(
            self.request.organizer, self.request.event, self.configure_permission,
            request=self.request,
        )

    def get(self, request, *args, **kwargs):
        export = request.GET.get("export")
        if export in ("csv", "pdf"):
            return self._export(export, request.GET.get("association") or "")
        return super().get(request, *args, **kwargs)

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        event = self.request.event
        organizer = self.request.organizer
        associations = list(PosAssociation.objects.filter(organizer=organizer))
        online = online_invoicer(event)
        ctx["associations"] = associations
        ctx["online"] = online
        ctx["online_state"] = invoicing_state(online)
        ctx["sumup_state"] = invoicing_state(sumup_holder(organizer))
        ctx["drawers"] = [
            {"drawer": drawer, "state": invoicing_state(drawer.held_by)}
            for drawer in PosDrawer.objects.filter(organizer=organizer, archived_at__isnull=True)
            .select_related("held_by")
        ]
        series = event_series(event)
        ready = [association for association in associations if association.can_issue]
        sample = ready[0].invoice_prefix if ready else "PORT-"
        ctx["series"] = series
        ctx["series_max_length"] = SERIES_MAX_LENGTH
        ctx["continued_example"] = example_number(sample, event)
        ctx["series_example"] = example_number(sample + (series or "SOIREE-"), event)

        channels = event.settings.get("invoice_generate_sales_channels", as_type=list) or ["web"]
        ctx["webshop_invoices_off"] = (
            event.settings.get("invoice_generate") not in ("True", "paid") or "web" not in channels
        )
        ctx["invoice_settings_url"] = reverse(
            "control:event.settings.invoice",
            kwargs={"organizer": organizer.slug, "event": event.slug},
        )
        ctx["groups"] = report(event)
        ctx["testmode_count"] = Invoice.objects.filter(event=event, order__testmode=True).count()
        ctx["currency"] = event.currency
        ctx["can_configure"] = self.can_configure()
        ctx["associations_url"] = (
            reverse("plugins:pretix_openpos:associations", kwargs={"organizer": organizer.slug})
            if self.request.user.has_organizer_permission(
                organizer, AssociationsView.permission, request=self.request
            )
            else None
        )
        return ctx

    def post(self, request, *args, **kwargs):
        if not self.can_configure():
            raise PermissionDenied()
        event = request.event
        organizer = request.organizer

        value = request.POST.get("online") or ""
        online = association_named(organizer, value) if value else None
        if value and online is None:
            messages.error(request, _("One of the associations chosen no longer exists."))
            return redirect(request.path)
        series = (request.POST.get("series") or "").strip()
        if len(series) > SERIES_MAX_LENGTH:
            messages.error(request, _("The event's part of the numbers is too long."))
            return redirect(request.path)
        if series:
            try:
                prefix_validator(series)
            except forms.ValidationError as error:
                messages.error(request, " ".join(str(message) for message in error.messages))
                return redirect(request.path)

        changed = []
        before = online_invoicer(event)
        if _name(before) != _name(online):
            set_setting(event.settings, ONLINE_SETTING, online)
            changed.append({"what": "online", "name": _name(online), "name_before": _name(before)})
        series_before = event_series(event)
        if series != series_before:
            if series:
                event.settings.set(SERIES_SETTING, series)
            else:
                event.settings.delete(SERIES_SETTING)
            changed.append({"what": "series", "value": series, "value_before": series_before})
        if changed:
            event.log_action(
                "pretix_openpos.invoicing.changed", user=request.user, data={"changed": changed}
            )
        messages.success(request, _("Who invoices what has been saved."))
        return redirect(request.path)

    def _export(self, kind, key):
        """One group of the page as a file: an association's invoices, or the event's."""
        event = self.request.event
        if key == "event":
            association, who = None, "event"
        else:
            association = association_named(event.organizer, key)
            if association is None:
                raise Http404()
            who = slugify(association.name) or str(association.pk)
        issued = [
            item for item in invoices_of(event)
            if item.association_id == (association.pk if association is not None else None)
        ]
        name = f"openpos-invoices-{event.slug}-{who}"
        if kind == "pdf":
            return self._export_pdf(issued, name)
        return self._export_csv(issued, name)

    def _export_csv(self, issued, name):
        """
        One group's invoices, a line each, for the association's books.

        Semicolons behind a BOM and amounts with a dot, like the journal's
        export; net, tax and total as the invoice's own lines add them up.
        """
        drawers = {
            drawer.pk: drawer
            for drawer in PosDrawer.objects.filter(organizer=self.request.organizer)
        }
        header = ["number", "date", "kind", "order", "money", "drawer", "net", "tax", "gross"]

        def rows():
            writer = csv.writer(Echo(), delimiter=";")
            yield "﻿"
            yield writer.writerow(header)
            for item in issued:
                invoice = item.invoice
                drawer = drawers.get(item.drawer_id)
                yield writer.writerow([
                    text_cell(invoice.number),
                    invoice.date.isoformat(),
                    "credit_note" if invoice.is_cancellation else "invoice",
                    invoice.order.code,
                    item.via,
                    text_cell(drawer.name) if drawer is not None else "",
                    item.gross - item.tax,
                    item.tax,
                    item.gross,
                ])

        response = StreamingHttpResponse(rows(), content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = f'attachment; filename="{name}.csv"'
        return response

    def _export_pdf(self, issued, name):
        """
        One group's invoices as their PDFs, in one ZIP, the way pretix' own
        export of every invoice makes it: a PDF never rendered is rendered now.
        """
        spool = tempfile.SpooledTemporaryFile(max_size=16 * 1024 * 1024)
        with ZipFile(spool, "w", ZIP_DEFLATED) as archive:
            for item in issued:
                invoice = item.invoice
                content = None if invoice.shredded else pdf_of(invoice)
                if content is not None:
                    filename = f"{invoice.number}-{invoice.order.code}.pdf".replace("/", "-")
                    archive.writestr(filename, content)
        spool.seek(0)
        return FileResponse(
            spool, as_attachment=True, filename=f"{name}.zip", content_type="application/zip"
        )


def pdf_of(invoice):
    """The PDF of ``invoice``, rendered again if it never was or its file is gone."""
    from pretix.base.services.invoices import invoice_pdf_task

    for attempt in range(2):
        if attempt or not invoice.file:
            invoice_pdf_task.apply(args=(invoice.pk,))
            invoice.refresh_from_db()
        if invoice.file:
            try:
                with invoice.file.open("rb") as handle:
                    return handle.read()
            except FileNotFoundError:
                continue
    return None
