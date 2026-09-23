"""
Who came in, and when: the back office's two arrivals pages.

One per event, in its Open POS menu, for the evening itself: how many of the
tickets sold came through the door, a quarter of an hour at a time, bought
ahead or at the till, what the doors turned away and which phone scanned what.
It reads the very calculation the door screen does (``attendance.py``), so the
office and the door cannot tell two stories about one evening.

One for the organizer, because "when do people actually show up?" is a
question about every evening at once: each event's headline figures, leading
to its own page, and every entry at every past event bucketed by hour of
day, so the busy and the dead hours at the entrance are visible at a glance.

Both pages write nothing and never will: they grew out of wanting to staff the
door right, and a staffing decision needs a chart, not a form.
"""

from datetime import timedelta

from django.core.cache import cache
from django.core.exceptions import PermissionDenied
from django.db.models import Exists, OuterRef, Q
from django.utils.timezone import now
from django.utils.translation import ngettext, pgettext_lazy
from django.views.generic import TemplateView
from pretix.base.models import Checkin, SubEvent
from pretix.control.permissions import EventPermissionRequiredMixin
from pretix.control.views.organizer import OrganizerDetailViewMixin

from .attendance import QUARTER, arrivals, attendance, door_list, door_scans, is_over, lists_of, refusals

#: How long a computed histogram is reused.
#:
#: The page reads every entry at every *past* event, which on an organizer
#: with a few years of history is the one expensive thing it does — and the
#: answer barely moves, because an event that is over stops being scanned. The
#: only churn is an event crossing into the past, which a quarter of an hour
#: late is nobody's problem. Only the counts are cached: plain integers, so
#: nothing here can hand back a stale Event.
HISTOGRAM_TTL = 900


def _past_q(prefix=""):
    """Events (or subevents) that are over: date_to if set, else date_from."""
    return Q(**{f"{prefix}date_to__isnull": False, f"{prefix}date_to__lt": now()}) | Q(
        **{f"{prefix}date_to__isnull": True, f"{prefix}date_from__lt": now()}
    )


def hour_label(hour):
    """``21:00–22:00`` — numeric on purpose, so it needs no translation."""
    return f"{hour:02d}:00–{(hour + 1) % 24:02d}:00"


def px(value):
    """
    A coordinate as a string, because the template must not see a float.

    Django localizes bare numbers in templates: under a French locale
    ``507.8`` renders as ``507,8``, and in an SVG attribute that comma makes a
    *list* — ``x="507,8"`` puts the first glyph at 507 and every following
    glyph at 8. Each label then shows one character in place while the rest
    pile up at the edge of the chart. Pre-formatting here keeps l10n out of
    the geometry entirely.
    """
    text = f"{value:.1f}".rstrip("0").rstrip(".")
    return text or "0"


