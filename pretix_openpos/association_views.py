"""
The associations in the back office: who they are, and each one's statement.

Two screens, one at each level, for the same reason as everywhere else in
this plugin:

- **Associations**, on the organizer: the list of associations that share the
  evenings, and whose account holds the money that does not stay with its
  owner — the SumUp account's, and each drawer's. Behind the permission to
  change the organizer's settings, like the card readers page: saying whose
  account a card payment is owed from is a decision about the association's
  money.
- **Statements**, on the event: which association counts the online sales,
  the door and the bar, and then each one's share of the evening — what it
  sold, its deposits, its cash, card and online money, and the transfers
  that settle what one holds of another's. Read by whoever may read the
  orders; set by whoever may change the event's settings.
"""
import csv

from django import forms
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import F
from django.http import Http404, StreamingHttpResponse
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.generic import TemplateView
from pretix.control.permissions import EventPermissionRequiredMixin, OrganizerPermissionRequiredMixin
from pretix.control.views.organizer import OrganizerDetailViewMixin

from .associations import (
    ONLINE_HOLDER_SETTING, PART_LABELS, PARTS, SHARE_SETTINGS, SUMUP_HOLDER_SETTING, association_named, online_holder,
    set_setting, shares, sumup_holder, uses,
)
from .models import PosAssociation, PosDrawer
from .statements import VIA_DRAWER, VIA_ONLINE, VIA_READER, statement
from .views import Echo, text_cell


class AssociationForm(forms.Form):
    name = forms.CharField(label=_("Name"), max_length=190)

    def __init__(self, *args, organizer, instance=None, **kwargs):
        self.organizer = organizer
        self.instance = instance
        if instance is not None:
            kwargs.setdefault("initial", {"name": instance.name})
        super().__init__(*args, **kwargs)

    def clean_name(self):
        name = self.cleaned_data["name"]
        clash = PosAssociation.objects.filter(organizer=self.organizer, name__iexact=name)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        if clash.exists():
            raise forms.ValidationError(
                _("There is already an association called “{name}”.").format(name=name)
            )
        return name


def _name(association):
    return association.name if association is not None else None


class AssociationsView(OrganizerDetailViewMixin, OrganizerPermissionRequiredMixin, TemplateView):
    """The associations of the organizer, and whose account holds what."""

    template_name = "pretix_openpos/associations.html"
    #: The one the card readers page asks: this page says whose account the
    #: card payments are owed from, which is the same kind of decision.
    permission = "organizer.settings.general:write"

    def _drawers(self):
        # Archived ones too, after the others: the statements of the evenings
        # they were used on still read who kept their cash.
        return (
            PosDrawer.objects.filter(organizer=self.request.organizer)
            .select_related("held_by")
            .order_by(F("archived_at").asc(nulls_first=True), "name", "pk")
        )

    def get_context_data(self, create_form=None, edit_form=None, **kwargs):
        ctx = super().get_context_data(**kwargs)
        organizer = self.request.organizer
        associations = list(PosAssociation.objects.filter(organizer=organizer))
        ctx["rows"] = [
            {
                "association": association,
                "uses": uses(association),
                "form": (
                    edit_form
                    if edit_form is not None and edit_form.instance.pk == association.pk
                    else AssociationForm(
                        organizer=organizer, instance=association, prefix=f"a{association.pk}"
                    )
                ),
            }
            for association in associations
        ]
        ctx["associations"] = associations
        ctx["create_form"] = create_form or AssociationForm(organizer=organizer, prefix="new")
        ctx["sumup_holder"] = sumup_holder(organizer)
        ctx["drawers"] = list(self._drawers())
        ctx["drawers_url"] = reverse(
            "plugins:pretix_openpos:drawers", kwargs={"organizer": organizer.slug}
        )
        return ctx

    def post(self, request, *args, **kwargs):
        organizer = request.organizer
        action = request.POST.get("action")

        if action == "create":
            form = AssociationForm(request.POST, organizer=organizer, prefix="new")
            if not form.is_valid():
                return self.render_to_response(self.get_context_data(create_form=form))
            association = PosAssociation.objects.create(
                organizer=organizer, name=form.cleaned_data["name"]
            )
            organizer.log_action(
                "pretix_openpos.association.created",
                user=request.user,
                data={"association": association.pk, "name": association.name},
            )
            messages.success(
                request,
                _("“{name}” has been added. Say which parts of an evening it counts on the "
                  "statements page of each event.").format(name=association.name),
            )
            return redirect(request.path)

        if action == "holders":
            return self._save_holders(request)

        pk = request.POST.get("association") or ""
        association = (
            PosAssociation.objects.filter(organizer=organizer, pk=pk).first()
            if pk.isdigit() else None
        )
        if association is None:
            raise Http404()

        if action == "delete":
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
            organizer.log_action(
                "pretix_openpos.association.deleted",
                user=request.user,
                data={"association": association.pk, "name": association.name},
            )
            association.delete()
            messages.success(request, _("The association has been deleted."))
            return redirect(request.path)

        if action != "save":
            raise Http404()
        form = AssociationForm(
            request.POST, organizer=organizer, instance=association, prefix=f"a{association.pk}"
        )
        if not form.is_valid():
            return self.render_to_response(self.get_context_data(edit_form=form))
        before = association.name
        if form.cleaned_data["name"] != before:
            association.name = form.cleaned_data["name"]
            association.save(update_fields=["name"])
            organizer.log_action(
                "pretix_openpos.association.changed",
                user=request.user,
                data={"association": association.pk, "name": association.name, "name_before": before},
            )
        messages.success(request, _("The association has been saved."))
        return redirect(request.path)

    def _save_holders(self, request):
        """Whose account the SumUp money, and each drawer's cash, ends up in."""
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
        messages.success(request, _("Who holds the money has been saved."))
        return redirect(request.path)


