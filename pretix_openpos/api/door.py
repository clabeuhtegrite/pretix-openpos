"""
The door: who is inside.

:class:`DoorActions` holds the count of the room a device keeping the door
reads, and the check-in list it is asked about.

Up to 0.29 it also handed a door the guest list — every ticket's secret, name
and state — to scan against with the network gone. Scans went missing that
way, and since 0.30 the door answers no ticket without pretix: the list is not
given out any more, and the app drops the copy an earlier build kept.
"""
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Device
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from ..attendance import attendance, door_scans
from .catalog import checkin_list_for
from .evenings import evening_subevent


class DoorActions:
    """The door's head count, for a device that works at it."""

    # -- attendance --------------------------------------------------------

    @action(detail=False, methods=["get"], url_path="attendance", url_name="attendance")
    def attendance(self, request, **kwargs):
        """
        How many people are inside right now, and how the room filled up.

        Counted by :func:`pretix_openpos.attendance.attendance`, which the
        back office's arrivals page reads too, so the door and the office
        cannot disagree about an evening. In a series, the date this door's
        list is kept for; on a list for every date, tonight's rather than the
        whole season's.

        ``scans`` rides along for the scanner's own counter: what this device
        and every door have scanned for the event, on every list of it. It is
        here rather than behind an endpoint of its own because the door screen
        already asks for this after every scan and every minute, and the two
        figures are read side by side.
        """
        event = request.event
        clist = self._requested_checkin_list(request)
        if clist is None:
            raise ValidationError({"list": [_("Unknown check-in list.")]})

        subevent = clist.subevent or evening_subevent(event)
        return Response(
            {
                **attendance(clist, subevent),
                "computed_at": now().isoformat(),
                "scans": door_scans(
                    event,
                    request.auth if isinstance(request.auth, Device) else None,
                    subevent,
                ),
            }
        )

    # -- helpers -----------------------------------------------------------

    def _requested_checkin_list(self, request):
        """
        The list the app is scanning on, defaulting to the one sales check into.

        Returns ``None`` for an unknown or malformed id rather than falling back
        to another list: a door count is only worth anything if the operator
        knows which door it is counting.
        """
        raw = request.query_params.get("list")
        if not raw:
            return checkin_list_for(request.event)
        try:
            pk = int(raw)
        except (TypeError, ValueError):
            return None
        return request.event.checkin_lists.filter(pk=pk).first()
