"""
Who came through the door, counted once for the door and for the back office.

The door screen asks how many people are in and what each phone has scanned;
the back office asks the same about a whole evening, and when people came.
Both read the functions here, so an evening cannot have two answers: the
arrivals the back office charts add up to the "admitted" figure a phone shows,
and the refusals it breaks down add up to that phone's "refused" column.

Everything is read from pretix' own check-in rows, so every scanning app counts
the same — this plugin's door screen, pretixSCAN, anything else. Nothing here
writes.
"""
from datetime import timedelta

from django.db.models import Count, Exists, F, OuterRef, Q
from django.utils.timezone import now
from django.utils.translation import pgettext_lazy
from django_scopes import scopes_disabled
from pretix.base.models import Checkin, Device

from .channels import POS_CHANNEL

#: How late a scan may reach the server and still be taken for a live one.
#:
#: pretix' own threshold, from ``Checkin.is_late_upload``. It matters for the
#: scans that were queued with no network before this plugin sent them the way
#: pretix expects offline scans to be sent: those carry no offline flag, and
#: the gap between the moment of the scan and the moment it arrived is the only
#: trace that they waited on a device.
LATE_UPLOAD = timedelta(minutes=2)

#: A scan made with no network, then sent: flagged by the device that sent it,
#: or visibly late.
SENT_AFTER_THE_FACT = Q(force_sent=True) | Q(created__gt=F("datetime") + LATE_UPLOAD)

#: The span arrivals are counted in, and the one the evening's rush is named in.
#:
#: A quarter of an hour, because that is what a door is staffed by: an hour
#: hides the rush inside it — forty people in the ten minutes after the first
#: band goes on stage read as a calm hour — and five minutes is noise.
QUARTER = 15


def door_scope(event, subevent=None):
    """
    The check-in rows a door scanned for ``event``: what :func:`door_scans`
    and :func:`refusals` both count, so the two agree to the ticket.

    A scan is a check-in that came through the check-in API with a code in it:
    a scanning app, this one or pretixSCAN. The check-in written at the till
    with a sale is not one — nobody scanned anything — and neither is an
    automatic or a back-office one, which is exactly the set of rows that
    carries no ``raw_source_type``. Entries only: a door counts people coming
    in.

    In a series, ``subevent`` narrows it to one date: its doors, and its
    tickets at doors kept for every date.
    """
    scope = Q(list__event=event, type=Checkin.TYPE_ENTRY, raw_source_type__isnull=False)
    if subevent is not None:
        scope &= Q(list__subevent=subevent) | Q(
            list__subevent__isnull=True, position__subevent=subevent
        )
    return scope


def door_scans(event, device, subevent=None):
    """
    What the doors have scanned for this event, per device and in all.

    Read from pretix' own check-in rows rather than counted by the app: a count
    kept in a browser is gone whenever iOS reloads the page, and that is what a
    door found out on its first evening — the figure on the scanner went back
    to zero every time somebody stepped out of the app for a while. The rows
    are there anyway; counting them is the figure that cannot be lost.

    The whole event, whenever the scan was made. It used to be tonight only,
    from six in the morning like the takings, so a phone that had let seventy
    people in read zero on every day after, on that very event.
    """
    admitted = Q(successful=True, position__item__admission=True)
    with scopes_disabled():
        rows = list(
            Checkin.all.filter(door_scope(event, subevent))
            .order_by()
            .values("device_id")
            .annotate(
                admitted=Count("pk", filter=admitted),
                # Recorded, but for a product that lets nobody in: the T-shirt
                # scanned at a list that takes every product.
                other=Count("pk", filter=Q(successful=True, position__item__admission=False)),
                refused=Count("pk", filter=Q(successful=False)),
                offline=Count("pk", filter=admitted & SENT_AFTER_THE_FACT),
            )
        )
        names = dict(
            Device.objects.filter(
                pk__in=[row["device_id"] for row in rows if row["device_id"]]
            ).values_list("pk", "name")
        )

    fields = ("admitted", "refused", "other", "offline")

    def figures(row):
        return {field: row[field] if row else 0 for field in fields}

    by_device = {row["device_id"]: row for row in rows}
    devices = [
        {
            # None for scans made from the back office, which have no device.
            # The id is what pretix' check-in history filters a device by.
            "id": pk,
            "name": names.get(pk) if pk else None,
            "current": device is not None and pk == device.pk,
            **figures(row),
        }
        for pk, row in by_device.items()
    ]
    devices.sort(key=lambda d: (-d["admitted"], d["name"] is None, d["name"] or ""))
    return {
        "device": figures(by_device.get(device.pk)) if device else None,
        "event": {field: sum(row[field] for row in rows) for field in fields},
        "devices": devices,
    }


