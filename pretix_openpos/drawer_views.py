"""
Cash drawers in the back office: which exist, what each evening came to.

Organizer-level, like the devices that feed them. Three screens:

- the list, where a drawer is created for every physical drawer, named, and
  given the float it usually starts with, and where tonight's cash stands. A
  drawer that has been opened is archived rather than deleted. Which device
  feeds which drawer is said on the till devices screen, next to the device's
  role and its reader;
- one drawer's openings, evening after evening, each with the difference it
  closed on — or, for the one still running, what it should hold now;
- one opening's closing report — the "Z" — with every figure the expected
  cash is made of, and every line of its ledger. An opening a till forgot to
  close can be closed from there.

Whoever may change devices may do all of it. Whoever may read the orders of
every event may read the drawers too — a drawer's openings mix the evenings of
whichever events its tills sold for, so reading them is reading all of those.
"""
import csv
import uuid
from decimal import Decimal

from django import forms
from django.conf import settings
from django.contrib import messages
from django.core.exceptions import PermissionDenied
from django.db import transaction
from django.db.models import Count, Min, Sum
from django.http import Http404, StreamingHttpResponse
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.functional import cached_property
from django.utils.translation import gettext_lazy as _
from django.views.generic import TemplateView
from pretix.control.views.organizer import OrganizerDetailViewMixin

from .drawers import DrawerError, archive_drawer, close_drawer, figures, open_session_of, restore_drawer
from .models import PosDrawer, PosDrawerEntry, PosDrawerSession, PosSale
from .views import Echo, text_cell

#: Openings per page on a drawer's screen. One an evening, so a season.
SESSIONS_PER_PAGE = 50


def can_manage_drawers(request):
    """Create, rename, delete and force-close: the same gate as the devices."""
    return request.user.has_organizer_permission(
        request.organizer, "organizer.devices:write", request=request
    )


def can_read_drawers(request):
    """
    Read the openings and their reports.

    Whoever manages them, or whoever may read the orders of every event of
    this organizer — not merely of one: an opening holds the sales of every
    event its tills sold for.
    """
    if can_manage_drawers(request):
        return True
    readable = request.user.get_events_with_permission(
        "event.orders:read", request=request
    ).filter(organizer=request.organizer)
    return readable.exists() and not request.organizer.events.exclude(
        pk__in=readable.values("pk")
    ).exists()


def organizer_currency(organizer):
    """
    The currency a drawer's figures are shown in.

    A drawer belongs to the organizer, which has no currency of its own; its
    events do, and an association runs them all in the one it banks in. So
    the latest event's, and pretix' default before there is any event.
    """
    event = organizer.events.order_by("-date_from").first()
    return event.currency if event else settings.DEFAULT_CURRENCY


def _money_or_blank(value):
    return "" if value is None else value


class DrawerForm(forms.Form):
    name = forms.CharField(label=_("Name"), max_length=190)
    opening_float = forms.DecimalField(
        label=_("Usual opening float"),
        required=False,
        min_value=Decimal("0.00"),
        max_digits=13,
        decimal_places=2,
        localize=True,
        help_text=_("Offered on the till when the drawer is opened. What is counted then is what counts."),
    )

    def __init__(self, *args, organizer, instance=None, **kwargs):
        self.organizer = organizer
        self.instance = instance
        if instance is not None:
            kwargs.setdefault(
                "initial", {"name": instance.name, "opening_float": instance.opening_float}
            )
        super().__init__(*args, **kwargs)

    def clean_opening_float(self):
        # "100" and "100.00" are one float: stored, logged and compared as the
        # latter, so a save that changed nothing reads as nothing.
        value = self.cleaned_data["opening_float"]
        return None if value is None else value.quantize(Decimal("0.01"))

    def clean_name(self):
        # Already stripped, and refused when blank, by the field itself.
        name = self.cleaned_data["name"]
        clash = PosDrawer.objects.filter(organizer=self.organizer, name__iexact=name)
        if self.instance is not None:
            clash = clash.exclude(pk=self.instance.pk)
        clash = clash.first()
        if clash is not None and clash.archived_at is not None:
            # Out of sight, but its evenings are filed under that name.
            raise forms.ValidationError(
                _("“{name}” is the name of an archived drawer. Bring that one back, or "
                  "rename it first.").format(name=clash.name)
            )
        if clash is not None:
            raise forms.ValidationError(
                _("There is already a drawer called “{name}”.").format(name=name)
            )
        return name