#: How each reason a euro is with somebody else is said, next to a transfer.
WHY = {
    VIA_READER: _("card payments on the SumUp account"),
    VIA_DRAWER: _("cash in the drawer “{which}”"),
    VIA_ONLINE: _("online payments"),
}


def why(detail):
    return str(WHY[detail["why"]]).format(which=detail["which"])


class StatementsView(EventPermissionRequiredMixin, TemplateView):
    """
    Each association's share of the evening, and who owes whom.

    In a series, one date: the one asked for, tonight's otherwise, or all of
    them — the same choice as the arrivals page, and for the same reason: the
    online sales belong to the date their tickets are for, not to the day
    they were bought.
    """

    template_name = "pretix_openpos/statements.html"
    permission = "event.orders:read"
    #: What saving who counts what asks: it changes how every figure on the
    #: page is shared out, which is the event's settings, not its orders.
    configure_permission = "event.settings.general:write"

    def can_configure(self):
        return self.request.user.has_event_permission(
            self.request.organizer, self.request.event, self.configure_permission,
            request=self.request,
        )

    def chosen_subevent(self):
        """
        ``(subevent, whole series?)``: a date, or ``None`` for a plain event or every date.

        Asked as ``date`` rather than as the arrivals page's ``subevent``:
        pretix reads a ``subevent`` in the query string of any page of the
        event as a date's id, for its own menus, and fails on "all".
        """
        from .api.evenings import evening_subevent

        event = self.request.event
        if not event.has_subevents:
            return None, False
        raw = self.request.GET.get("date", "")
        if raw == "all":
            return None, True
        if raw.isdigit():
            asked = event.subevents.filter(pk=int(raw)).first()
            if asked is not None:
                return asked, False
        subevent = evening_subevent(event)
        return subevent, subevent is None

    def get(self, request, *args, **kwargs):
        if request.GET.get("export") == "csv":
            return self._export_csv()
        return super().get(request, *args, **kwargs)

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        event = self.request.event
        organizer = self.request.organizer
        subevent, whole = self.chosen_subevent()
        ctx["subevent"] = subevent
        ctx["whole_series"] = whole
        ctx["subevents"] = (
            list(event.subevents.order_by("-date_from")[:200]) if event.has_subevents else []
        )
        report = statement(event, subevent)
        for line in report["transfers"]:
            for detail in line["details"]:
                detail["why_text"] = why(detail)
        ctx["report"] = report
        ctx["currency"] = event.currency
        ctx["associations"] = list(PosAssociation.objects.filter(organizer=organizer))
        current = shares(event)
        ctx["parts"] = [
            {
                "part": part,
                "label": PART_LABELS[part],
                "field": f"share_{part}",
                "association": current.get(part),
            }
            for part in PARTS
        ]
        ctx["online_holder"] = online_holder(event)
        ctx["can_configure"] = self.can_configure()
        ctx["associations_url"] = (
            reverse("plugins:pretix_openpos:associations", kwargs={"organizer": organizer.slug})
            if self.request.user.has_organizer_permission(
                organizer, AssociationsView.permission, request=self.request
            )
            else None
        )
        ctx["categories_url"] = reverse(
            "plugins:pretix_openpos:categories",
            kwargs={"organizer": organizer.slug, "event": event.slug},
        )
        query = (
            "all" if whole and event.has_subevents
            else str(subevent.pk) if subevent is not None else ""
        )
        ctx["export_query"] = f"?export=csv&date={query}" if query else "?export=csv"
        return ctx

    def post(self, request, *args, **kwargs):
        if not self.can_configure():
            raise PermissionDenied()
        event = request.event
        organizer = request.organizer

        picks = {}
        for part in PARTS:
            value = request.POST.get(f"share_{part}") or ""
            picks[part] = association_named(organizer, value) if value else None
            if value and picks[part] is None:
                messages.error(request, _("One of the associations chosen no longer exists."))
                return redirect(request.get_full_path())
        value = request.POST.get("online_holder") or ""
        holder = association_named(organizer, value) if value else None
        if value and holder is None:
            messages.error(request, _("One of the associations chosen no longer exists."))
            return redirect(request.get_full_path())

        current = shares(event)
        changed = []
        for part in PARTS:
            if _name(current.get(part)) != _name(picks[part]):
                set_setting(event.settings, SHARE_SETTINGS[part], picks[part])
                changed.append(
                    {"part": part, "name": _name(picks[part]), "name_before": _name(current.get(part))}
                )
        before = online_holder(event)
        if _name(before) != _name(holder):
            set_setting(event.settings, ONLINE_HOLDER_SETTING, holder)
            changed.append({"part": "online_holder", "name": _name(holder), "name_before": _name(before)})
        if changed:
            event.log_action(
                "pretix_openpos.shares.changed", user=request.user, data={"changed": changed}
            )
        messages.success(request, _("Who counts what has been saved."))
        return redirect(request.get_full_path())

    def _export_csv(self):
        """
        The statement as one file, a line per figure, for each association's books.

        A line per product, fee, deposit and payment type of every share, then
        one per transfer, so a spreadsheet can filter one association's lines
        and sum them. Semicolons behind a BOM and amounts with a dot, like the
        journal's export next door.
        """
        event = self.request.event
        subevent, whole = self.chosen_subevent()
        report = statement(event, subevent)
        header = [
            "association", "parts", "kind", "category", "product", "variation",
            "count", "amount", "counterpart",
        ]

        def rows():
            writer = csv.writer(Echo(), delimiter=";")
            yield "﻿"
            yield writer.writerow(header)
            for share in report["shares"]:
                who = [text_cell(share["label"]), text_cell(", ".join(share["parts"]))]
                for group in share["categories"]:
                    for item in group["items"]:
                        yield writer.writerow(who + [
                            "product",
                            text_cell(group["name"] or ""),
                            text_cell(item["name"]),
                            text_cell(item["variation_name"] or ""),
                            item["count"],
                            item["total"],
                            "",
                        ])
                for fee in share["fees"]:
                    yield writer.writerow(
                        who + ["fee", "", text_cell(fee["name"]), "", fee["count"], fee["total"], ""]
                    )
                if share["deposits"]:
                    for kind in ("taken", "returned"):
                        figures = share["deposits"][kind]
                        yield writer.writerow(
                            who + [f"deposit_{kind}", "", "", "", figures["count"], figures["total"], ""]
                        )
                if share["unallocated"]:
                    yield writer.writerow(who + ["unallocated", "", "", "", "", share["unallocated"], ""])
                for kind in ("cash", "card", "online"):
                    if share[kind]:
                        yield writer.writerow(who + [kind, "", "", "", "", share[kind], ""])
            for line in report["transfers"]:
                yield writer.writerow([
                    text_cell(line["payer"].name), "", "transfer", "", "", "", "",
                    line["amount"], text_cell(line["payee"].name),
                ])

        response = StreamingHttpResponse(rows(), content_type="text/csv; charset=utf-8")
        span = (
            f"-{subevent.date_from.astimezone(event.timezone).date().isoformat()}"
            if subevent is not None else "-all" if whole else ""
        )
        response["Content-Disposition"] = (
            f'attachment; filename="openpos-statements-{event.slug}{span}.csv"'
        )
        return response