def refusals(event, subevent=None):
    """
    Why the doors turned tickets away, the most frequent reason first.

    The refused column of :func:`door_scans`, broken down: the same rows, so
    the reasons add up to it. Worded by pretix itself, which names each reason
    in the language of whoever is reading.

    The reason is what an evening's refusals mean. Thirty "already used" are
    tickets shared or photographed and handed on; thirty "unknown" are a door
    scanning the wrong event, or a forgery; a handful of "not paid" is a
    payment somebody should look at before the next event.
    """
    labels = dict(Checkin.REASONS)
    with scopes_disabled():
        rows = (
            Checkin.all.filter(door_scope(event, subevent), successful=False)
            .order_by()
            .values("error_reason")
            .annotate(count=Count("pk"))
        )
        reasons = [
            {
                "reason": row["error_reason"] or "",
                "label": labels.get(row["error_reason"])
                # A reason pretix wrote down without naming one, or one this
                # version of pretix no longer lists.
                or pgettext_lazy("refusal", "Other reason"),
                "count": row["count"],
            }
            for row in rows
        ]
    reasons.sort(key=lambda row: (-row["count"], str(row["label"])))
    return reasons


def narrowed(positions, clist, subevent):
    """
    ``positions`` of ``clist``, narrowed to one date of a series.

    A list kept for one date already holds only that date's tickets. A list
    kept for every date holds the whole season's, and a door counts tonight:
    three thousand tickets expected, for a season, is not a figure anybody at
    a door can use.
    """
    if subevent is not None and clist.subevent_id is None:
        return positions.filter(subevent=subevent)
    return positions


def with_entry_scan(positions, clist):
    """Narrow a position queryset to the ones let in through ``clist``."""
    return positions.annotate(
        checked_in=Exists(
            Checkin.objects.filter(
                list_id=clist.pk,
                position=OuterRef("pk"),
                type=Checkin.TYPE_ENTRY,
            )
        )
    ).filter(checked_in=True)


def attendance(clist, subevent=None):
    """
    How many people are inside right now, and how the room filled up.

    Counts admission products only. A check-in list with ``all_products``
    happily accepts a T-shirt and pretix will dutifully record the scan, but
    a merch line has no door: counting those would answer "how many things
    were scanned" when the question at the door is "how many people are in
    the room". Everything on the screen is derived from that same
    population, so the figures always add up.

    Entry and exit scans are resolved by pretix itself, so a list that scans
    people back out reports the room rather than the turnstile.
    """
    event = clist.event

    # Scopes off for the counting, as pretix does for its own check-in
    # figures: the extra organizer filter inside the EXISTS() subquery
    # tricks PostgreSQL into sequentially scanning every event. Every
    # queryset below is already bounded to this list, hence to this event.
    with scopes_disabled():
        admissions = narrowed(clist.positions.filter(item__admission=True), clist, subevent)
        entered = with_entry_scan(admissions, clist)
        inside = narrowed(
            clist.positions_inside_query().filter(item__admission=True), clist, subevent
        )

        def by_item(qs):
            return {
                row["item"]: row["cnt"]
                for row in qs.order_by().values("item").annotate(cnt=Count("id"))
            }

        expected_by_item = by_item(admissions)
        entered_by_item = by_item(entered)
        inside_by_item = by_item(inside)

        items = [
            {
                "id": item.pk,
                "name": str(item.name),
                "inside": inside_by_item.get(item.pk, 0),
                "entered": entered_by_item.get(item.pk, 0),
                "expected": expected_by_item.get(item.pk, 0),
            }
            for item in event.items.filter(pk__in=list(expected_by_item)).order_by(
                "category__position", "category_id", "position", "pk"
            )
        ]

        # Reported rather than hidden: it is the one thing that explains a
        # figure here differing from the count pretix' own back-office shows.
        non_admission = with_entry_scan(
            narrowed(clist.positions.filter(item__admission=False), clist, subevent), clist
        ).count()

    expected = sum(expected_by_item.values())
    entered_count = sum(entered_by_item.values())
    inside_count = sum(inside_by_item.values())

    return {
        "list": {"id": clist.pk, "name": str(clist.name)},
        "inside": inside_count,
        # Everyone who was let in at least once, whether or not they
        # have since been scanned back out.
        "entered": entered_count,
        "exited": entered_count - inside_count,
        "expected": expected,
        "not_arrived": expected - entered_count,
        "non_admission_entered": non_admission,
        "items": items,
    }


def quarter_of(moment, tz):
    """The quarter of an hour ``moment`` falls in, on the clock at that door."""
    local = moment.astimezone(tz)
    return local.replace(
        minute=local.minute - local.minute % QUARTER, second=0, microsecond=0, tzinfo=None
    )


