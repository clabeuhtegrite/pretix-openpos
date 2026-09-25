"""
The cash drawer of a till, as the API meets it.

How a sale or a cancellation finds the opening its cash goes through and
holds it while it writes, and :class:`DrawerActions`, the drawer's own actions
at the till: open, move cash, count, close. The rules themselves are in
:mod:`pretix_openpos.drawers`, which the back office shares.
"""
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Device
from rest_framework.decorators import action
from rest_framework.exceptions import ValidationError
from rest_framework.response import Response

from ..drawers import (
    DrawerError, check_denominations, close_drawer, count_drawer, count_is_current, denominations_for, drawer_closed,
    drawer_stale, figures, is_stale, move_cash, open_drawer, open_session_of, session_at,
)
from ..models import PosDevice, PosDrawerEntry, PosDrawerSession, PosSale


def refuse(error: DrawerError):
    """A drawer refusal as the till reads it: a code to act on, a sentence to show."""
    raise ValidationError({"drawer": [error.message], "code": error.code})


def drawer_session_for(event, drawer, payment_type, recorded_at=None):
    """
    The drawer opening a sale's money belongs to — refusing live cash when none is.

    ``None`` for a till with no drawer, which sells exactly as it always has.

    A sale rung up now, in cash, needs its drawer open: its money is going
    into that drawer, and an opening is what the count at the end of the night
    reconciles against. Refused before anything is written, so the volunteer
    opens the drawer and taps again with the customer still there. A drawer
    left open since an earlier day is refused too — the money it held is
    long gone to whoever keeps the books, and tonight's float was never
    counted into it.

    Card money never reaches the drawer, so a card sale is never refused and
    is only attached to an opening that is running tonight, for the report.

    A sale already paid for (``recorded_at``, a replay from a till that was cut
    off) goes into whichever opening was running when the customer paid, and
    is never refused either: refusing would not take the cash back out.
    """
    if drawer is None:
        return None
    if recorded_at is not None:
        return session_at(drawer, recorded_at)
    session = open_session_of(drawer)
    cash = payment_type == PosSale.PAYMENT_CASH
    if session is not None and is_stale(session, event):
        if cash:
            refuse(drawer_stale())
        return None
    if session is None and cash:
        refuse(drawer_closed())
    return session


def hold_drawer_session(session, payment_type):
    """
    Lock the opening a live sale is going into, until the sale is written.

    Taken inside the sale's own transaction, before anything is written: a
    closing on the other tablet then waits for this sale rather than counting
    without it, and a closing that got there first is seen here — cash is then
    refused, with nothing written, and a card sale simply goes unattached.
    """
    if session is None:
        return None
    held = (
        PosDrawerSession.objects.select_for_update()
        .filter(pk=session.pk, closed_at__isnull=True)
        .first()
    )
    if held is None and payment_type == PosSale.PAYMENT_CASH:
        refuse(drawer_closed())
    return held


