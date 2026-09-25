"""
How much one paired device may ask of the Open POS API.

A till is a tablet left on a counter all evening with a token in it, and
nothing used to bound what that token could send: a page stuck in a reload
loop, a script lifted off a lost tablet, or a till draining a queue with a bug
in it could each keep the server's handful of workers to themselves. The
answer to that is a budget per device, not a smaller one per endpoint: what a
till does in a minute is spread over several endpoints, and it is the total
that decides whether the others still get served.

Generous on purpose. A till polling its reader every two seconds while it
drains a hundred sales it queued with no network makes about a hundred and
fifty requests in the worst minute of its evening, and must never be told to
wait for that; the budget is four times as much. What it stops is a device
asking ten times a second for a minute on end, which nothing the app does
comes close to.

Counted in pretix' cache, which is what every worker process shares — Redis
or memcached on a pretix set up for production. On one with neither, pretix'
cache keeps nothing and nothing is ever counted, so nothing is ever refused:
the budget is there to protect a production server, and a server without a
real cache has no way to count across its workers anyway.
"""
import math

from django.utils.translation import gettext_lazy as _
from pretix.base.models import Device
from rest_framework.exceptions import APIException, Throttled
from rest_framework.throttling import SimpleRateThrottle


class DeviceRateThrottle(SimpleRateThrottle):
    """
    One budget per paired device, spent by every Open POS endpoint alike.

    Only a device is counted. A team token or somebody signed into the back
    office is an organizer's own script or browser, which the organizer is in
    a position to stop; a till is a tablet on a counter, which they are not,
    not from where they are standing.
    """

    scope = "openpos_device"
    #: Set here rather than in ``THROTTLE_RATES``: that belongs to pretix'
    #: ``REST_FRAMEWORK`` settings, which a plugin has no business rewriting,
    #: and which do not have it.
    rate = "600/min"

    def get_cache_key(self, request, view):
        if not isinstance(request.auth, Device):
            return None
        return self.cache_format % {"scope": self.scope, "ident": request.auth.pk}


class RateLimited(Throttled):
    """
    A 429 the app can read like any other refusal: a sentence and a code.

    DRF's own answer is a sentence only, with the wait written into it. The
    wait is in ``Retry-After`` already, which is what a client acts on, and the
    code is what tells the app this is "not now" rather than "no": a sale
    answered this is kept in the queue and sent again, never listed as refused.
    """

    def __init__(self, wait=None):
        APIException.__init__(
            self,
            {
                "detail": _("This device is sending too many requests. Try again in a moment."),
                "code": "rate_limited",
            },
        )
        # What DRF's exception handler turns into the Retry-After header.
        self.wait = None if wait is None else math.ceil(wait)


class DeviceThrottleMixin:
    """For every viewset of the Open POS API: one budget, and a readable 429."""

    throttle_classes = [DeviceRateThrottle]

    def throttled(self, request, wait):
        raise RateLimited(wait)