class CloseForm(forms.Form):
    amount = forms.DecimalField(
        label=_("Cash counted"),
        required=False,
        min_value=Decimal("0.00"),
        max_digits=13,
        decimal_places=2,
        localize=True,
        help_text=_("Leave it empty if nobody counted the drawer."),
    )
    reason = forms.CharField(label=_("Note"), required=False, max_length=190)

    def clean_amount(self):
        value = self.cleaned_data["amount"]
        return None if value is None else value.quantize(Decimal("0.01"))


class DrawerAccessMixin:
    def dispatch(self, request, *args, **kwargs):
        if not can_read_drawers(request):
            raise PermissionDenied()
        self.can_manage = can_manage_drawers(request)
        return super().dispatch(request, *args, **kwargs)

    def _drawer(self):
        """The drawer named in the URL, of this organizer only."""
        drawer = PosDrawer.objects.filter(
            organizer=self.request.organizer, pk=self.kwargs["drawer"]
        ).first()
        if drawer is None:
            raise Http404()
        return drawer

    def _drawer_url(self, drawer):
        return reverse(
            "plugins:pretix_openpos:drawer",
            kwargs={"organizer": self.request.organizer.slug, "drawer": drawer.pk},
        )

    def _session_url(self, session):
        return reverse(
            "plugins:pretix_openpos:drawer.session",
            kwargs={
                "organizer": self.request.organizer.slug,
                "drawer": session.drawer_id,
                "session": session.pk,
            },
        )


def summarise(session, entries):
    """
    One line of a drawer's history, read off the opening's own ledger.

    What the closing said at the time, not a recomputation: this is the list
    of evenings as they were closed. The report behind each line is where a
    late sale shows up.
    """
    opening = next((e for e in entries if e.kind == PosDrawerEntry.KIND_OPEN), None)
    closing = next((e for e in reversed(entries) if e.kind == PosDrawerEntry.KIND_CLOSE), None)
    return {
        "session": session,
        "opening": opening,
        "closing": closing,
        "float": opening.amount if opening else None,
        "counted": closing.amount if closing else None,
        "expected": closing.expected if closing else None,
        "difference": closing.difference if closing else None,
        "movements": sum(
            1 for e in entries if e.kind in (PosDrawerEntry.KIND_IN, PosDrawerEntry.KIND_OUT)
        ),
    }