def nice_scale(peak_value):
    """
    The step and the top of a count axis.

    The smallest 1/2/5-step that fits the maximum in at most five intervals,
    so the axis reads as counting, not as measuring.
    """
    for step in (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000):
        if peak_value / step <= 5:
            break
    else:
        step = 10 ** len(str(peak_value))
    return step, step * -(-peak_value // step)  # ceil


def bar_path(x, width, top, bottom, rounded=True):
    """
    One bar, or one piece of a stacked bar, as an SVG path.

    Rounded at the data end only — the baseline is ground, not data — and only
    when there is room for the curve: a rounded cap on a bar two pixels tall is
    a rounding of nothing, and renders as a blob.
    """
    if rounded and bottom - top >= 6:
        return (
            f"M{px(x)},{px(bottom)} V{px(top + 4)} "
            f"Q{px(x)},{px(top)} {px(x + 4)},{px(top)} "
            f"H{px(x + width - 4)} "
            f"Q{px(x + width)},{px(top)} {px(x + width)},{px(top + 4)} "
            f"V{px(bottom)} Z"
        )
    return f"M{px(x)},{px(bottom)} V{px(top)} H{px(x + width)} V{px(bottom)} Z"


def chart_geometry(by_hour, total):
    """
    Everything the SVG needs, precomputed.

    The template only prints coordinates: Django's template language cannot do
    the arithmetic, and trying to make it would smear the geometry across two
    files. Every coordinate is a pre-formatted string (see ``px``); the only
    numbers handed to the template are whole counts, which l10n cannot damage.
    One bar per hour of day, thin, rounded at the data end and square at the
    baseline, with a full-height hover band per hour because a 22px bar is too
    small a hover target.
    """
    width, height = 960, 300
    left, right, top, bottom = 46, 10, 34, 32
    plot_w, plot_h = width - left - right, height - top - bottom
    band = plot_w / 24
    bar_w = 22

    step, scale_top = nice_scale(max(by_hour))

    def y(value):
        return round(top + plot_h * (1 - value / scale_top), 1)

    baseline = top + plot_h
    peak_hour = max(range(24), key=by_hour.__getitem__)

    bars = []
    for hour in range(24):
        value = by_hour[hour]
        x = round(left + hour * band + (band - bar_w) / 2, 1)
        cx = round(left + hour * band + band / 2, 1)
        bar_top = y(value)
        bars.append({
            "band_x": px(left + hour * band),
            "band_w": px(band),
            "cx": px(cx),
            "label_y": px(min(bar_top, baseline) - 8),
            "count": value,
            "title": "{} · {} · {:.1f} %".format(
                hour_label(hour), value, 100 * value / total
            ),
            "is_peak": hour == peak_hour and value > 0,
            "d": bar_path(x, bar_w, bar_top, baseline) if value > 0 else None,
        })

    return {
        "width": width,
        "height": height,
        "plot_left": left,
        "plot_right": left + plot_w,
        "plot_top": top,
        "plot_h": plot_h,
        "ylabel_x": left - 8,
        "baseline": baseline,
        "bars": bars,
        "yticks": [
            {"y": px(y(v)), "label": v}
            for v in range(step, scale_top + 1, step)
        ],
        "xticks": [
            {"x": px(left + hour * band + band / 2), "label": f"{hour}:00"}
            for hour in range(0, 24, 2)
        ],
        "xlabel_y": height - 10,
    }


def span_label(start, minutes=QUARTER):
    """``22:15–22:30`` — numeric, like :func:`hour_label`, so untranslated."""
    return f"{start:%H:%M}–{start + timedelta(minutes=minutes):%H:%M}"


#: The two ways a ticket that came in was sold, as the legend and the tooltip
#: name them. At a till is the Open POS channel; ahead is every other one, the
#: online shop first of all.
SOLD = {
    "ahead": pgettext_lazy("arrivals", "Bought ahead"),
    "till": pgettext_lazy("arrivals", "Sold on site"),
}

#: Past this many bars a night is drawn by the half hour. A night of scans
#: from the afternoon's test to the last latecomer runs to twelve hours; at a
#: quarter of an hour that is forty-eight bars of thirteen pixels, and past it
#: they stop being bars.
MOST_BARS = 48


def by_half_hour(quarters):
    """``quarters`` gathered in half hours, for a night too long to chart finer."""
    merged = {}
    for quarter in quarters:
        start = quarter["start"]
        start = start.replace(minute=start.minute - start.minute % 30)
        bucket = merged.setdefault(start, {"start": start, "ahead": 0, "till": 0, "total": 0})
        for field in ("ahead", "till", "total"):
            bucket[field] += quarter[field]
    return list(merged.values())


def arrivals_label(count):
    return ngettext("%(count)s arrival", "%(count)s arrivals", count) % {"count": count}


def timeline_geometry(bars, minutes, split, rush):
    """
    One night's arrivals as bars in time, everything the SVG needs, precomputed.

    One bar per quarter of an hour (per half hour on a very long night). With
    ``split``, each bar is stacked from the two ways its tickets were sold —
    bought ahead at the bottom, sold at the till on top — parted by a two-pixel
    gap in the page's own colour rather than an outline. The rush, the
    ``rush`` bar, carries its count; the others show theirs on hover, over a
    full-height band that is easier to aim at than a thin bar.

    Hours are marked on the bars' edges, where they fall: the bar right of
    ``22:00`` is the one that starts then.
    """
    width, height = 960, 280
    left, right, top, bottom = 46, 10, 30, 32
    plot_w, plot_h = width - left - right, height - top - bottom
    band = plot_w / len(bars)
    bar_w = min(22, band * 0.72)
    step, scale_top = nice_scale(max(bar["total"] for bar in bars))
    baseline = top + plot_h

    def tall(value):
        # A single arrival still shows, against a peak of hundreds.
        return max(2, plot_h * value / scale_top) if value else 0

    drawn = []
    for index, bar in enumerate(bars):
        x = left + index * band + (band - bar_w) / 2
        parts = [(kind, bar[kind]) for kind in ("ahead", "till")] if split else [("all", bar["total"])]
        parts = [(kind, value) for kind, value in parts if value]
        pieces = []
        floor = baseline
        for number, (kind, value) in enumerate(parts):
            piece_top = floor - tall(value)
            pieces.append({
                "kind": kind,
                "d": bar_path(x, bar_w, piece_top, floor, rounded=number == len(parts) - 1),
            })
            # The next piece sits on a gap, not on this one.
            floor = piece_top - 2
        bar_top = floor + 2
        title = "{} · {}".format(span_label(bar["start"], minutes), arrivals_label(bar["total"]))
        if split and bar["total"]:
            title += " · {} {} · {} {}".format(
                SOLD["ahead"], bar["ahead"], SOLD["till"], bar["till"]
            )
        drawn.append({
            "band_x": px(left + index * band),
            "band_w": px(band),
            "cx": px(left + index * band + band / 2),
            "label_y": px(bar_top - 8),
            "count": bar["total"],
            "title": title,
            "is_rush": bar["start"] == rush,
            "pieces": pieces,
        })

    hours = [index for index, bar in enumerate(bars) if bar["start"].minute == 0]
    # Every hour on an evening's worth of bars, every other one past that.
    if len(hours) > 12:
        hours = [index for index in hours if bars[index]["start"].hour % 2 == 0]

    def y(value):
        return round(top + plot_h * (1 - value / scale_top), 1)

    return {
        "width": width,
        "height": height,
        "plot_left": left,
        "plot_right": left + plot_w,
        "plot_top": top,
        "plot_h": plot_h,
        "ylabel_x": left - 8,
        "baseline": baseline,
        "bars": drawn,
        "yticks": [{"y": px(y(v)), "label": v} for v in range(step, scale_top + 1, step)],
        "xticks": [
            {"x": px(left + index * band), "label": f"{bars[index]['start']:%H:%M}"}
            for index in hours
        ],
        "xlabel_y": height - 10,
    }


def percent(part, whole):
    """A share as a whole percentage, or ``None`` with nothing to share."""
    return round(100 * part / whole) if whole else None


class EventArrivalsView(EventPermissionRequiredMixin, TemplateView):
    """
    One event's arrivals: the evening seen from the door, for whoever reviews it.

    Behind the permission to read orders, like the till sales next to it in
    the menu: who came in is read off the tickets. Strictly read-only, like the
    organizer's page.

    In a series, one date: the one asked for, or tonight's, which the door
    screen counts too. Of an event's check-in lists, the one asked for, or the
    one the till checks its sales into, as the door screen does.
    """

    template_name = "pretix_openpos/event_arrivals.html"
    permission = "event.orders:read"

    def chosen_subevent(self):
        from .api.views import evening_subevent

        event = self.request.event
        if not event.has_subevents:
            return None
        raw = self.request.GET.get("subevent", "")
        if raw.isdigit():
            asked = event.subevents.filter(pk=int(raw)).first()
            if asked is not None:
                return asked
        return evening_subevent(event)

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        event = self.request.event
        subevent = self.chosen_subevent()
        lists = lists_of(event, subevent)
        asked = self.request.GET.get("list", "")
        clist = next((c for c in lists if str(c.pk) == asked), None) or door_list(
            event, subevent, lists
        )
        ctx.update(
            subevent=subevent,
            subevents=(
                list(event.subevents.order_by("-date_from")[:200])
                if event.has_subevents else []
            ),
            lists=lists,
            clist=clist,
            computed_at=now(),
            over=is_over(event, subevent),
        )
        if clist is None:
            return ctx

        figures = attendance(clist, subevent)
        timeline = arrivals(clist, subevent)
        # The doors' own counts, as the door screen reads them: every list of
        # the event, narrowed to the date its door keeps.
        scope = clist.subevent or subevent
        scans = door_scans(event, None, scope)
        reasons = refusals(event, scope)

        ctx["figures"] = figures
        ctx["entered_percent"] = percent(figures["entered"], figures["expected"])
        ctx["missing_percent"] = percent(figures["not_arrived"], figures["expected"])
        ctx["items"] = [
            {**item, "percent": percent(item["entered"], item["expected"])}
            for item in figures["items"]
        ] if len(figures["items"]) > 1 else []
        ctx["scans"] = scans
        ctx["reasons"] = reasons
        ctx["refused"] = scans["event"]["refused"]

        # Both ways of buying in, or there is nothing to tell apart: a night
        # with no sale at the till is drawn in one colour, with no legend.
        split = 0 < timeline["till"] < timeline["total"]
        ctx["split"] = split
        ctx["till"] = timeline["till"]
        ctx["ahead"] = timeline["total"] - timeline["till"]
        ctx["sold"] = SOLD

        nights = []
        for night in timeline["nights"]:
            bars, minutes = night["quarters"], QUARTER
            if len(bars) > MOST_BARS:
                bars, minutes = by_half_hour(bars), 30
            rush_start = night["rush"]["start"]
            if minutes != QUARTER:
                rush_start = rush_start.replace(minute=rush_start.minute - rush_start.minute % 30)
            running = 0
            rows = []
            for bar in bars:
                running += bar["total"]
                rows.append({**bar, "label": span_label(bar["start"], minutes), "cumulative": running})
            nights.append({
                "date": night["date"],
                "total": night["total"],
                "till": night["till"],
                "ahead": night["total"] - night["till"],
                "minutes": minutes,
                "rows": rows,
                "chart": timeline_geometry(bars, minutes, split, rush_start),
                "rush": night["rush"],
            })
        ctx["nights"] = nights

        if nights:
            # The busiest quarter of the whole event; the first one on a tie,
            # when the queue formed.
            busiest = max(nights, key=lambda night: night["rush"]["total"])
            ctx["rush"] = {
                "label": span_label(busiest["rush"]["start"]),
                "count": busiest["rush"]["total"],
                "date": busiest["date"] if len(nights) > 1 else None,
            }

        room = timeline["room"]
        if room is not None:
            ctx["room"] = {
                "count": room["count"],
                "at": room["at"].astimezone(event.timezone).strftime("%H:%M"),
            }
        return ctx


class ArrivalsView(OrganizerDetailViewMixin, TemplateView):
    """
    Strictly read-only: a ``TemplateView`` with no ``post()`` answers anything
    but GET/HEAD with 405, and nothing below ever writes.
    """

    template_name = "pretix_openpos/arrivals.html"

    #: Most evenings listed. A table is for finding an evening, and the ones
    #: anybody looks for are the last few; each row costs a count of its own.
    MOST_ROWS = 30

    def dispatch(self, request, *args, **kwargs):
        # Same gate as pretix's own organizer-level plugin screens: the
        # middleware has already checked that the user belongs to this
        # organizer at all; this narrows to the events whose orders they may
        # read, and the page aggregates over exactly that set — a team scoped
        # to some events sees a chart of those events, not of everything.
        self.readable_events = request.user.get_events_with_permission(
            "event.orders:read", request=request
        ).filter(organizer=request.organizer)
        if not self.readable_events.exists():
            raise PermissionDenied()
        return super().dispatch(request, *args, **kwargs)

    def evenings(self):
        """
        Every evening that has begun, newest first: each plain event, and each
        date of a series, as its own row — a series' dates are evenings of
        their own, and the door counts them one by one.
        """
        started = Q(date_from__lte=now())
        found = [
            (event.date_from, event, None)
            for event in self.readable_events.filter(started, has_subevents=False)
        ]
        found += [
            (subevent.date_from, subevent.event, subevent)
            for subevent in SubEvent.objects.filter(
                started, event__in=self.readable_events.filter(has_subevents=True)
            ).select_related("event").order_by("-date_from")[: self.MOST_ROWS]
        ]
        found.sort(key=lambda row: row[0], reverse=True)
        return [(event, subevent) for _date, event, subevent in found[: self.MOST_ROWS]]

    def evening_row(self, event, subevent):
        """
        One evening's headline figures, from the calculation its own page
        reads, so the row and the page it leads to say the same.

        Kept for a while once the evening is over, when they stop moving;
        worked out afresh on every load while it is on.
        """
        clist = door_list(event, subevent)
        row = {"event": event, "subevent": subevent, "over": is_over(event, subevent)}
        if clist is None:
            # Nothing to count people on; said in the row rather than zeros.
            return {**row, "expected": None}
        key = "pretix_openpos:arrivals:evening:{}:{}:{}".format(
            event.pk, subevent.pk if subevent else "", clist.pk
        )
        figures = cache.get(key) if row["over"] else None
        if figures is None:
            counted = attendance(clist, subevent)
            timeline = arrivals(clist, subevent)
            busiest = max(
                (night["rush"] for night in timeline["nights"]),
                key=lambda rush: rush["total"],
                default=None,
            )
            figures = {
                "entered": counted["entered"],
                "expected": counted["expected"],
                "till": timeline["till"],
                "rush": span_label(busiest["start"]) if busiest else None,
                "rush_count": busiest["total"] if busiest else 0,
            }
            if row["over"]:
                cache.set(key, figures, HISTOGRAM_TTL)
        row.update(figures, percent=percent(figures["entered"], figures["expected"]))
        return row

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        ctx["evening_rows"] = [
            self.evening_row(event, subevent) for event, subevent in self.evenings()
        ]

        plain = self.readable_events.filter(has_subevents=False).filter(_past_q())
        # An event series is "past" through its dates, not the event's own.
        series = self.readable_events.filter(has_subevents=True).filter(
            Exists(SubEvent.objects.filter(_past_q(), event=OuterRef("pk")))
        )
        events = {e.pk: e for e in plain} | {e.pk: e for e in series}

        # Entries only, and only ones that were a person at a door or a till:
        # ``Checkin.objects`` is already limited to successful ones, and
        # auto-check-ins (checked in at payment, nobody walked in) and
        # test-mode orders would both put arrivals at hours nobody arrived.
        scans = (
            Checkin.objects.filter(
                type=Checkin.TYPE_ENTRY,
                auto_checked_in=False,
                position__order__testmode=False,
            )
            .filter(
                Q(list__event__in=list(plain))
                | (Q(list__event__in=list(series)) & _past_q("position__subevent__"))
            )
            .values_list("list__event_id", "datetime")
        )

        # Each event counts in its own timezone: "21:00" must mean 21:00 on
        # the clock at that door, or the histogram answers nothing.
        timezones = {pk: event.timezone for pk, event in events.items()}

        # Keyed on exactly the events that were counted, so a team whose
        # permissions cover a different set gets its own figures rather than
        # somebody else's, and an event turning into a past one produces a new
        # key instead of a stale entry. Named "hours" because the key used to
        # hold the per-event counts too, in a shape this code no longer reads:
        # an entry the previous version left must not be taken for one.
        cache_key = "pretix_openpos:arrivals:hours:{}:{}".format(
            self.request.organizer.pk, ",".join(str(pk) for pk in sorted(events))
        )
        by_hour = cache.get(cache_key)
        if by_hour is None:
            by_hour = [0] * 24
            for event_id, scanned_at in scans.iterator(chunk_size=5000):
                by_hour[scanned_at.astimezone(timezones[event_id]).hour] += 1
            cache.set(cache_key, by_hour, HISTOGRAM_TTL)

        total = sum(by_hour)
        ctx["total"] = total
        ctx["events_count"] = len(events)
        if not total:
            return ctx

        peak = max(range(24), key=by_hour.__getitem__)
        active = [h for h in range(24) if by_hour[h]]
        quiet = min(active, key=by_hour.__getitem__)
        ctx["peak"] = {
            "label": hour_label(peak),
            "count": by_hour[peak],
            "share": round(100 * by_hour[peak] / total),
        }
        # With a single busy hour there is no "quiet" to speak of.
        ctx["quiet"] = (
            {"label": hour_label(quiet), "count": by_hour[quiet]}
            if quiet != peak
            else None
        )

        ctx["chart"] = chart_geometry(by_hour, total)
        ctx["hours"] = [
            {
                "label": hour_label(hour),
                "count": by_hour[hour],
                "share": "{:.1f}".format(100 * by_hour[hour] / total),
            }
            for hour in range(24)
        ]
        return ctx