def arrivals(clist, subevent=None):
    """
    When people came in, a quarter of an hour at a time, night by night.

    One arrival per ticket: the first time it was let in through ``clist``. A
    ticket scanned out and back in is somebody coming back, not somebody
    arriving, so an evening's arrivals add up to the "admitted" figure of
    :func:`attendance`, which counts the tickets let in at least once — from
    the same tickets, on the same list.

    Each arrival says how its ticket was sold: at a till (the Open POS channel
    — bought at the door, where the till checks it in with the sale), or ahead
    of time through any other channel, the online shop first of all. The door
    sales are the ones that hold a queue up; when they happen is worth seeing.

    Nights run from six in the morning to six the next, as the takings do: an
    evening crosses midnight, and its half past midnight belongs to it.

    ``room`` replays entries and exits in order, the way pretix decides who is
    inside — a ticket is in while its last check-in on the list is an entry —
    to find the fullest the room got. That differs from the arrivals only once
    somebody has been scanned out, which is the one case it is shown in.
    """
    from .api.views import start_of_business_day

    event = clist.event
    tz = event.timezone
    with scopes_disabled():
        admissions = narrowed(clist.positions.filter(item__admission=True), clist, subevent)
        rows = (
            Checkin.objects.filter(
                list=clist,
                type__in=(Checkin.TYPE_ENTRY, Checkin.TYPE_EXIT),
                position__in=admissions.values("pk"),
            )
            .order_by("datetime", "pk")
            .values_list(
                "position_id", "type", "datetime",
                "position__order__sales_channel__identifier",
            )
        )

        nights = {}
        arrived = set()
        inside = set()
        exits = 0
        fullest = {"count": 0, "at": None}
        for position, kind, moment, channel in rows.iterator(chunk_size=5000):
            if kind == Checkin.TYPE_EXIT:
                exits += 1
                inside.discard(position)
                continue
            inside.add(position)
            if len(inside) > fullest["count"]:
                fullest = {"count": len(inside), "at": moment}
            if position in arrived:
                continue
            arrived.add(position)
            night = start_of_business_day(event, moment)
            slots = nights.setdefault(night, {})
            quarter = slots.setdefault(quarter_of(moment, tz), {"ahead": 0, "till": 0})
            quarter["till" if channel == POS_CHANNEL else "ahead"] += 1

    return {
        "total": len(arrived),
        "till": sum(q["till"] for slots in nights.values() for q in slots.values()),
        "nights": [night_of(start, slots) for start, slots in sorted(nights.items())],
        "room": fullest if exits else None,
    }


def night_of(start, slots):
    """
    One night's arrivals, every quarter of an hour from the first to the last.

    The quarters nobody came in are kept, as zeros: a chart that skipped them
    would draw half past eleven next to one o'clock, and a gap in the door's
    evening is part of its story.
    """
    step = timedelta(minutes=QUARTER)
    first, last = min(slots), max(slots)
    quarters = []
    moment = first
    while moment <= last:
        counts = slots.get(moment, {"ahead": 0, "till": 0})
        quarters.append({"start": moment, **counts, "total": counts["ahead"] + counts["till"]})
        moment += step
    # The earliest of equals: the rush is when the queue formed.
    rush = quarters[0]
    for quarter in quarters:
        if quarter["total"] > rush["total"]:
            rush = quarter
    return {
        "date": start.date(),
        "quarters": quarters,
        "total": sum(quarter["total"] for quarter in quarters),
        "till": sum(quarter["till"] for quarter in quarters),
        "rush": rush,
    }


def door_list(event, subevent=None, lists=None):
    """
    The list whose figures an event's arrivals are about, or ``None``.

    The one the till checks its sales into, as the door screen does, when it
    is a list of this date; otherwise a list kept for this very date, then one
    kept for every date. ``lists`` are the candidates, when already fetched.
    """
    from .api.views import checkin_list_for

    candidates = lists if lists is not None else lists_of(event, subevent)
    configured = checkin_list_for(event)
    if configured is not None and configured in candidates:
        return configured
    return candidates[0] if candidates else None


def lists_of(event, subevent=None):
    """
    The check-in lists that count people for ``event``, or one date of it.

    A date's own lists first, then those kept for every date, each by name:
    pretix sorts them by date, and databases disagree on where a list with
    no date goes.
    """
    with scopes_disabled():
        lists = list(event.checkin_lists.all())
    if subevent is not None:
        lists = [clist for clist in lists if clist.subevent_id in (None, subevent.pk)]
    return sorted(lists, key=lambda clist: (clist.subevent_id is None, clist.name, clist.pk))


def is_over(event, subevent=None):
    """
    Whether the evening has ended, so nobody still missing is on the way.

    Its end when pretix has one, otherwise the six o'clock that closes the
    night it started in.
    """
    from .api.views import start_of_business_day

    target = subevent or event
    ends = target.date_to or start_of_business_day(event, target.date_from) + timedelta(days=1)
    return ends <= now()