class DrawersView(DrawerAccessMixin, OrganizerDetailViewMixin, TemplateView):
    """Every drawer of the organizer, with where it stands tonight."""

    template_name = "pretix_openpos/drawers.html"

    def get_context_data(self, create_form=None, edit_form=None, **kwargs):
        ctx = super().get_context_data(**kwargs)
        organizer = self.request.organizer
        rows = []
        archived = []
        for drawer in PosDrawer.objects.filter(organizer=organizer).prefetch_related(
            "devices__device"
        ):
            session = open_session_of(drawer)
            last = (
                drawer.sessions.filter(closed_at__isnull=False)
                .prefetch_related("entries")
                .order_by("-closed_at", "-pk")
                .first()
            )
            row = {
                "drawer": drawer,
                "last": summarise(last, list(last.entries.all())) if last else None,
                "url": self._drawer_url(drawer),
            }
            if drawer.archived_at is not None:
                archived.append(row)
                continue
            row.update(
                {
                    "devices": sorted(
                        (
                            pos_device.device
                            for pos_device in drawer.devices.all()
                            if not pos_device.device.revoked
                        ),
                        key=lambda device: (device.name or "", device.pk),
                    ),
                    "session": summarise(session, list(session.entries.order_by("seq")))
                    if session else None,
                    # What it should hold right now: the float, and every euro
                    # that went in or out of it since, by sale or by hand.
                    "expected_now": figures(session)["expected"] if session else None,
                    "has_history": session is not None or last is not None,
                    "form": (
                        edit_form
                        if edit_form is not None and edit_form.instance.pk == drawer.pk
                        else DrawerForm(organizer=organizer, instance=drawer, prefix=f"d{drawer.pk}")
                    ),
                }
            )
            rows.append(row)
        ctx["rows"] = rows
        ctx["archived"] = archived
        ctx["create_form"] = create_form or DrawerForm(organizer=organizer, prefix="new")
        ctx["can_manage"] = self.can_manage
        ctx["currency"] = organizer_currency(organizer)
        ctx["devices_url"] = reverse(
            "plugins:pretix_openpos:devices", kwargs={"organizer": organizer.slug}
        )
        return ctx

    def post(self, request, *args, **kwargs):
        if not self.can_manage:
            raise PermissionDenied()
        organizer = request.organizer
        action = request.POST.get("action")

        if action == "create":
            form = DrawerForm(request.POST, organizer=organizer, prefix="new")
            if not form.is_valid():
                return self.render_to_response(self.get_context_data(create_form=form))
            drawer = PosDrawer.objects.create(
                organizer=organizer,
                name=form.cleaned_data["name"],
                opening_float=form.cleaned_data["opening_float"],
            )
            organizer.log_action(
                "pretix_openpos.drawer.created",
                user=request.user,
                data={
                    "drawer": drawer.pk,
                    "name": drawer.name,
                    "opening_float": _text(drawer.opening_float),
                    "currency": organizer_currency(organizer),
                },
            )
            messages.success(
                request,
                _("The drawer “{name}” has been created. Give it its tills on the till "
                  "devices screen.").format(name=drawer.name),
            )
            return redirect(request.path)

        pk = request.POST.get("drawer") or ""
        drawer = (
            PosDrawer.objects.filter(organizer=organizer, pk=pk).first() if pk.isdigit() else None
        )
        if drawer is None:
            raise Http404()

        if action == "delete":
            # A drawer with openings has a ledger, and a ledger is not thrown
            # away with the name it was filed under.
            if drawer.sessions.exists():
                messages.error(
                    request,
                    _("The drawer “{name}” has been opened before, so its history stays. "
                      "Archive it instead.").format(name=drawer.name),
                )
                return redirect(request.path)
            devices = [pos_device.device.name for pos_device in drawer.devices.all()]
            organizer.log_action(
                "pretix_openpos.drawer.deleted",
                user=request.user,
                data={"drawer": drawer.pk, "name": drawer.name, "devices": devices},
            )
            drawer.delete()
            messages.success(request, _("The drawer has been deleted."))
            return redirect(request.path)

        if action in ARCHIVING:
            ARCHIVING[action](request, drawer)
            return redirect(request.path)

        if action != "save":
            raise Http404()
        form = DrawerForm(request.POST, organizer=organizer, instance=drawer, prefix=f"d{drawer.pk}")
        if not form.is_valid():
            return self.render_to_response(self.get_context_data(edit_form=form))
        before = {"name": drawer.name, "opening_float": drawer.opening_float}
        drawer.name = form.cleaned_data["name"]
        drawer.opening_float = form.cleaned_data["opening_float"]
        if before != {"name": drawer.name, "opening_float": drawer.opening_float}:
            drawer.save(update_fields=["name", "opening_float"])
            organizer.log_action(
                "pretix_openpos.drawer.changed",
                user=request.user,
                data={
                    "drawer": drawer.pk,
                    "name": drawer.name,
                    "name_before": before["name"],
                    "opening_float": _text(drawer.opening_float),
                    "opening_float_before": _text(before["opening_float"]),
                    "currency": organizer_currency(organizer),
                },
            )
        messages.success(request, _("The drawer has been saved."))
        return redirect(request.path)


def _text(value):
    return None if value is None else str(value)


def _archive(request, drawer):
    """Put a closed drawer away, from the list or its own page, and say so."""
    if drawer.archived_at is not None:
        return
    try:
        tills = archive_drawer(drawer)
    except DrawerError as error:
        messages.error(request, error.message)
        return
    request.organizer.log_action(
        "pretix_openpos.drawer.archived",
        user=request.user,
        data={"drawer": drawer.pk, "name": drawer.name, "devices": [d.name for d in tills]},
    )
    if tills:
        messages.success(
            request,
            _("The drawer “{name}” has been archived, and taken away from {devices}.").format(
                name=drawer.name, devices=", ".join(d.name for d in tills)
            ),
        )
    else:
        messages.success(request, _("The drawer “{name}” has been archived.").format(name=drawer.name))


def _restore(request, drawer):
    """Offer an archived drawer again. Which tills feed it is said anew."""
    if drawer.archived_at is None:
        return
    restore_drawer(drawer)
    request.organizer.log_action(
        "pretix_openpos.drawer.restored",
        user=request.user,
        data={"drawer": drawer.pk, "name": drawer.name},
    )
    messages.success(
        request,
        _("The drawer “{name}” is back. Give it its tills on the till devices "
          "screen.").format(name=drawer.name),
    )


ARCHIVING = {"archive": _archive, "restore": _restore}


