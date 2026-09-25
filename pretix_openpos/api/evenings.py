"""
When tonight is: the till day, and the date of a series a till sells for.

The six in the morning every evening's figures are cut at, and, in a series,
the date a sale is booked against and the evening's figures are about. Read by
the catalogue, the card reader and the checkout, and by the back office's
takings, drawers and arrivals.
"""
from datetime import datetime, time, timedelta

from django.utils.timezone import make_aware, now
from django.utils.translation import gettext_lazy as _
from rest_framework.exceptions import ValidationError

#: Where one till day ends and the next begins, in the event's timezone.
#:
#: Six in the morning, not midnight: a till serves an evening, and an evening
#: crosses midnight. At 01:30 the drawer still holds everything taken since the
#: doors opened, so the figure it reconciles against must not have reset at
#: 00:00 — which is exactly the mistake the history screen used to make. Six is
#: late enough that any night has ended, early enough that none has begun.
#: (Chosen safely clear of DST switches, which happen at 2–3 am.)
BUSINESS_DAY_STARTS_AT = time(6, 0)


def start_of_business_day(event, at=None):
    """
    The start of the night ``at`` belongs to: 6 am on the day that night began.

    What sorts the takings into evenings, and a series' sales into its dates.
    ``at`` is the moment being asked about, defaulting to this one. A sale
    replayed the next morning has to be placed in the night it was rung up in,
    not the one it arrives in.
    """
    local = (at or now()).astimezone(event.timezone)
    day = local.date()
    if local.time() < BUSINESS_DAY_STARTS_AT:
        day -= timedelta(days=1)
    return make_aware(datetime.combine(day, BUSINESS_DAY_STARTS_AT), event.timezone)


def selling_subevent(event, at=None, *, settled=False):
    """
    Which date of a series the till is selling for, or ``None`` for a plain event.

    A door till sells for tonight and nothing else. Whoever is standing at it
    has one queue in front of them and no business picking a date off a list
    between customers, so the server picks it — the same way it picks every
    price. The app has never sent either, and this does not change that.

    "Tonight" is the business day the rest of this system runs on: six in the
    morning to six the next. A door still selling at one o'clock is selling
    for the evening that is still going on, not for the next one. Within that
    window the date that has already started wins over one still to come, and
    a date that runs past the window — a festival day with no end time, or one
    ending in the small hours — still counts while it is on.

    ``at`` is the moment the money moved, so a sale replayed the next morning
    is booked against the night it was rung up in rather than the one it
    arrives in. ``settled`` says that money has already changed hands: nothing
    is refused then, because refusing does not give it back, it only strands
    the sale outside pretix. The nearest date is used instead.

    Otherwise this raises, and the refusal belongs at the catalogue, where a
    volunteer meets it while setting up. pretix used to raise it at the payment
    instead, in front of a customer, in the form "the product is not assigned
    to a quota" — which names the wrong cause entirely.
    """
    if not event.has_subevents:
        return None

    moment = at or now()
    opened = start_of_business_day(event, moment)
    closes = opened + timedelta(days=1)
    # Bounded because a season can hold hundreds of dates and only the ones
    # around this evening can win. Ordered so the last to have started is the
    # first considered.
    candidates = list(
        event.subevents.filter(active=True, date_from__lt=closes)
        .order_by("-date_from")[:20]
    )

    def ends(subevent):
        # A date with no end time runs to the end of its own night, not to the
        # instant it started. Most organisers never fill the end in, and
        # treating the date as over the moment the doors open would send every
        # sale after that to the next evening in the series.
        if subevent.date_to:
            return subevent.date_to
        return start_of_business_day(event, subevent.date_from) + timedelta(days=1)

    # Started already and not over: the one the queue outside is for. The most
    # recently started, so two dates overlapping resolve to the later.
    for subevent in candidates:
        if subevent.date_from <= moment and ends(subevent) >= moment:
            return subevent
    # Otherwise the next one tonight — a door sells before it opens.
    upcoming = [s for s in candidates if s.date_from > moment and s.date_from >= opened]
    if upcoming:
        return upcoming[-1]

    if settled:
        # Whatever is closest to when the money moved. A guess, and said to be
        # one — but a sale that cannot be booked at all is worse than one
        # booked against the neighbouring date, which somebody can move.
        nearest = min(
            event.subevents.filter(active=True),
            key=lambda s: abs(s.date_from - moment),
            default=None,
        )
        if nearest is not None:
            return nearest

    raise ValidationError(
        {
            "detail": [
                _("Nothing is on tonight. This event is a series, and the till "
                  "sells for the date that is on — add one for tonight, or "
                  "check that it is switched on.")
            ],
            "code": "series_closed",
        }
    )


def evening_subevent(event):
    """
    The date of a series that the evening's figures are about, or ``None``.

    ``None`` for a plain event: its figures are the whole event's. In a series,
    the date the till sells for tonight, or failing that the nearest one, as for
    a sale already paid: a figure has to be about some date, and nothing is
    refused for it. ``None`` too for a series with no date switched on, whose
    figures are then the whole series'.
    """
    if not event.has_subevents:
        return None
    try:
        return selling_subevent(event, settled=True)
    except ValidationError:
        return None
