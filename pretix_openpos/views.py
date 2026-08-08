from collections import OrderedDict
from decimal import Decimal, InvalidOperation

from django.contrib import messages
from django.db import transaction
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.generic import ListView, TemplateView
from pretix.base.models import Event
from pretix.control.permissions import EventPermissionRequiredMixin
from pretix.control.views.event import (
    EventSettingsFormView, EventSettingsViewMixin,
)

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
    permission = "can_change_items"

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

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        ctx["rows"] = list(self._rows().values())
        ctx["currency"] = self.request.event.currency
        return ctx

    @transaction.atomic
    def post(self, request, *args, **kwargs):
        rows = self._rows()
        changed = 0
        errors = []

        for key, row in rows.items():
            raw = (request.POST.get(f"price_{key}") or "").strip().replace(",", ".")
            item, variation = row["item"], row["variation"]

            if raw == "":
                deleted, _details = PosPrice.objects.filter(
                    event=request.event, item=item, variation=variation
                ).delete()
                changed += 1 if deleted else 0
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

            obj, created = PosPrice.objects.update_or_create(
                event=request.event, item=item, variation=variation,
                defaults={"price": price},
            )
            if created or row["pos_price"] != price:
                changed += 1

        if errors:
            for error in errors:
                messages.error(request, error)
            return self.render_to_response(self.get_context_data())

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


class SalesView(EventPermissionRequiredMixin, ListView):
    """Journal of till sales, with the takings broken down per device."""

    template_name = "pretix_openpos/sales.html"
    permission = "can_view_orders"
    context_object_name = "sales"
    paginate_by = 100

    def get_queryset(self):
        return (
            PosSale.objects.filter(event=self.request.event)
            .select_related("device", "order")
            .order_by("-seq")
        )

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        all_sales = PosSale.objects.filter(event=self.request.event)

        by_device = OrderedDict()
        totals = {"cash": Decimal("0.00"), "card": Decimal("0.00"), "count": 0}
        for sale in all_sales.only("device_serial", "cashier", "payment_type", "total"):
            label = sale.device_serial or str(_("unknown till"))
            if sale.cashier:
                label = f"{label} · {sale.cashier}"
            bucket = by_device.setdefault(
                label, {"label": label, "cash": Decimal("0.00"), "card": Decimal("0.00"), "count": 0}
            )
            bucket[sale.payment_type] += sale.total
            bucket["count"] += 1
            totals[sale.payment_type] += sale.total
            totals["count"] += 1

        for bucket in by_device.values():
            bucket["total"] = bucket["cash"] + bucket["card"]
        totals["total"] = totals["cash"] + totals["card"]

        ctx["by_device"] = list(by_device.values())
        ctx["totals"] = totals
        ctx["currency"] = self.request.event.currency
        # Surfaced so a broken chain is visible rather than silently trusted.
        ctx["tampered_with"] = PosSale.verify_chain(self.request.event)
        return ctx