class DrawerView(DrawerAccessMixin, OrganizerDetailViewMixin, TemplateView):
    """One drawer, evening after evening."""

    template_name = "pretix_openpos/drawer.html"

    @cached_property
    def drawer(self):
        return self._drawer()

    def get(self, request, *args, **kwargs):
        if request.GET.get("export") == "csv":
            return self._export_csv()
        return super().get(request, *args, **kwargs)

    def post(self, request, *args, **kwargs):
        """Archive the drawer, from the page that says what that means, or bring it back."""
        if not self.can_manage:
            raise PermissionDenied()
        action = ARCHIVING.get(request.POST.get("action"))
        if action is None:
            raise Http404()
        action(request, self.drawer)
        return redirect(request.path)

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        drawer = self.drawer
        try:
            page = max(1, int(self.request.GET.get("page") or 1))
        except ValueError:
            page = 1
        sessions = list(
            drawer.sessions.order_by("-opened_at", "-pk").prefetch_related("entries")[
                (page - 1) * SESSIONS_PER_PAGE: page * SESSIONS_PER_PAGE + 1
            ]
        )
        ctx["drawer"] = drawer
        ctx["rows"] = [
            {**summarise(session, sorted(session.entries.all(), key=lambda e: e.seq)),
             # The one opening still running says what it should hold now; the
             # others what their closing said then.
             "expected_now": figures(session)["expected"] if session.is_open else None,
             "url": self._session_url(session)}
            for session in sessions[:SESSIONS_PER_PAGE]
        ]
        ctx["page"] = page
        ctx["next_page"] = page + 1 if len(sessions) > SESSIONS_PER_PAGE else None
        ctx["previous_page"] = page - 1 if page > 1 else None
        ctx["currency"] = organizer_currency(self.request.organizer)
        ctx["devices"] = [
            pos_device.device
            for pos_device in drawer.devices.select_related("device").order_by("device__name")
            if not pos_device.device.revoked
        ]
        # The whole ledger, every time: a drawer's ledger is a handful of rows
        # an evening, so the full walk costs nothing and misses nothing.
        ctx["tampered_with"] = PosDrawerEntry.verify_chain(drawer)
        ctx["is_open"] = open_session_of(drawer) is not None
        ctx["can_manage"] = self.can_manage
        ctx["drawers_url"] = reverse(
            "plugins:pretix_openpos:drawers", kwargs={"organizer": self.request.organizer.slug}
        )
        return ctx

    def _export_csv(self):
        """
        Every opening of the drawer, one row each, with what it was made of.

        Recomputed rather than read off the closing, unlike the screen: this
        is for whoever keeps the books, and the file should already include the
        sale a till replayed the morning after.
        """
        drawer = self.drawer
        tz = self.request.organizer.timezone
        header = [
            "opening", "opened_at", "opened_by", "closed_at", "closed_by",
            "float", "cash_sales", "cash_cancellations", "deposit_refunds",
            "cash_in", "cash_out", "expected", "expected_at_closing", "counted",
            "difference", "card", "note",
        ]

        def rows():
            writer = csv.writer(Echo(), delimiter=";")
            yield "﻿"
            yield writer.writerow(header)
            for session in drawer.sessions.order_by("opened_at", "pk").iterator():
                entries = list(session.entries.order_by("seq"))
                line = summarise(session, entries)
                fig = figures(session)
                closing = line["closing"]
                opening = line["opening"]
                # Names and the note are typed by people, so they go through
                # text_cell; every figure goes out as a number.
                yield writer.writerow([
                    session.pk,
                    session.opened_at.astimezone(tz).isoformat(),
                    text_cell(opening.cashier if opening else ""),
                    session.closed_at.astimezone(tz).isoformat() if session.closed_at else "",
                    text_cell(closing.cashier if closing else ""),
                    fig["float"],
                    fig["cash_sales"],
                    fig["cash_cancellations"],
                    fig["deposit_refunds"],
                    fig["cash_in"],
                    fig["cash_out"],
                    fig["expected"],
                    _money_or_blank(closing.expected if closing else None),
                    _money_or_blank(closing.amount if closing else None),
                    _money_or_blank(
                        closing.amount - fig["expected"]
                        if closing and closing.amount is not None else None
                    ),
                    fig["card"],
                    text_cell(closing.reason if closing else ""),
                ])

        response = StreamingHttpResponse(rows(), content_type="text/csv; charset=utf-8")
        response["Content-Disposition"] = (
            f'attachment; filename="openpos-drawer-{drawer.pk}.csv"'
        )
        return response


