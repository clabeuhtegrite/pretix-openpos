import csv
import logging
from datetime import date, datetime, timedelta
from decimal import Decimal

from django.contrib import messages
from django.db import transaction
from django.db.models import Count, Min, Sum
from django.http import StreamingHttpResponse
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.functional import cached_property
from django.utils.timezone import make_aware, now
from django.utils.translation import gettext_lazy as _, ngettext
from django.views import View
from django.views.generic import ListView, TemplateView
from pretix.base.models import Event
from pretix.control.permissions import EventPermissionRequiredMixin
from pretix.control.views.event import EventSettingsFormView, EventSettingsViewMixin

from .api.views import BUSINESS_DAY_STARTS_AT
from .backoffice import cancelled_outside_the_journal, catch_up
from .forms import OpenPosSettingsForm
from .models import PosCategory, PosDevice, PosSale
from .takings import journal_rows, summarise

logger = logging.getLogger(__name__)


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


class CategoriesView(EventPermissionRequiredMixin, TemplateView):
    """
    Say which categories the bar sells and which the door sells.

    The complaint this answers is small and happens every evening: a volunteer
    at the door finishes a scan, taps through to sell somebody a ticket, and
    lands on the whole grid with the beer one row under the entry. Nothing
    stops them, and nothing tells them.

    One question per category, rendered as a table for the same reason the
    tariff is: the answers are short, there are a handful of them, and what an
    organiser wants while setting up a night is to see every category and who
    sells it at once. Leaving every row alone is the default and means what it
    has always meant — every till sells everything.

    Event-level, because that is where categories live. The other half of the
    rule, which tablet is the bar and which is the door, is set once per device
    on the organizer's till-devices screen: a device is paired for good, a
    category belongs to one event, and the two settings meet in the role.
    """

    template_name = "pretix_openpos/categories.html"
    # The same permission as the products the categories hold: whoever may say
    # what is sold may say who sells it.
    permission = "event.items:write"

    def _categories(self):
        return self.request.event.categories.order_by("position", "pk")

    def _rows(self, submitted=None):
        """Every category of the event, with who sells it and what is in it."""
        stored = {
            pc.category_id: pc.role
            for pc in PosCategory.objects.filter(category__event=self.request.event)
        }
        # How many products are in each category, so a row that turns out to
        # matter can be told from one that holds nothing. Counted over the
        # whole event rather than over the till's channel: a product not on
        # the Open POS channel is invisible at every till anyway, and a count
        # that silently ignored it would read as an empty category to somebody
        # who is looking straight at its products.
        counts = dict(
            self.request.event.items.values_list("category_id")
            .annotate(n=Count("pk"))
            .values_list("category_id", "n")
        )
        rows = []
        for category in self._categories():
            role = stored.get(category.pk, PosCategory.ROLE_ALL)
            if submitted is not None:
                role = submitted.get(f"role_{category.pk}", PosCategory.ROLE_ALL)
            rows.append(
                {
                    "category": category,
                    "role": role,
                    "items": counts.get(category.pk, 0),
                }
            )
        return rows

    def get_context_data(self, submitted=None, **kwargs):
        ctx = super().get_context_data(**kwargs)
        rows = self._rows(submitted)
        ctx["rows"] = rows
        ctx["roles"] = PosCategory.ROLE_CHOICES
        # What each role ends up selling, spelled out under the table. The
        # dropdowns say who may sell a category; this says what a tablet will
        # actually show, which is the thing being decided and is not the same
        # sentence read backwards.
        #
        # The colon is part of the sentence to translate rather than typed
        # after it in the template: French puts a space before one, and a
        # colon glued on outside the string read "vend:" in a French back
        # office.
        ctx["sells"] = [
            {
                "role": label,
                "categories": [
                    str(row["category"].name)
                    for row in rows
                    if row["role"] in (PosCategory.ROLE_ALL, role)
                ],
            }
            for role, label in (
                (PosDevice.ROLE_TILL, _("A till device sells:")),
                (PosDevice.ROLE_DOOR, _("A door device sells:")),
            )
        ]
        # Products in no category at all. They stay on every till whatever is
        # reserved here, because there is no row to reserve them on — said out
        # loud rather than left to be discovered, since "I reserved everything
        # and the door still shows the beer" is exactly how it would be found.
        ctx["uncategorised"] = self.request.event.items.filter(
            category__isnull=True
        ).count()
        ctx["devices_url"] = reverse(
            "plugins:pretix_openpos:devices",
            kwargs={"organizer": self.request.event.organizer.slug},
        )
        return ctx

    def post(self, request, *args, **kwargs):
        categories = list(self._categories())
        submitted = {
            category.pk: (request.POST.get(f"role_{category.pk}") or "")
            for category in categories
        }

        valid = {choice for choice, _label in PosCategory.ROLE_CHOICES}
        unknown = sorted(set(submitted.values()) - valid)
        if unknown:
            # A hand-made POST, or a form from a build that knew a role this
            # one does not. Nothing is written either way.
            messages.error(
                request,
                _("“{role}” is not one of the answers on this page.").format(
                    role=unknown[0]
                ),
            )
            return self.render_to_response(self.get_context_data())

        stored = {
            pc.category_id: pc
            for pc in PosCategory.objects.filter(category__event=request.event)
        }
        # Both sides of every row that moved, with the name copied in: a
        # category renamed next season would otherwise leave the history
        # pointing at nothing, and the question asked of this entry is always
        # "who took the beer off the door, and when".
        changed = []
        with transaction.atomic():
            for category in categories:
                role = submitted[category.pk]
                current = stored.get(category.pk)
                before = current.role if current else PosCategory.ROLE_ALL
                if before == role:
                    continue
                if role == PosCategory.ROLE_ALL:
                    # Unreserved is the absence of a row, not a row saying
                    # nothing: it is the state a category starts in, and the
                    # two want to look the same in the database.
                    PosCategory.objects.filter(category=category).delete()
                else:
                    PosCategory.objects.update_or_create(
                        category=category, defaults={"role": role}
                    )
                changed.append(
                    {
                        "category": category.pk,
                        "category_name": str(category.name),
                        "role": role,
                        "role_before": before,
                    }
                )

        request.event.log_action(
            "pretix_openpos.categories.changed", user=request.user, data={"changed": changed}
        )
        messages.success(request, _("Who sells what has been saved."))
        return redirect(
            reverse(
                "plugins:pretix_openpos:categories",
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


#: How long a card payment may sit unanswered before it is worth a human's
#: attention.
#:
#: Generous: a cardholder rummaging for their wallet, a reader that took a
#: while to wake, a till that polled late. Anything still open after this was
#: not slow, it was abandoned.
UNRESOLVED_AFTER = timedelta(minutes=20)


def sold_off_tariff(sales):
    """
    Journal rows that were replayed at a price the tariff no longer carries.

    A sale rung up while the till was cut off was priced from the tariff it had
    cached, and the customer paid that. The order is created at what was
    actually charged, because invoicing a sum nobody handed over is the worse
    of the two lies — and the divergence is recorded on the line rather than
    smoothed away.

    Until now the only place it was ever said out loud was the till's own
    resync panel, to whoever was holding the tablet, once. This is the same
    thing in the place the evening is reconciled: the difference is real money
    that is in the drawer and not in the price list, and it has to be added up
    somewhere.

    Takes an already-filtered queryset, so it follows the screen's own range.
    """
    rows = []
    difference = Decimal("0.00")
    for sale in sales.filter(offline=True).order_by("-seq"):
        lines = []
        for line in sale.positions:
            if not line.get("tariff_price"):
                continue
            # The journal holds these as strings — it is JSON, and a price
            # that came back as a float would be a worse bug than any of the
            # ones on this page. Widened here rather than in the template,
            # which has no arithmetic and whose money filter refuses a string.
            charged = Decimal(line["unit_price"])
            tariff = Decimal(line["tariff_price"])
            difference += (charged - tariff) * line["count"]
            lines.append({**line, "unit_price": charged, "tariff_price": tariff})
        if lines:
            rows.append({"sale": sale, "lines": lines})
    return rows, difference


def off_tariff_total(sale):
    """
    What the price list would have charged for this basket, or ``None``.

    ``None`` rather than the total whenever nothing diverged, so a reader can
    tell "the tariff agreed" from "the tariff was never compared" — an online
    sale has no cached tariff to differ from and its row is blank, not zero.
    """
    if not any(line.get("tariff_price") for line in sale.positions):
        return None
    return sum(
        (
            Decimal(line.get("tariff_price") or line["unit_price"]) * line["count"]
            for line in sale.positions
        ),
        Decimal("0.00"),
    )


def refused_card_refunds(event):
    """
    Cancellations whose money SumUp would not give back.

    A card refund is asked for over the network, and the network can say no —
    a transaction already refunded, an account limit, a reader long gone. The
    till says so in red, to whoever pressed the button, once. Nobody else ever
    heard: pretix marks the refund failed and moves on, and the customer is
    standing at the counter being told the cancellation went through.

    So the money is still on their card, and the only other record of that is
    SumUp's dashboard. This is the list the organiser reconciling the next
    morning did not have. Read-only, like the section above it: refunding one
    of these — from the order's own refund dialog, which sends it through
    SumUp, or from the SumUp app — is a decision, not a page load. Once it is
    refunded it leaves the list.

    Not filtered by evening, deliberately, and for the same reason: an unpaid
    debt to a customer does not stop mattering because the screen is showing a
    different night.
    """
    from pretix.base.models.orders import OrderRefund

    from .payment import CARD

    refunds = list(
        OrderRefund.objects.filter(
            order__event=event,
            provider=CARD,
            state=OrderRefund.REFUND_STATE_FAILED,
        )
        .select_related("order")
        .order_by("-created")[:200]
    )
    if not refunds:
        return []

    # The SumUp handle for each, so the dashboard can be searched. It lives on
    # the payment row rather than on the refund, which knows only pretix.
    keys = {
        sale.order_id: sale.idempotency_key
        for sale in PosSale.objects.filter(
            event=event,
            order_id__in=[refund.order_id for refund in refunds],
            kind=PosSale.KIND_SALE,
        )
    }
    from .models import PosTerminalPayment

    payments = {
        payment.idempotency_key: payment
        for payment in PosTerminalPayment.objects.filter(
            event=event, idempotency_key__in=list(keys.values())
        )
    }
    rows = []
    for refund in refunds:
        payment = payments.get(keys.get(refund.order_id))
        if payment is not None and payment.refunded is not None:
            # Given back since, from pretix' refund dialog, by a retry at the
            # till, or in SumUp, which reconcile.py reads back. pretix keeps
            # the failed refund on the order, as it should; the debt it
            # recorded is paid.
            continue
        rows.append(
            {
                "refund": refund,
                "order": refund.order,
                "transaction": payment.transaction_id if payment else "",
                # Why, in SumUp's words, when the refund that failed kept them.
                "answer": (refund.info_data or {}).get("sumup_error", ""),
            }
        )
    return rows


def waiting_card_refunds(event):
    """
    Card refunds SumUp has not taken yet, which the server is asking for again.

    Nothing for anybody to do — that is the point of listing them apart from
    the refused ones below. What they are for is the answer to "did the
    customer get their money back?" asked the next morning: not yet, SumUp
    said so at such a time, and it will be asked again. One SumUp still
    refuses after three days leaves this list for that one.
    """
    from django.utils.dateparse import parse_datetime

    from .reconcile import TRIED_AT, pending_refunds, terminal_for

    rows = []
    for refund in pending_refunds(order__event=event)[:200]:
        info = refund.info_data or {}
        transaction = info.get("transaction_id")
        if not transaction:
            terminal = terminal_for(refund.order)
            transaction = terminal.transaction_id if terminal else ""
        rows.append(
            {
                "refund": refund,
                "order": refund.order,
                "transaction": transaction,
                "answer": info.get("sumup_error", ""),
                "tried": parse_datetime(info.get(TRIED_AT) or ""),
            }
        )
    return rows


def comparison_summary(done):
    """What one comparison with SumUp did, in one line, for a person."""
    if done.get("crashed"):
        return _("Open POS ran into an error while comparing with SumUp. The server's log "
                 "has the details.")
    if done.get("error"):
        return _("SumUp's history could not be read: {answer}").format(answer=done["error"])
    if not done.get("compared") and not any(
        done.get(key) for key in ("given_back", "sent", "waiting", "failed")
    ):
        return _("Nothing to compare with SumUp: no card payment of the last 30 days is left "
                 "that SumUp could have given back, and no refund is waiting.")
    return _(
        "Given back in SumUp: {listed} · brought into pretix: {given_back} · waiting refunds "
        "sent: {sent} · still waiting: {waiting} · given up: {failed}"
    ).format(**{key: done.get(key, 0) for key in (
        "listed", "given_back", "sent", "waiting", "failed",
    )})


#: A last pass older than this, with something to compare, is a periodic task
#: that stopped: pretix advises running it at least every hour.
COMPARISON_LATE = timedelta(hours=2)


def sumup_comparison(organizer):
    """
    When the periodic task last compared this organizer with SumUp, and how it went.

    ``None`` when the organizer has no SumUp account: nothing to compare. The
    task's pace is the server's cron, which pretix leaves anywhere between
    every minute and every hour, and nothing else on screen says whether it
    runs at all — a card refund made in SumUp's dashboard that has not shown up
    yet is either waiting for the next pass or a sign there is none.
    """
    from .reconcile import anything_to_compare, last_comparison
    from .sumup import SumUpAccount

    if not SumUpAccount(organizer).configured:
        return None
    record = last_comparison(organizer)
    # The task skips an organizer with nothing left to compare, so no pass, or
    # an old one, is then no sign of a task that stopped.
    expected = anything_to_compare(organizer)
    if record is None:
        if not expected:
            return {"at": None, "text": comparison_summary({}), "late": False, "problem": False}
        return {"at": None, "text": "", "late": False, "problem": True}
    late = expected and now() - record["at"] > COMPARISON_LATE
    return {
        "at": record["at"],
        "text": comparison_summary(record),
        "late": late,
        "problem": bool(record.get("error") or record.get("crashed") or late),
    }


def unresolved_terminal_payments(event):
    """
    Card payments that never became a sale, for the one screen that can say so.

    Two shapes, and they are the same problem seen at two moments. A payment
    SumUp says went through, with no journal row carrying its key: the money
    left the customer's card and pretix has never heard of it. And a payment
    still waiting long after anyone could be standing at the counter: the till
    was closed, or lost, or its battery went, while a reader had a basket on
    it — nobody will ever poll it again, and it may or may not have been paid.

    Neither is visible anywhere else. The takings are built from the journal,
    so they cannot show a charge that never reached it; the only other record
    is SumUp's own dashboard, read line by line against a statement days
    later. This is the whole reason the screen has a section for it.

    Read-only, and deliberately so: what to do about one of these is a
    decision — refund it, or ring the sale up again — and not something a page
    load should make.
    """
    from .models import PosTerminalPayment

    payments = (
        PosTerminalPayment.objects.filter(event=event, refunded__isnull=True)
        .exclude(status=PosTerminalPayment.STATUS_FAILED)
        .select_related("device")
    )
    stale = now() - UNRESOLVED_AFTER
    candidates = [
        payment
        for payment in payments.order_by("-created")[:500]
        if payment.status == PosTerminalPayment.STATUS_SUCCESSFUL
        or payment.created < stale
    ]
    if not candidates:
        return []

    # One query for the journal side rather than one per row.
    booked = set(
        PosSale.objects.filter(
            event=event,
            idempotency_key__in=[payment.idempotency_key for payment in candidates],
        ).values_list("idempotency_key", flat=True)
    )
    return [
        {
            "payment": payment,
            "till": payment.device.name if payment.device else payment.device_serial,
            # What a human has to decide about, said in the row itself.
            "paid": payment.status == PosTerminalPayment.STATUS_SUCCESSFUL,
        }
        for payment in candidates
        if payment.idempotency_key not in booked
    ]


def business_day_window(event, start, end):
    """
    Turn two dates into the span of nights they name.

    Nights, not calendar days, and that is the whole reason this exists: a till
    day here begins at six in the morning, because an evening crosses midnight
    and the figure somebody reconciles the drawer against at half past one has
    to cover the whole of it. A filter that cut at midnight would split every
    single event in this system down the middle and hand back two halves that
    answer nothing.

    So ``from=2026-09-19&to=2026-09-19`` means the night of Saturday the 19th:
    six in the morning that day, up to six the next. Either end may be left
    out. Returns ``(start, end, problems)`` with datetimes or ``None``, and a
    list of what could not be read — shown to the organiser rather than
    silently ignored, because a filter that quietly does nothing is worse than
    none at all.
    """
    problems = []

    def parse(value, complaint):
        if not value:
            return None
        try:
            return date.fromisoformat(value.strip())
        except ValueError:
            # The whole sentence, rather than one built from a translated word
            # dropped into a slot: a bare “from” is the kind of msgid a
            # catalogue renders as the wrong one of the four French words for
            # it, and there is nothing in the string to tell a translator which.
            problems.append(complaint.format(value=value[:20]))
            return None

    first = parse(
        start,
        _("“{value}” is not a date. The first evening goes in as YYYY-MM-DD."),
    )
    last = parse(
        end,
        _("“{value}” is not a date. The last evening goes in as YYYY-MM-DD."),
    )
    if first and last and last < first:
        problems.append(_("The end of the range is before its beginning."))
        first = last = None

    def at_six(day):
        return make_aware(
            datetime.combine(day, BUSINESS_DAY_STARTS_AT), event.timezone
        )

    return (
        at_six(first) if first else None,
        # Up to six the morning AFTER the last night asked for, so that night
        # is included whole rather than cut short at its own six o'clock.
        at_six(last + timedelta(days=1)) if last else None,
        problems,
    )


def takings_detail(event, sales):
    """
    What the takings of ``sales`` are made of: products by category, deposits
    apart, and the cancellations already netted off.

    The till's closing screen reads the same computation, so the two can never
    disagree about what a product sold. It answers in the API's shape, amounts
    as strings, and pretix' ``money`` filter takes numbers only.
    """
    report = summarise(event, journal_rows(sales))
    deposits = report["deposits"]
    return {
        "categories": [
            {
                **group,
                "total": Decimal(group["total"]),
                "items": [{**line, "total": Decimal(line["total"])} for line in group["items"]],
            }
            for group in report["categories"]
        ],
        "deposits": (
            {
                "taken": {**deposits["taken"], "total": Decimal(deposits["taken"]["total"])},
                "returned": {
                    **deposits["returned"], "total": Decimal(deposits["returned"]["total"]),
                },
                "total": Decimal(deposits["total"]),
            }
            if deposits
            else None
        ),
        "unallocated": Decimal(report["unallocated"]) if report["unallocated"] else None,
        "cancellations": report["event"]["cancellations"],
        "cancelled_total": Decimal(report["event"]["cancelled_total"]),
    }


class SalesView(EventPermissionRequiredMixin, ListView):
    """Journal of till sales, with the takings broken down per device and per product."""

    template_name = "pretix_openpos/sales.html"
    permission = "event.orders:read"
    context_object_name = "sales"
    paginate_by = 100

    def get(self, request, *args, **kwargs):
        if request.GET.get("export") == "csv":
            return self._export_csv()
        for problem in self.window[2]:
            messages.error(request, problem)
        return super().get(request, *args, **kwargs)

    @cached_property
    def window(self):
        """The nights being looked at, read once per request."""
        return business_day_window(
            self.request.event,
            self.request.GET.get("from"),
            self.request.GET.get("to"),
        )

    def in_window(self, qs):
        start, end, _problems = self.window
        if start is not None:
            qs = qs.filter(datetime__gte=start)
        if end is not None:
            qs = qs.filter(datetime__lt=end)
        return qs

    def _export_csv(self):
        """
        The journal as one file, for whoever keeps the books.

        Carries the same filter as the screen it was downloaded from. An export
        that silently handed back every event's worth of rows when the page
        showed one night would be the more expensive of the two mistakes: the
        person opening it is reconciling something, and has no way to tell.

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
            # What the price list would have charged for the same basket, and
            # the gap. Blank on every row but an offline replay whose tariff
            # had moved, so a column of blanks with three figures in it is the
            # honest shape of this: it is a rare thing that matters when it
            # happens, and a spreadsheet can sum it without reading the
            # positions column by eye.
            "offline", "tariff_total", "off_tariff", "cancels_seq", "reason",
            "positions",
            # The cash drawer the money went into and which opening of it, for
            # a till that has one. Last, so a spreadsheet built on the columns
            # before them keeps working.
            "drawer", "drawer_opening",
        ]

        def rows():
            writer = csv.writer(Echo(), delimiter=";")
            # The BOM stops Excel guessing at the encoding.
            yield "\ufeff"
            yield writer.writerow(header)
            journal = self.in_window(
                PosSale.objects.filter(event=event)
            ).select_related("drawer_session__drawer").order_by("seq").iterator()
            for sale in journal:
                positions = " + ".join(
                    "{}× {}{}{}".format(
                        line.get("count"),
                        line.get("item_name"),
                        " ({})".format(line["variation_name"]) if line.get("variation_name") else "",
                        # What a free amount was for. Without it the row reads
                        # as "1× Misc, 12.00" and answers nothing.
                        " — {}".format(line["description"]) if line.get("description") else "",
                    )
                    for line in sale.positions
                )
                tariff_total = off_tariff_total(sale)
                yield writer.writerow([
                    sale.seq,
                    sale.kind,
                    sale.datetime.astimezone(tz).isoformat(),
                    sale.order_code,
                    sale.device_name or sale.device_serial or (
                        str(_("pretix back office")) if sale.from_back_office else ""
                    ),
                    sale.device_serial,
                    sale.cashier,
                    sale.payment_type,
                    sale.total,
                    "" if sale.cash_given is None else sale.cash_given,
                    "" if sale.cash_change is None else sale.cash_change,
                    "1" if sale.testmode else "",
                    "1" if sale.offline else "",
                    "" if tariff_total is None else tariff_total,
                    "" if tariff_total is None else sale.total - tariff_total,
                    "" if sale.cancels_seq is None else sale.cancels_seq,
                    sale.reason,
                    positions,
                    sale.drawer_session.drawer.name if sale.drawer_session else "",
                    sale.drawer_session_id or "",
                ])

        response = StreamingHttpResponse(rows(), content_type="text/csv; charset=utf-8")
        # The range in the filename, so two exports of different nights do not
        # land in the same downloads folder under the same name.
        start, end, _problems = self.window
        span = "".join(
            part for part in (
                f"-{start.date().isoformat()}" if start else "",
                f"-{(end - timedelta(days=1)).date().isoformat()}" if end else "",
            )
        )
        response["Content-Disposition"] = (
            f'attachment; filename="openpos-journal-{event.slug}{span}.csv"'
        )
        return response

    def get_queryset(self):
        return (
            self.in_window(PosSale.objects.filter(event=self.request.event))
            .select_related("device", "order", "drawer_session__drawer")
            .order_by("-seq")
        )

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        # The takings follow the filter, or the figures under a filtered journal
        # would belong to a different set of rows than the ones listed — which
        # is the way to make a page lie without a single wrong number on it.
        all_sales = self.in_window(PosSale.objects.filter(event=self.request.event))

        def empty():
            return {"cash": Decimal("0.00"), "card": Decimal("0.00"), "count": 0}

        # Aggregated in the database: the journal is append-only and only ever
        # grows, and this page used to fetch every row of it just to add them
        # up. The result set here is one row per (till, cashier, payment type).
        rows = (
            all_sales.values(
                "device_name", "device_serial", "cashier", "payment_type", "testmode",
                # Grouped by kind as well, because the two halves of a row are
                # counted differently: the money of every kind belongs in the
                # takings, the *count* only of the ones that were a sale.
                "kind",
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
            # A cancellation and a returned deposit are not customers served.
            # Their money nets off the amounts below — that is what the drawer
            # holds — but counting them as sales says six where four people
            # were served.
            sales = row["kind"] == PosSale.KIND_SALE

            if row["testmode"]:
                testmode_totals[row["payment_type"]] += row["amount"]
                testmode_totals["count"] += row["n"] if sales else 0
                continue

            label = row["device_name"] or row["device_serial"] or (
                # Not a till at all: pretix' back office cancelled a till's sale,
                # or brought one back. Its own line, so the tills' own figures
                # stay what their drawers hold.
                str(_("pretix back office"))
                if PosSale.is_back_office(row["device_serial"], row["kind"])
                else str(_("unknown till"))
            )
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
            bucket["count"] += row["n"] if sales else 0
            bucket["first_seq"] = min(bucket["first_seq"], row["first_seq"])
            totals[row["payment_type"]] += row["amount"]
            totals["count"] += row["n"] if sales else 0

        # In the order the tills first wrote to the journal, as the row-by-row
        # version showed them.
        devices = sorted(by_device.values(), key=lambda bucket: bucket["first_seq"])
        for bucket in devices:
            bucket["total"] = bucket["cash"] + bucket["card"]
        for bag in (totals, testmode_totals):
            bag["total"] = bag["cash"] + bag["card"]

        ctx["by_device"] = devices
        ctx["totals"] = totals
        # Shown whenever test money went through at all, count or no count: a
        # night of nothing but cancelled test sales still has to be visible as
        # money that never existed.
        ctx["testmode_totals"] = (
            testmode_totals if all_sales.filter(testmode=True).exists() else None
        )
        ctx["currency"] = self.request.event.currency
        # Product by product, and following the filter like the table it
        # details: a breakdown of other rows than the total above it would not
        # add up to it.
        ctx["detail"] = takings_detail(self.request.event, all_sales)
        # Deliberately NOT filtered, unlike everything above. The chain runs
        # through the whole journal, so checking a slice of it would let a page
        # showing one night report a sound journal while an entry outside the
        # window is the broken one. Same for card payments left in the air:
        # they are an outstanding job, not a figure about this night.
        # Checked from an anchored checkpoint; `manage.py openpos_verify_journal`
        # is the full audit.
        ctx["tampered_with"] = PosSale.verify_chain_cached(self.request.event)
        ctx["unresolved_card"] = unresolved_terminal_payments(self.request.event)
        # Follows the filter, unlike the two blocks above it: this is money
        # that belongs to the evening being reconciled, not a loose end that
        # needs seeing whatever range is on screen.
        ctx["off_tariff"], ctx["off_tariff_difference"] = sold_off_tariff(all_sales)
        ctx["refused_refunds"] = refused_card_refunds(self.request.event)
        ctx["waiting_refunds"] = waiting_card_refunds(self.request.event)
        ctx["sumup_comparison"] = sumup_comparison(self.request.organizer)
        # Not filtered by evening either: a sale pretix struck off is wrong in
        # the takings of whichever night it was sold on, and one button puts
        # every one of them right.
        ctx["missed_cancellations"] = cancelled_outside_the_journal(self.request.event)
        ctx["can_write_orders"] = self.request.user.has_event_permission(
            self.request.organizer, self.request.event, CatchUpView.permission,
            request=self.request,
        )
        # Echoed back so the form keeps what was asked for, and so the export
        # link can carry it.
        ctx["filter_from"] = (self.request.GET.get("from") or "").strip()
        ctx["filter_to"] = (self.request.GET.get("to") or "").strip()
        ctx["filtered"] = any(self.window[:2])
        return ctx


class CatchUpView(EventPermissionRequiredMixin, View):
    """
    Write into the journal the cancellations pretix made without it.

    POST only, and behind the permission to change orders rather than the one
    to read them: this appends to a journal that nothing can take back, which
    is an organiser's decision and not something a page load may do.
    """

    permission = "event.orders:write"

    def post(self, request, *args, **kwargs):
        reversed_sales = catch_up(request.event, user=request.user)
        if reversed_sales:
            messages.success(
                request,
                ngettext(
                    "%(count)d cancelled sale was written to the journal.",
                    "%(count)d cancelled sales were written to the journal.",
                    reversed_sales,
                ) % {"count": reversed_sales},
            )
        left = len(cancelled_outside_the_journal(request.event))
        if left:
            # Written to the order's history by the attempt itself; this says
            # where to look.
            messages.error(
                request,
                ngettext(
                    "%(count)d cancelled sale could not be written. Its order's history "
                    "says so.",
                    "%(count)d cancelled sales could not be written. Their orders' "
                    "histories say so.",
                    left,
                ) % {"count": left},
            )
        elif not reversed_sales:
            messages.info(request, _("Every sale pretix cancelled is already in the journal."))
        return redirect(
            reverse(
                "plugins:pretix_openpos:sales",
                kwargs={"organizer": request.organizer.slug, "event": request.event.slug},
            )
        )


class CompareWithSumUpView(EventPermissionRequiredMixin, View):
    """
    Compare this event's card payments with SumUp now, rather than at the next pass.

    What the periodic task does, narrowed to one event: a refund made in
    SumUp's dashboard is brought into pretix, and a refund waiting for SumUp
    is asked for again. Behind the permission to change orders, since it can
    cancel one; and to this event only, since that permission is this
    event's. The task's pace is the server's cron, up to an hour apart, and
    this is for the person who just gave a card its money back and wants the
    order to say so before they close the tab.
    """

    permission = "event.orders:write"

    def post(self, request, *args, **kwargs):
        from .reconcile import reconcile_organizer
        from .sumup import SumUpAccount

        account = SumUpAccount(request.organizer)
        if not account.configured:
            messages.error(request, _("SumUp is not set up for this organizer yet."))
        else:
            try:
                done = reconcile_organizer(request.organizer, account, event=request.event)
            except Exception:
                logger.exception("Open POS could not compare %s with SumUp", request.event.slug)
                done = {"crashed": True}
            if done.get("crashed") or done.get("error"):
                messages.error(request, comparison_summary(done))
            else:
                messages.success(request, comparison_summary(done))
        return redirect(
            reverse(
                "plugins:pretix_openpos:sales",
                kwargs={"organizer": request.organizer.slug, "event": request.event.slug},
            )
        )
