import csv
from collections import OrderedDict
from decimal import Decimal, InvalidOperation

from django.contrib import messages
from django.db import transaction
from django.db.models import Count, Min, Sum
from django.http import StreamingHttpResponse
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.generic import ListView, TemplateView
from pretix.base.models import Event
from pretix.control.permissions import EventPermissionRequiredMixin
from pretix.control.views.event import EventSettingsFormView, EventSettingsViewMixin

from .forms import OpenPosSettingsForm
from .models import PosPrice, PosSale


class SettingsView(EventSettingsViewMixin, EventSettingsFormView):
    model = Event
    form_class = OpenPosSettingsForm
    template_name = "pretix_openpos/settings.html"
    permission = "event.settings.general:write"

    def get_success_url(self) -> str:
        return reverse(
            "plugins:pretix_openpos:settings",
            kwargs={
                "organizer": self.request.event.organizer.slug,
                "event": self.request.event.slug,
            },
        )


class PricesView(EventPermissionRequiredMixin, TemplateView):
    """
    Edit the on-site tariff.

    Rendered as a plain table rather than a formset: there is one number input
    per sellable line and an empty box simply means "charge the online price",
    which is both the default and the thing an organizer most often wants to go
    back to.
    """

    template_name = "pretix_openpos/prices.html"
    # Namespaced permission names, not the legacy can_* attributes: an unknown
    # string is simply never in the permission set, so it locks out every team
    # that is not all-powerful while looking like it works to an admin.
    permission = "event.items:write"

    def _rows(self):
        """Every sellable line of the event, with its current override."""
        overrides = {
            (p.item_id, p.variation_id): p
            for p in PosPrice.objects.filter(event=self.request.event)
        }
        rows = OrderedDict()
        items = (
            self.request.event.items.all()
            .select_related("category")
            .prefetch_related("variations")
            .order_by("category__position", "category_id", "position", "pk")
        )
        for item in items:
            variations = [v for v in item.variations.all()]
            if variations:
                for variation in variations:
                    key = f"{item.pk}_{variation.pk}"
                    override = overrides.get((item.pk, variation.pk))
                    rows[key] = {
                        "key": key,
                        "item": item,
                        "variation": variation,
                        "label": f"{item.name} – {variation.value}",
                        "online_price": (
                            variation.default_price
                            if variation.default_price is not None
                            else item.default_price
                        ),
                        "pos_price": override.price if override else None,
                    }
            else:
                key = f"{item.pk}_"
                override = overrides.get((item.pk, None))
                rows[key] = {
                    "key": key,
                    "item": item,
                    "variation": None,
                    "label": str(item.name),
                    "online_price": item.default_price,
                    "pos_price": override.price if override else None,
                }
        return rows

    def get_context_data(self, submitted=None, **kwargs):
        ctx = super().get_context_data(**kwargs)
        rows = list(self._rows().values())
        if submitted is not None:
            # A refused form is re-rendered from what the organiser typed, not
            # from the database: nothing was written, and showing the stored
            # tariff instead would quietly throw away every other edit they made
            # alongside the one that was wrong.
            for row in rows:
                row["pos_price"] = submitted.get(f"price_{row['key']}", "")
        ctx["rows"] = rows
        ctx["currency"] = self.request.event.currency
        return ctx

    def post(self, request, *args, **kwargs):
        """
        Read the whole form, then write it — in that order, and never mixed.

        The two halves used to be one loop inside a transaction that was still
        committed when errors were reported, so a single mistyped price saved
        every other line while telling the organiser nothing had been saved.
        Parsing everything first makes the page mean what it says: either the
        tariff is what the form shows, or it is exactly what it was.
        """
        rows = self._rows()
        errors = []
        #: (row, price or None) — None meaning "charge the online price".
        parsed = []

        for key, row in rows.items():
            raw = (request.POST.get(f"price_{key}") or "").strip().replace(",", ".")

            if raw == "":
                parsed.append((row, None))
                continue

            try:
                price = Decimal(raw).quantize(Decimal("0.01"))
            except (InvalidOperation, ValueError):
                errors.append(_("{label}: “{value}” is not a valid price.").format(
                    label=row["label"], value=raw
                ))
                continue
            if price < Decimal("0.00"):
                errors.append(_("{label}: the price cannot be negative.").format(label=row["label"]))
                continue
            parsed.append((row, price))

        if errors:
            for error in errors:
                messages.error(request, error)
            # Nothing has been written, so the form is re-rendered from what the
            # organiser typed rather than from the database — which still holds
            # the old tariff and would silently discard the rest of their edits.
            return self.render_to_response(
                self.get_context_data(submitted=request.POST)
            )

        changed = 0
        with transaction.atomic():
            for row, price in parsed:
                item, variation = row["item"], row["variation"]
                if price is None:
                    deleted, _details = PosPrice.objects.filter(
                        event=request.event, item=item, variation=variation
                    ).delete()
                    changed += 1 if deleted else 0
                    continue

                obj, created = PosPrice.objects.update_or_create(
                    event=request.event, item=item, variation=variation,
                    defaults={"price": price},
                )
                if created or row["pos_price"] != price:
                    changed += 1

        request.event.log_action(
            "pretix_openpos.prices.changed", user=request.user, data={"changed": changed}
        )
        messages.success(request, _("The on-site prices have been saved."))
        return redirect(
            reverse(
                "plugins:pretix_openpos:prices",
                kwargs={
                    "organizer": request.event.organizer.slug,
                    "event": request.event.slug,
                },
            )
        )


