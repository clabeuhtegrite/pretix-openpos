"""
When do people actually show up at the door?

One read-only page, organizer-level because the question only makes sense
across events: every successful entry scan of every past event, bucketed by
hour of day, so the busy and the dead hours at the entrance are visible at a
glance. It reads pretix's own ``Checkin`` rows, so it counts every scanning
app the same — this plugin's door screen, pretixSCAN, anything else.

The page writes nothing and never will: it grew out of wanting to staff the
door right, and a staffing decision needs a chart, not a form.
"""

from collections import defaultdict

from django.core.cache import cache
from django.core.exceptions import PermissionDenied
from django.db.models import Exists, OuterRef, Q
from django.utils.timezone import now
from django.views.generic import TemplateView
from pretix.base.models import Checkin, SubEvent
from pretix.control.views.organizer import OrganizerDetailViewMixin

#: How long a computed histogram is reused.
#:
#: The page reads every entry scan of every *past* event, which on an organizer
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

    # Clean y ticks: the smallest 1/2/5-step that fits the maximum in at most
    # five intervals, so the axis reads as counting, not as measuring.
    peak_value = max(by_hour)
    for step in (1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000):
        if peak_value / step <= 5:
            break
    else:
        step = 10 ** len(str(peak_value))
    scale_top = step * -(-peak_value // step)  # ceil

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
        bar = {
            "band_x": px(left + hour * band),
            "band_w": px(band),
            "cx": px(cx),
            "label_y": px(min(bar_top, baseline) - 8),
            "count": value,
            "title": "{} · {} · {:.1f} %".format(
                hour_label(hour), value, 100 * value / total
            ),
            "is_peak": hour == peak_hour and value > 0,
            "d": None,
        }
        if value > 0:
            h = baseline - bar_top
            if h >= 6:
                # Rounded at the top only: the baseline is ground, not data.
                bar["d"] = (
                    f"M{x},{baseline} V{round(bar_top + 4, 1)} "
                    f"Q{x},{bar_top} {round(x + 4, 1)},{bar_top} "
                    f"H{round(x + bar_w - 4, 1)} "
                    f"Q{round(x + bar_w, 1)},{bar_top} {round(x + bar_w, 1)},{round(bar_top + 4, 1)} "
                    f"V{baseline} Z"
                )
            else:
                bar["d"] = f"M{x},{baseline} V{bar_top} H{round(x + bar_w, 1)} V{baseline} Z"
        bars.append(bar)

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


class ArrivalsView(OrganizerDetailViewMixin, TemplateView):
    """
    Strictly read-only: a ``TemplateView`` with no ``post()`` answers anything
    but GET/HEAD with 405, and nothing below ever writes.
    """

    template_name = "pretix_openpos/arrivals.html"

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

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)

        plain = self.readable_events.filter(has_subevents=False).filter(_past_q())
        # An event series is "past" through its dates, not the event's own.
        series = self.readable_events.filter(has_subevents=True).filter(
            Exists(SubEvent.objects.filter(_past_q(), event=OuterRef("pk")))
        )
        events = {e.pk: e for e in plain} | {e.pk: e for e in series}

        # Entry scans only, and only ones that were a person at a door:
        # ``Checkin.objects`` is already limited to successful scans, and
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
        # key instead of a stale entry.
        cache_key = "pretix_openpos:arrivals:{}:{}".format(
            self.request.organizer.pk, ",".join(str(pk) for pk in sorted(events))
        )
        counted = cache.get(cache_key)
        if counted is None:
            by_hour = [0] * 24
            per_event = defaultdict(lambda: [0] * 24)
            for event_id, scanned_at in scans.iterator(chunk_size=5000):
                hour = scanned_at.astimezone(timezones[event_id]).hour
                by_hour[hour] += 1
                per_event[event_id][hour] += 1
            cache.set(cache_key, (by_hour, dict(per_event)), HISTOGRAM_TTL)
        else:
            by_hour, per_event = counted

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

        rows = []
        for pk, event in events.items():
            counts = per_event.get(pk)
            event_total = sum(counts) if counts else 0
            rows.append(
                {
                    "event": event,
                    "count": event_total,
                    "peak": hour_label(max(range(24), key=counts.__getitem__))
                    if event_total
                    else None,
                }
            )
        rows.sort(key=lambda row: row["event"].date_from, reverse=True)
        ctx["event_rows"] = rows
        return ctx
