"""
The door: the guest list a device carries offline, and who is inside.

:class:`DoorActions` holds the two actions a device keeping the door reads —
the snapshot that lets it scan with the network gone, and the count of the
room — and the check-in list both of them are asked about.
"""
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from django_scopes import scopes_disabled
from pretix.base.models import Checkin, Device
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from ..attendance import attendance, door_scans
from ..models import PosDevice
from .catalog import checkin_list_for
from .evenings import evening_subevent

#: Most tickets a till will carry for offline scanning.
#:
#: The whole point is to survive a dropout at a door, and the doors this runs at
#: sell in the hundreds. Well past that the snapshot stops being something to
#: hold in a browser, and saying so beats a silently partial guest list.
OFFLINE_SNAPSHOT_LIMIT = 20000


def offline_restrictions(position):
    """
    What pretix refuses this ticket for at every door, for a guest list to carry.

    A ticket blocked in the back office, or only valid from or until a given
    moment, is refused online — and was let in with no network, since the guest
    list said nothing about it. The moments are sent rather than applied here:
    the app checks them against its own clock at the time of the scan, so a
    ticket that becomes valid in the middle of a dropout walks in when it does.

    Only when set, which is almost never, so that the list a phone downloads
    does not grow by three empty keys per ticket.
    """
    restrictions = {}
    if position.blocked:
        restrictions["blocked"] = True
    if position.valid_from:
        restrictions["valid_from"] = position.valid_from.isoformat()
    if position.valid_until:
        restrictions["valid_until"] = position.valid_until.isoformat()
    return restrictions


class DoorActions:
    """The door's guest list and head count, for a device that works at it."""

    # -- offline snapshot ---------------------------------------------------

    @action(detail=False, methods=["get"], url_path="offline", url_name="offline")
    def offline(self, request, **kwargs):
        """
        Everything a till needs to keep working with the network gone.

        Two halves. The tariff is already in the catalogue the app caches, so
        what is missing is the door: which secrets are valid on this list, what
        they admit, and who they belong to. Downloaded while the connection is
        there so that a dropout is survivable rather than merely detectable.

        This is the guest list, and it leaves the server: the payload is
        therefore the narrowest one that still answers a scan — no e-mail, no
        order code, no price. A device token already reaches the same data one
        scan at a time through pretix' own search endpoint; this only makes it
        usable when there is nothing to ask.

        Only for a device that works at the door. Every ticket's secret is in
        it, and a secret is a ticket: whoever holds the list can print their
        way in. The bar till has no door to keep and scans nothing, yet it
        used to fetch the whole list every five minutes and keep it in the
        browser, where it stays after the tablet is unpaired. Refused with a
        code rather than an empty list, so the app knows to throw away the
        copy it already has — which an empty answer, or a plain 403 it would
        read as a network problem, would not tell it.
        """
        device = request.auth if isinstance(request.auth, Device) else None
        if not PosDevice.for_device(device).serves_door:
            return Response(
                {
                    "code": "door_role_required",
                    "detail": str(_(
                        "This device is set up as a till, not for the door: it is not given "
                        "the guest list."
                    )),
                },
                status=status.HTTP_403_FORBIDDEN,
            )
        clist = self._requested_checkin_list(request)
        if clist is None:
            raise ValidationError({"list": [_("Unknown check-in list.")]})

        with scopes_disabled():
            positions = (
                clist.positions.only(
                    "secret", "item_id", "attendee_name_cached",
                    "blocked", "valid_from", "valid_until",
                )
                .order_by("pk")[: OFFLINE_SNAPSHOT_LIMIT + 1]
            )
            rows = list(positions)
            truncated = len(rows) > OFFLINE_SNAPSHOT_LIMIT
            rows = rows[:OFFLINE_SNAPSHOT_LIMIT]
            entered = self._entry_scans_between(clist, rows)
            tickets = [
                {
                    "secret": p.secret,
                    "item": p.item_id,
                    # The cached column, never the `attendee_name` property:
                    # that one reads `attendee_name_parts` and, failing a name
                    # scheme in it, the event's settings — both deferred here,
                    # so every ticket would cost two extra queries and a full
                    # guest list would cost forty thousand. pretix rewrites this
                    # column on every save of the position, so it is the same
                    # string, fetched with the row.
                    "name": p.attendee_name_cached or "",
                    # So a second scan of the same ticket is refused offline too,
                    # rather than discovered hours later at reconciliation.
                    "used": p.pk in entered,
                    **offline_restrictions(p),
                }
                for p in rows
            ]

        return Response(
            {
                "list": {"id": clist.pk, "name": str(clist.name)},
                "generated": now().isoformat(),
                "tickets": tickets,
                # An event too big to carry offline says so, instead of letting a
                # till believe it holds the whole guest list.
                "truncated": truncated,
            }
        )

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

    def _entry_scans_between(self, clist, rows):
        """
        Which of ``rows`` already carry an entry scan on ``clist``.

        Bounded by primary key rather than by an ``IN`` over the rows: the
        snapshot carries up to twenty thousand of them, and naming each one
        would send a query with twenty thousand bound parameters — well past
        what older SQLite builds accept at all, and a needlessly large plan
        everywhere else. ``rows`` is the first N positions of the list in ``pk``
        order, so every position it contains lies inside that range and none is
        missed.

        The result may name a position outside ``rows``; that is harmless, since
        it is only ever asked whether a given row is in the set.
        """
        if not rows:
            return set()
        return set(
            Checkin.objects.filter(
                list=clist,
                type=Checkin.TYPE_ENTRY,
                position_id__gte=rows[0].pk,
                position_id__lte=rows[-1].pk,
            ).values_list("position_id", flat=True)
        )
