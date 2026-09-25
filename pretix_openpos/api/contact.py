"""
Who is calling: when a device was last heard from, and what a caller may reach.

A device's last contact, written down as its requests arrive, and the clock it
is answered with; the events a caller may see, and whether one of them runs the
till at all. For the two viewsets of :mod:`.views`.
"""
import logging
from datetime import timezone as dt_timezone

from django.core.cache import cache
from django.db import transaction
from django.utils.timezone import now
from pretix.base.models import Device, TeamAPIToken

from ..models import PosDevice

logger = logging.getLogger(__name__)


def plugin_enabled(event) -> bool:
    return "pretix_openpos" in event.get_plugins()


#: How often, at most, a device's last contact is written down, in seconds.
#:
#: A till polls several endpoints a minute. One write a minute per device is
#: plenty to say "last heard from at 21:14", and keeps a busy evening from
#: turning every read the tills make into a write.
CONTACT_EVERY = 60

#: Cache key holding a device's contact throttle; see :func:`note_contact`.
CONTACT_KEY = "pretix_openpos:seen:{}"


def note_contact(request):
    """
    Write down that the device behind this request has just reached the server.

    Called from the viewsets' ``initial``, once authentication, permissions and
    throttling have let the request through, so it covers every Open POS
    endpoint and nothing else writes it. At most once a minute per device:
    ``cache.add`` succeeds for the first caller of the minute only, so the
    database sees one short UPDATE a minute per tablet whatever the app is
    polling. Anything that is not a device — a team token, somebody logged in
    trying the API — is nobody's till and is not recorded.

    It must never cost the till its request. The sale being rung up matters
    more than knowing when the tablet was last heard from, so a cache that is
    down, a database hiccup, or two first calls racing to create the row are
    logged and forgotten. The write runs in a savepoint of its own for the
    same reason: a failed statement inside a transaction the request already
    holds would poison everything after it.

    The row is created by id rather than through the device object: that way
    the device keeps no cached copy of a row that might not have been
    written, and whatever reads its role next reads it from the database —
    the role and the reader are what decide which card payments this till may
    take.
    """
    device = request.auth
    if not isinstance(device, Device):
        return
    try:
        if not cache.add(CONTACT_KEY.format(device.pk), True, CONTACT_EVERY):
            return
        moment = now()
        with transaction.atomic():
            if not PosDevice.objects.filter(device_id=device.pk).update(last_seen_at=moment):
                PosDevice.objects.create(device_id=device.pk, last_seen_at=moment)
    except Exception:
        logger.warning(
            "Open POS could not write down the last contact of device %s", device.pk,
            exc_info=True,
        )


def utc_timestamp(moment):
    """
    ``2026-09-25T21:14:03.120Z``: the shape of JavaScript's ``toISOString()``.

    Milliseconds rather than Python's microseconds, because that is the one
    form every browser's ``Date`` is required to parse, Safari included.
    """
    return moment.astimezone(dt_timezone.utc).isoformat(timespec="milliseconds").replace(
        "+00:00", "Z"
    )


def reachable_events(request):
    """
    The events this caller may see at all, decided the way pretix decides it.

    Mirrors pretix' own event list: a device or a team token by its own
    access, anybody else by their teams. The answer now names events that
    are not on sale yet, so it must not name one the caller has no access to.
    """
    if isinstance(request.auth, (Device, TeamAPIToken)):
        return request.auth.get_events_with_any_permission()
    return request.user.get_events_with_any_permission(request).filter(
        organizer=request.organizer
    )