class DrawerSessionView(DrawerAccessMixin, OrganizerDetailViewMixin, TemplateView):
    """One opening's closing report, and the ledger behind it."""

    template_name = "pretix_openpos/drawer_session.html"

    @cached_property
    def session(self):
        drawer = self._drawer()
        session = PosDrawerSession.objects.filter(drawer=drawer, pk=self.kwargs["session"]).first()
        if session is None:
            raise Http404()
        return session

    def get_context_data(self, close_form=None, **kwargs):
        ctx = super().get_context_data(**kwargs)
        session = self.session
        entries = list(session.entries.order_by("seq"))
        line = summarise(session, entries)
        fig = figures(session)
        counts = [e for e in entries if e.kind == PosDrawerEntry.KIND_COUNT]
        closing = line["closing"]

        # Who took what, in this opening. Test-mode sales are left out of the
        # money, like everywhere else, and counted on a line of their own.
        tills = {}
        for row in (
            PosSale.objects.filter(drawer_session=session, testmode=False)
            .order_by()
            .values("device_name", "device_serial", "cashier", "payment_type", "kind")
            .annotate(amount=Sum("total"), n=Count("pk"), first_seq=Min("seq"))
        ):
            label = row["device_name"] or row["device_serial"] or str(_("unknown till"))
            if row["cashier"]:
                label = f"{label} · {row['cashier']}"
            bucket = tills.setdefault(
                label,
                {"label": label, "cash": Decimal("0.00"), "card": Decimal("0.00"), "count": 0},
            )
            bucket[row["payment_type"]] += row["amount"] or Decimal("0.00")
            if row["kind"] == PosSale.KIND_SALE:
                bucket["count"] += row["n"]

        # The events whose sales went into it, each with a link to its journal:
        # an opening is one evening, but a till can be moved to another event
        # in the middle of it.
        events = []
        for event in (
            self.request.organizer.events.filter(openpos_sales__drawer_session=session)
            .distinct()
            .order_by("date_from")
        ):
            events.append(
                {
                    "event": event,
                    "url": reverse(
                        "plugins:pretix_openpos:sales",
                        kwargs={"organizer": self.request.organizer.slug, "event": event.slug},
                    ),
                }
            )

        ctx.update(
            {
                "drawer": session.drawer,
                "session": session,
                "line": line,
                "figures": fig,
                "entries": entries,
                "first_count": counts[0] if counts else None,
                "closing": closing,
                # A sale replayed by a till that was offline, after the drawer
                # was closed: it belongs to this evening, and the count never
                # saw it. Said rather than silently folded into the figures.
                "late": closing is not None and closing.expected != fig["expected"],
                "difference_now": (
                    closing.amount - fig["expected"]
                    if closing is not None and closing.amount is not None else None
                ),
                "tills": sorted(tills.values(), key=lambda bucket: bucket["label"]),
                "events": events,
                "currency": organizer_currency(self.request.organizer),
                "can_manage": self.can_manage,
                "close_form": close_form or CloseForm(),
                "drawer_url": self._drawer_url(session.drawer),
            }
        )
        return ctx

    def post(self, request, *args, **kwargs):
        """
        Close an opening from the back office.

        For the drawer a till forgot to close: somebody counted it the next
        morning, or nobody did. Either way it is written down as closed from
        here, by whom, and on what figure — the ledger does not pretend a till
        did it.
        """
        if not self.can_manage:
            raise PermissionDenied()
        session = self.session
        form = CloseForm(request.POST)
        if not form.is_valid():
            return self.render_to_response(self.get_context_data(close_form=form))
        if not session.is_open:
            messages.error(request, _("This opening has already been closed."))
            return redirect(request.path)
        try:
            with transaction.atomic():
                entry = close_drawer(
                    session.drawer,
                    idempotency_key=f"backoffice-{uuid.uuid4()}",
                    amount=form.cleaned_data["amount"],
                    uncounted_ok=True,
                    reason=form.cleaned_data["reason"],
                    cashier=request.user.get_full_name(),
                    user=request.user,
                    source=PosDrawerEntry.SOURCE_BACKOFFICE,
                )
                request.organizer.log_action(
                    "pretix_openpos.drawer.closed",
                    user=request.user,
                    data={
                        "drawer": session.drawer_id,
                        "name": session.drawer.name,
                        "session": entry.session_id,
                        "amount": _text(entry.amount),
                        "expected": _text(entry.expected),
                        "reason": entry.reason,
                        "currency": organizer_currency(request.organizer),
                    },
                )
        except DrawerError as error:
            messages.error(request, error.message)
            return redirect(request.path)
        messages.success(request, _("The drawer has been closed."))
        return redirect(request.path)