class Echo:
    """File-like whose write() hands each CSV row straight to the stream."""

    def write(self, value):
        return value


class SalesView(EventPermissionRequiredMixin, ListView):
    """Journal of till sales, with the takings broken down per device."""

    template_name = "pretix_openpos/sales.html"
    permission = "event.orders:read"
    context_object_name = "sales"
    paginate_by = 100

    def get(self, request, *args, **kwargs):
        if request.GET.get("export") == "csv":
            return self._export_csv()
        return super().get(request, *args, **kwargs)

    def _export_csv(self):
        """
        The whole journal as one file, for whoever keeps the books.

        The journal itself, not the takings: the takings are recomputable from
        it, which is the point of exporting it whole. Streamed row by row in
        ``seq`` order; semicolon-separated behind a BOM, because the first
        thing anyone does with this file is open it in a French-locale Excel.
        Amounts keep their dots and datetimes are ISO in the event's timezone —
        data first, presentation is the spreadsheet's job.
        """
        event = self.request.event
        tz = event.timezone
        header = [
            "seq", "kind", "datetime", "order", "till", "till_serial", "cashier",
            "payment_type", "total", "cash_given", "cash_change", "testmode",
            "offline", "cancels_seq", "reason", "positions",
        ]

        def rows():
            writer = csv.writer(Echo(), delimiter=";")
            # The BOM stops Excel guessing at the encoding.
            yield "\ufeff"
            yield writer.writerow(header)
            journal = PosSale.objects.filter(event=event).order_by("seq").iterator()
            for sale in journal:
                positions = " + ".join(
                    "{}× {}{}".format(
                        line.get("count"),
                        line.get("item_name"),
                        " ({})".format(line["variation_name"]) if line.get("variation_name") else "",
                    )
                    for line in sale.positions
                )
                yield writer.writerow([
                    sale.seq,
                    sale.kind,
                    sale.datetime.astimezone(tz).isoformat(),
                    sale.order_code,
                    sale.device_name or sale.device_serial,
                    sale.device_serial,
                    sale.cashier,
                    sale.payment_type,
                    sale.total,
                    "" if sale.cash_given is None else sale.cash_given,
                    "" if sale.cash_change is None else sale.cash_change,
                    "1" if sale.testmode else "",
                    "1" if sale.offline else "",
                    "" if sale.cancels_seq is None else sale.cancels_seq,
                    sale.reason,
                    positions,
                ])

        response = StreamingHttpResponse(rows(), content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = (
            f'attachment; filename="openpos-journal-{event.slug}.csv"'
        )
        return response

    def get_queryset(self):
        return (
            PosSale.objects.filter(event=self.request.event)
            .select_related("device", "order")
            .order_by("-seq")
        )

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        all_sales = PosSale.objects.filter(event=self.request.event)

        def empty():
            return {"cash": Decimal("0.00"), "card": Decimal("0.00"), "count": 0}

        # Aggregated in the database: the journal is append-only and only ever
        # grows, and this page used to fetch every row of it just to add them
        # up. The result set here is one row per (till, cashier, payment type).
        rows = (
            all_sales.values(
                "device_name", "device_serial", "cashier", "payment_type", "testmode"
            )
            .annotate(amount=Sum("total"), n=Count("pk"), first_seq=Min("seq"))
            .order_by()
        )

        by_device = {}
        totals = empty()
        testmode_totals = empty()
        for row in rows:
            # Test-mode takings are kept out of the figures the drawer is
            # reconciled against, and shown on their own line instead. The rows
            # stay in the journal: it is append-only, and it outlives the orders
            # themselves, which get purged when test mode is switched off.
            if row["testmode"]:
                testmode_totals[row["payment_type"]] += row["amount"]
                testmode_totals["count"] += row["n"]
                continue

            label = row["device_name"] or row["device_serial"] or str(_("unknown till"))
            if row["cashier"]:
                label = f"{label} · {row['cashier']}"
            bucket = by_device.setdefault(
                label,
                {
                    "label": label,
                    "serial": row["device_serial"],
                    "first_seq": row["first_seq"],
                    **empty(),
                },
            )
            bucket[row["payment_type"]] += row["amount"]
            bucket["count"] += row["n"]
            bucket["first_seq"] = min(bucket["first_seq"], row["first_seq"])
            totals[row["payment_type"]] += row["amount"]
            totals["count"] += row["n"]

        # In the order the tills first wrote to the journal, as the row-by-row
        # version showed them.
        devices = sorted(by_device.values(), key=lambda bucket: bucket["first_seq"])
        for bucket in devices:
            bucket["total"] = bucket["cash"] + bucket["card"]
        for bag in (totals, testmode_totals):
            bag["total"] = bag["cash"] + bag["card"]

        ctx["by_device"] = devices
        ctx["totals"] = totals
        ctx["testmode_totals"] = testmode_totals if testmode_totals["count"] else None
        ctx["currency"] = self.request.event.currency
        # Surfaced so a broken chain is visible rather than silently trusted.
        # Checked from an anchored checkpoint; `manage.py openpos_verify_journal`
        # is the full audit.
        ctx["tampered_with"] = PosSale.verify_chain_cached(self.request.event)
        return ctx