class DrawerActions:
    """The drawer assigned to the calling till: what it holds, and what happens to it."""

    # -- cash drawer -------------------------------------------------------

    @staticmethod
    def _drawer_entry_payload(entry):
        return {
            "seq": entry.seq,
            "kind": entry.kind,
            "datetime": entry.datetime.isoformat(),
            "amount": None if entry.amount is None else str(entry.amount),
            "reason": entry.reason,
            "cashier": entry.cashier,
            "device": entry.device_name,
        }

    def _drawer_state(self, event, drawer):
        """
        The drawer as the till shows it, with what it should hold right now.

        The float, the cash taken and handed back, the money put in and taken
        out, and their sum: what whoever stands at the till expects to find in
        the drawer, all evening long. The count at the closing still says what
        was actually found, and the difference.
        """
        if drawer is None:
            return {"drawer": None, "session": None, "last_closed": None}
        body = {
            "drawer": {
                "id": drawer.pk,
                "name": drawer.name,
                "opening_float": (
                    None if drawer.opening_float is None else str(drawer.opening_float)
                ),
                "currency": event.currency,
                "denominations": denominations_for(event.currency),
            },
            "session": None,
            "last_closed": None,
        }
        session = open_session_of(drawer)
        if session is not None:
            entries = list(session.entries.order_by("seq"))
            opening = next((e for e in entries if e.kind == PosDrawerEntry.KIND_OPEN), None)
            count = next(
                (e for e in reversed(entries) if e.kind == PosDrawerEntry.KIND_COUNT), None
            )
            fig = figures(session)
            body["session"] = {
                "id": session.pk,
                "opened_at": session.opened_at.isoformat(),
                "opened_by": opening.cashier if opening else "",
                "opening_float": str(opening.amount) if opening else "0.00",
                # What the drawer should hold now, and what it is made of. The
                # cash handed back (cancellations, returned deposits) is negative.
                "expected": str(fig["expected"]),
                "cash_sales": str(fig["cash_sales"]),
                "cash_returned": str(fig["cash_cancellations"] + fig["deposit_refunds"]),
                "cash_in": str(fig["cash_in"]),
                "cash_out": str(fig["cash_out"]),
                "stale": is_stale(session, event),
                "movements": [
                    self._drawer_entry_payload(e)
                    for e in entries
                    if e.kind in (PosDrawerEntry.KIND_IN, PosDrawerEntry.KIND_OUT)
                ],
                "count": None if count is None else {
                    **self._drawer_entry_payload(count),
                    "expected": str(count.expected),
                    "difference": str(count.difference),
                    # Whether the drawer can still be closed on it: nothing
                    # sold or moved since. The closing asks again.
                    "current": count_is_current(session, count),
                },
            }
        else:
            last = (
                drawer.sessions.filter(closed_at__isnull=False)
                .order_by("-closed_at", "-pk")
                .first()
            )
            closing = (
                last.entries.filter(kind=PosDrawerEntry.KIND_CLOSE).order_by("-seq").first()
                if last else None
            )
            if closing is not None:
                body["last_closed"] = {
                    "id": last.pk,
                    "opened_at": last.opened_at.isoformat(),
                    "closed_at": last.closed_at.isoformat(),
                    "cashier": closing.cashier,
                    "amount": None if closing.amount is None else str(closing.amount),
                    "expected": str(closing.expected),
                    "difference": (
                        None if closing.difference is None else str(closing.difference)
                    ),
                }
        return body

    def _drawer_of(self, request):
        """The calling till and its drawer, refusing a till that has none."""
        device = request.auth if isinstance(request.auth, Device) else None
        drawer = PosDevice.for_device(device).drawer
        if drawer is None:
            raise ValidationError(
                {"drawer": [_("No cash drawer is assigned to this till.")], "code": "no_drawer"}
            )
        return device, drawer

    def _drawer_counted(self, request, serializer_class):
        data = serializer_class(data=request.data)
        data.is_valid(raise_exception=True)
        data = data.validated_data
        problem = check_denominations(
            data.get("denominations"), data["amount"], request.event.currency
        )
        if problem:
            raise ValidationError({"denominations": [problem]})
        return data

    @action(detail=False, methods=["get"], url_path="drawer", url_name="drawer")
    def drawer(self, request, **kwargs):
        """Whether this till's drawer is open, and what has happened to it tonight."""
        device = request.auth if isinstance(request.auth, Device) else None
        return Response(self._drawer_state(request.event, PosDevice.for_device(device).drawer))

    @action(detail=False, methods=["post"], url_path="drawer/open", url_name="drawer-open")
    def drawer_open(self, request, **kwargs):
        """Open the drawer on the float just counted into it."""
        from .serializers import DrawerCountSerializer

        device, drawer = self._drawer_of(request)
        data = self._drawer_counted(request, DrawerCountSerializer)
        try:
            entry = open_drawer(
                drawer,
                idempotency_key=data["idempotency_key"],
                amount=data["amount"],
                denominations=data["denominations"],
                cashier=data["cashier"],
                device=device,
            )
        except DrawerError as error:
            refuse(error)
        return Response(
            {**self._drawer_state(request.event, drawer), "entry": self._drawer_entry_payload(entry)}
        )

    @action(detail=False, methods=["post"], url_path="drawer/movement", url_name="drawer-movement")
    def drawer_movement(self, request, **kwargs):
        """Money put into the open drawer, or taken out, other than by a sale."""
        from .serializers import DrawerMovementSerializer

        device, drawer = self._drawer_of(request)
        serializer = DrawerMovementSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        try:
            entry = move_cash(
                drawer,
                idempotency_key=data["idempotency_key"],
                kind=data["kind"],
                amount=data["amount"],
                reason=data["reason"],
                cashier=data["cashier"],
                device=device,
            )
        except DrawerError as error:
            refuse(error)
        return Response(
            {**self._drawer_state(request.event, drawer), "entry": self._drawer_entry_payload(entry)}
        )

    @action(detail=False, methods=["post"], url_path="drawer/count", url_name="drawer-count")
    def drawer_count(self, request, **kwargs):
        """
        A count, answered with what the drawer should have held and the difference.
        """
        from .serializers import DrawerCountSerializer

        device, drawer = self._drawer_of(request)
        data = self._drawer_counted(request, DrawerCountSerializer)
        try:
            entry = count_drawer(
                drawer,
                idempotency_key=data["idempotency_key"],
                amount=data["amount"],
                denominations=data["denominations"],
                cashier=data["cashier"],
                device=device,
            )
        except DrawerError as error:
            refuse(error)
        return Response(
            {
                **self._drawer_state(request.event, drawer),
                "entry": {
                    **self._drawer_entry_payload(entry),
                    "expected": None if entry.expected is None else str(entry.expected),
                    "difference": None if entry.difference is None else str(entry.difference),
                },
            }
        )

    @action(detail=False, methods=["post"], url_path="drawer/close", url_name="drawer-close")
    def drawer_close(self, request, **kwargs):
        """
        Close the drawer on the count just made.

        Or on no count at all, for a drawer opened on an earlier day and never
        closed: whoever stands at the till tonight never saw the money it held,
        and a figure they made up would be worse than the plain word that
        nobody counted it.
        """
        from .serializers import DrawerCloseSerializer

        device, drawer = self._drawer_of(request)
        serializer = DrawerCloseSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data
        session = open_session_of(drawer)
        uncounted_ok = (
            data["count_seq"] is None
            and session is not None
            and is_stale(session, request.event)
        )
        if data["count_seq"] is None and session is not None and not uncounted_ok:
            refuse(DrawerError("count_required", _("Count the drawer before closing it.")))
        try:
            entry = close_drawer(
                drawer,
                idempotency_key=data["idempotency_key"],
                count_seq=data["count_seq"],
                uncounted_ok=uncounted_ok,
                reason=data["reason"],
                cashier=data["cashier"],
                device=device,
            )
        except DrawerError as error:
            refuse(error)
        return Response(
            {**self._drawer_state(request.event, drawer), "entry": self._drawer_entry_payload(entry)}
        )
