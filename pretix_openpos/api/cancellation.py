"""
A till's own history, and the cancellation of a sale it made.

A cancellation is new rows, never an edit — pretix' own cancellation and credit
note, a refund on the order, a reversing line in the journal — and, for a card
a reader took, the money asked back of SumUp once all of that has committed.
:class:`CancelActions` holds the two actions and every step between them.
"""
import logging

from django.db import transaction
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Device, Order
from pretix.base.models.orders import OrderPayment, OrderRefund
from pretix.base.services.orders import OrderError, cancel_order
from pretix.helpers import OF_SELF
from rest_framework import status
from rest_framework.decorators import action
from rest_framework.exceptions import APIException, ValidationError
from rest_framework.response import Response

from ..backoffice import till_cancelling
from ..models import PosDevice, PosSale, PosTerminalPayment, refund_key, reversed_positions
from ..reconcile import mark_pending, refund_in_hand, wait_for_refund
from ..sumup import ERR_CONFLICT, ERR_RATE_LIMITED, SumUpAccount, SumUpError
from .drawer_api import drawer_session_for, hold_drawer_session
from .sales import hold_idempotency_key, recorded_sale

logger = logging.getLogger(__name__)

#: Longest run of transactions a till shows itself.
#:
#: The history covers the whole event, not the calendar day, so a till that has
#: run a multi-day festival can have more than this — hence the ``truncated``
#: flag rather than a silent cut. Reading a whole event is the back office's job.
HISTORY_LIMIT = 100


class RefundInProgress(APIException):
    """Another request is asking SumUp to refund this very card payment."""

    status_code = status.HTTP_503_SERVICE_UNAVAILABLE

    def __init__(self):
        super().__init__(
            {
                "detail": _("The card refund of this sale is still being asked of SumUp. "
                            "Try again in a moment."),
                "code": "refund_in_progress",
            }
        )
        # A 5xx, like SaleInProgress: the till keeps the cancellation's key and
        # the next press finds out how the refund went.
        self.wait = 5


class _CancelledMeanwhile(Exception):
    """This sale's cancellation committed while another attempt was on its way to it."""

    def __init__(self, standing):
        super().__init__(standing.seq)
        self.standing = standing


class CancelActions:
    """What the calling till has recorded, and the cancellation of a sale it made."""

    # -- history and cancellation ------------------------------------------

    @action(detail=False, methods=["get"], url_path="history", url_name="history")
    def history(self, request, **kwargs):
        """
        What this till has recorded for this event, newest first.

        Scoped to the calling device, and to the whole event rather than to the
        calendar day. A till serves an evening, and an evening crosses midnight:
        cutting the history at 00:00 would empty the screen in the middle of
        service, exactly when a correction is most likely to be needed.

        Device-scoped on purpose, though. An operator correcting a mistake is
        correcting *their* mistake, made minutes ago on the tablet in their
        hand; handing every till the power to reverse every other till's
        takings is a different feature with different consequences, and the back
        office already covers it.
        """
        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None
        if device is None:
            # No device, no till history: this is per-device by design, and
            # answering with the whole event's journal would quietly widen it.
            return Response({"device": None, "results": [], "truncated": False})

        window = list(
            PosSale.objects.filter(event=event, device=device)
            .select_related("order")
            .order_by("-seq")[: HISTORY_LIMIT + 1]
        )
        sales = window[:HISTORY_LIMIT]
        cancelled = PosSale.cancelled_seqs(event, [s.seq for s in sales])

        return Response(
            {
                "device": device.unique_serial,
                "results": [self._journal_payload(s, cancelled) for s in sales],
                # Said rather than implied: a till that has run a whole festival
                # is not looking at everything it ever sold.
                "truncated": len(window) > HISTORY_LIMIT,
            }
        )

    @action(detail=False, methods=["post"], url_path="cancel", url_name="cancel")
    def cancel(self, request, **kwargs):
        """
        Reverse a sale: cancel the order, credit it, refund it, journal it.

        Nothing is ever edited or removed. The order is cancelled through
        pretix' own service, which issues the credit note for the invoice it
        had; the money is recorded as an ``OrderRefund`` so the payment stops
        counting as taken; and the journal gains a *new* line carrying the
        negative amount. The sale it reverses stays exactly as it was written,
        which is the entire point of keeping the journal append-only — the
        takings for the evening remain recomputable from it alone.

        Correcting an order is therefore three documents, not one edit: the
        sale, the credit note, and whatever new sale the operator rings up
        afterwards.
        """
        from .serializers import CancelSerializer

        event = request.event
        device = request.auth if isinstance(request.auth, Device) else None

        serializer = CancelSerializer(data=request.data)
        serializer.is_valid(raise_exception=True)
        data = serializer.validated_data

        # A retry of a cancellation we already committed hands back the same
        # answer rather than trying to cancel an order that is already gone.
        replay = recorded_sale(event, data["idempotency_key"])
        if replay:
            return self._replayed_cancellation(request, device, replay)

        try:
            return self._cancel(request, device, data)
        except PosSale.AlreadyRecorded:
            # Another attempt at this very cancellation committed while this
            # one was on its way — a till retrying while its first attempt was
            # still being written — and everything this one wrote went with
            # the exception: pretix' own cancellation and the refund included.
            # What is left is the answer a retry a second later would get.
            replay = recorded_sale(event, data["idempotency_key"])
            if replay is None:
                raise
            return self._replayed_cancellation(request, device, replay)

    def _replayed_cancellation(self, request, device, replay):
        """The answer to a cancellation key already in the journal."""
        if device is None or replay.device_id != device.pk or replay.kind != PosSale.KIND_CANCELLATION:
            # A key names one request, and this one names somebody else's
            # entry: a sale, another till's cancellation, or one the back
            # office wrote — whose keys are spelt out in backoffice.py, so
            # anybody can type one. Answering it as a replay would hand
            # this till that entry, and ask SumUp to finish a refund the
            # back office may have chosen not to make.
            raise ValidationError(
                {"idempotency_key": [_("This key already names another entry of the journal.")]}
            )
        original = PosSale.objects.filter(event=request.event, seq=replay.cancels_seq).first()
        return Response(
            self._found_cancellation(request, replay, original, already_cancelled=False),
            status=status.HTTP_200_OK,
        )

    def _cancel(self, request, device, data):
        """:meth:`cancel`, for a key nobody has recorded yet."""
        event = request.event
        sale = PosSale.objects.filter(event=event, seq=data["seq"]).select_related("order").first()
        if sale is None:
            raise ValidationError({"seq": [_("No such entry in this event's journal.")]})
        if device is None or sale.device_id != device.pk:
            # Deliberately not a 403: it is not a permission the operator can be
            # granted, it is somebody else's till.
            raise ValidationError(
                {"seq": [_("This sale was made on another till and can only be corrected there.")]}
            )
        if sale.kind != PosSale.KIND_SALE:
            raise ValidationError({"seq": [_("This journal entry is not a sale.")]})
        standing = self._standing_cancellation(event, sale)
        if standing is not None:
            # Cancelled already, under another key: a first attempt that went
            # through and timed out on the way back, retried by a till that
            # could no longer tell it was the same one — the history panel
            # closed and reopened, the app reloaded. Refusing it with "already
            # cancelled" was the whole answer once, and the till never showed
            # the amount to hand back nor offered to ring the order up again.
            # So the cancellation that stands is answered as a fresh one would
            # be, with what it was, and how it came to be there.
            return Response(
                self._found_cancellation(request, standing, sale, already_cancelled=True),
                status=status.HTTP_200_OK,
            )
        if sale.order is None:
            raise ValidationError({"seq": [_("The order behind this sale no longer exists.")]})

        order = sale.order
        if not order.cancel_allowed():
            raise ValidationError(
                {"seq": [_("pretix will not let this order be cancelled: {status}.").format(
                    status=order.get_status_display()
                )]}
            )

        # Cash handed back comes out of the drawer the till stands at now,
        # which has to be open for it — the same rule as taking cash, and for
        # the same reason: the count at the end of the night has to see it.
        drawer_session = drawer_session_for(
            event, PosDevice.for_device(device).drawer, sale.payment_type
        )

        try:
            with transaction.atomic():
                drawer_session, order = self._hold_for_cancel(
                    event, data["idempotency_key"], sale, drawer_session
                )
                cancellation, refund = self._write_cancellation(
                    request, device, data, sale, order, drawer_session
                )
        except _CancelledMeanwhile as meanwhile:
            return Response(
                self._found_cancellation(request, meanwhile.standing, sale, already_cancelled=True),
                status=status.HTTP_200_OK,
            )

        body = self._cancellation_payload(cancellation, sale, replayed=False)
        body["credit_note"] = self._credit_note_number(order)
        body["refunded"] = refund is not None
        # Deliberately after the transaction has committed. Sending money back
        # is a call to somebody else's server: holding a database transaction
        # open across it would keep a row locked for as long as SumUp takes,
        # and rolling the cancellation back afterwards could not un-send it.
        # So the cancellation stands first, and the card is a separate step
        # whose outcome is reported rather than assumed.
        body["card_refund"] = self._give_card_back(request, sale, refund)
        return Response(body, status=status.HTTP_201_CREATED)

    def _hold_for_cancel(self, event, idempotency_key, sale, drawer_session):
        """
        Everything a cancellation must hold before it writes, in that order.

        The key first: another attempt at this very cancellation — the till
        retrying while the first one is still being written — is queued behind
        and then found, as :func:`hold_idempotency_key` does for a sale. Then
        the drawer the cash comes out of. Then the order, locked and read
        again: pretix' ``cancel_order`` trusts the object it is handed rather
        than reading it afresh, so a cancellation of this sale that committed
        meanwhile under another key — the app reloaded, the history asked a
        second time — would otherwise be made a second time, credit note,
        refund and card and all. That one is answered instead, as it stands.

        Returns the drawer session and the order, both held.
        """
        earlier = hold_idempotency_key(event, idempotency_key)
        if earlier is not None:
            raise PosSale.AlreadyRecorded(earlier)
        drawer_session = hold_drawer_session(drawer_session, sale.payment_type)
        order = Order.objects.select_for_update(of=OF_SELF).get(pk=sale.order_id)
        standing = self._standing_cancellation(event, sale)
        if standing is not None:
            raise _CancelledMeanwhile(standing)
        if not order.cancel_allowed():
            raise ValidationError(
                {"seq": [_("pretix will not let this order be cancelled: {status}.").format(
                    status=order.get_status_display()
                )]}
            )
        return drawer_session, order

    def _write_cancellation(self, request, device, data, sale, order, drawer_session):
        """The cancellation's writes, inside the transaction that holds what they need."""
        event = request.event
        try:
            # pretix' own cancellation, so the credit note, the invalidated
            # ticket secrets and the log entry are the ones the back office
            # would have produced. send_mail is off: at a till the customer
            # is standing right there, and the address is usually the
            # organiser's own placeholder for an on-site sale.
            #
            # Said to be the till's own doing, because pretix tells the
            # plugin about every cancellation and one made anywhere else
            # is written to the journal from there. This one is written
            # below, with the till and the cashier it belongs to.
            with till_cancelling():
                cancel_order(
                    order,
                    device=device,
                    send_mail=False,
                    cancel_invoice=True,
                    email_comment=data["reason"] or None,
                )
        except OrderError as e:
            raise ValidationError({"seq": [str(e)]})

        order.refresh_from_db()
        refund = self._record_refund(
            request, order, sale, data["reason"],
            # A reader is about to be asked, after this transaction, and it
            # can refuse. Nothing may claim the money is back until it has
            # answered.
            settle_now=PosTerminalPayment.settling(sale) is None,
        )

        cancellation = PosSale.record(
            event=event,
            order=order,
            device=device,
            cashier=data["cashier"],
            payment_type=sale.payment_type,
            # Negative, so the takings stay the plain sum of the column and
            # the drawer reconciles against the journal without arithmetic.
            total=-sale.total,
            positions=reversed_positions(sale.positions),
            idempotency_key=data["idempotency_key"],
            testmode=sale.testmode,
            kind=PosSale.KIND_CANCELLATION,
            cancels_seq=sale.seq,
            reason=data["reason"],
            drawer_session=drawer_session,
            # Another attempt's row under this key is not this one's to hand
            # back: it means that attempt committed first, and everything
            # written here has to go — see cancel().
            existing_ok=False,
        )

        # The deposit handed back with this sale is a journal row of its
        # own, and reversing only the sale leaves the takings short by its
        # amount for the rest of the evening. The customer put the *net* on
        # the counter — the cups came off the bill — so the net is what
        # goes back, and both halves have to be reversed for the column to
        # return to where it started. Found by the key the sale's own key
        # derives, which is how the two were written together in the first
        # place.
        deposit_refund = PosSale.objects.filter(
            event=event,
            idempotency_key=refund_key(sale.idempotency_key),
            kind=PosSale.KIND_DEPOSIT_REFUND,
        ).first()
        if deposit_refund is not None and not PosSale.cancelled_seqs(
            event, [deposit_refund.seq]
        ):
            PosSale.record(
                event=event,
                order=None,
                device=device,
                cashier=data["cashier"],
                payment_type=deposit_refund.payment_type,
                # Its total is negative — money that left the drawer — so
                # negating it puts the same amount back.
                total=-deposit_refund.total,
                positions=reversed_positions(deposit_refund.positions),
                # Derived from the cancellation's key exactly as the payout
                # row derived from the sale's, so a retried cancellation
                # recognises this half too instead of writing it twice.
                idempotency_key=refund_key(data["idempotency_key"]),
                testmode=deposit_refund.testmode,
                kind=PosSale.KIND_CANCELLATION,
                cancels_seq=deposit_refund.seq,
                reason=data["reason"],
                drawer_session=drawer_session,
                existing_ok=False,
            )
        return cancellation, refund

    def _refund_card(self, event, sale, payment):
        """
        Give a card sale's money back through SumUp: ``payment``, the reader
        payment that took it.

        Returns what the till should tell the operator, and, when SumUp said
        no, what it said — for the order page, never for the till's screen.
        ``none`` is the word for a sale no reader took, which never gets here:
        a cash sale, or a card taken on somebody's phone rather than on a reader
        this server drove. The operator refunds those the way they took them.
        The others:

        ``done``
            SumUp accepted the refund.
        ``already``
            It had been refunded before. Not an error, and not a second refund.
        ``pending``
            SumUp will not take it yet — its 409, what a refund asked for
            moments after the payment gets. The server asks again on its own
            until SumUp does (see :mod:`..reconcile`), so the operator hands
            nothing back: the card gets the money, a little later.
        ``failed``
            The money is still on the customer's card. The operator has to
            refund it from the SumUp app, and has to be told so plainly rather
            than shown a cancellation that looks complete.
        """
        # Read again: whoever held the payment before this request may have
        # been given the money back meanwhile.
        payment.refresh_from_db()
        if payment.refunded:
            return "already", ""

        try:
            # In full, and without naming an amount: what goes back is what the
            # card was charged, which is not always what the order is worth — a
            # basket with a deposit handed back in it charges the net. SumUp
            # refunds the transaction, so the transaction's own figure is the
            # right one and the only one that cannot be got wrong here.
            SumUpAccount(event.organizer).refund(payment.transaction_id)
        except SumUpError as exc:
            # A 409 is SumUp's "not yet"; a 429, "not now". Neither refused the
            # refund, which the server asks for again on its own.
            if exc.code in (ERR_CONFLICT, ERR_RATE_LIMITED):
                logger.info(
                    "POS card refund for journal #%s left waiting for SumUp: %s",
                    sale.seq, exc.detail,
                )
                return "pending", exc.reason or str(exc.message)
            logger.warning(
                "POS card refund failed for journal #%s: %s", sale.seq, exc.detail
            )
            return "failed", exc.reason or str(exc.message)

        payment.refunded = now()
        payment.save(update_fields=["refunded", "updated"])
        return "done", ""

    # -- helpers -----------------------------------------------------------

    def _journal_payload(self, sale, cancelled_seqs=()):
        """One journal line as the till displays it."""
        return {
            "seq": sale.seq,
            "kind": sale.kind,
            "datetime": sale.datetime.isoformat(),
            "order": sale.order_code,
            "total": str(sale.total),
            "payment_type": sale.payment_type,
            "cashier": sale.cashier,
            "testmode": sale.testmode,
            "positions": sale.positions,
            "reason": sale.reason,
            "cancels_seq": sale.cancels_seq,
            "cancelled": sale.seq in cancelled_seqs,
            # What the app may still offer. The real decision is taken again,
            # server-side, when the cancellation is actually asked for.
            "can_cancel": (
                sale.kind == PosSale.KIND_SALE
                and sale.seq not in cancelled_seqs
                and sale.order is not None
                and sale.order.status in (Order.STATUS_PAID, Order.STATUS_PENDING)
            ),
        }

    def _cancellation_payload(self, cancellation, sale, replayed, already_cancelled=False):
        """
        A cancellation as the till reads it, however it was reached.

        One shape for all three ways, so the till has one screen for them, and
        three flags to say which way it was:

        ``replayed``
            The cancellation was already in the journal before this request:
            nothing was written this time.
        ``already_cancelled``
            …and it was not this request's own, retried under the same key:
            the sale had been cancelled before, under another key.
        ``by_back_office``
            …by somebody in pretix' back office rather than by a till. The money
            was dealt with there, if at all, and the till is told so it can
            say so rather than offer to hand anything back.
        """
        return {
            "cancellation": self._journal_payload(cancellation),
            # The lines of the sale that was reversed, so the till can put them
            # straight back in the basket for the operator to correct.
            "sale": self._journal_payload(sale, {sale.seq}) if sale else None,
            "replayed": replayed,
            "already_cancelled": already_cancelled,
            "by_back_office": cancellation.from_back_office,
            "credit_note": None,
            "refunded": False,
        }

    @staticmethod
    def _standing_cancellation(event, sale):
        """
        The cancellation of this sale that stands, or ``None``.

        The latest one no reactivation has undone — the journal's own rule, as
        :meth:`PosSale.cancelled_seqs` applies it: pretix' back office can
        bring a cancelled order back, and the till cancel it again afterwards.
        """
        cancellations = list(
            PosSale.objects.filter(
                event=event, kind=PosSale.KIND_CANCELLATION, cancels_seq=sale.seq
            ).order_by("-seq")
        )
        if not cancellations:
            return None
        undone = set(
            PosSale.objects.filter(
                event=event,
                kind=PosSale.KIND_REACTIVATION,
                cancels_seq__in=[c.seq for c in cancellations],
            ).values_list("cancels_seq", flat=True)
        )
        return next((c for c in cancellations if c.seq not in undone), None)

    def _found_cancellation(self, request, cancellation, sale, *, already_cancelled):
        """
        A cancellation already in the journal, answered as it was the first time.

        With the credit note and what became of the money, which the till needs
        to show the same screen: the amount to hand back, the credit to ring the
        order up again with. And the job finished where it was left: a first
        attempt may have committed the cancellation and lost the connection
        before it refunded the card. Asked again rather than remembered — when
        the refund did go through, the answer is "already", never a second one.

        Except for a cancellation made in the back office. Whoever made it
        decided about the money there, and pretix' own refund dialog is where
        a card is given back from it: asking SumUp from here could refund a
        card somebody chose not to. So that one only says where the card
        stands, and asks nobody.
        """
        body = self._cancellation_payload(
            cancellation, sale, replayed=True, already_cancelled=already_cancelled
        )
        order = sale.order if sale is not None else None
        if order is not None:
            body["credit_note"] = self._credit_note_number(order)
            body["refunded"] = order.refunds.exists()
        if sale is None:
            body["card_refund"] = "none"
            return body
        if cancellation.from_back_office:
            body["card_refund"] = self._card_refund_state(sale)
            return body
        # And the books are brought in line with what just happened. A
        # cancellation whose card refund was refused the first time leaves a
        # failed refund on the order; succeeding on the retry has to clear it,
        # or the order page keeps saying the customer was never paid back long
        # after they were.
        body["card_refund"] = self._give_card_back(
            request, sale,
            lambda: order.refunds.order_by("-local_id").first() if order is not None else None,
        )
        return body

    def _give_card_back(self, request, sale, refund):
        """
        Refund a card sale through SumUp and write down what SumUp did, as the
        one request doing so for its reader payment (see ``refund_in_hand``).

        ``refund`` is the ``OrderRefund`` the answer goes on, or a callable that
        finds it once this request holds the payment. Another request already
        holding it — the first attempt at this very cancellation, still waiting
        on SumUp while its till asked again — is waited for, briefly, and then
        this one does what a retry a second later would: a card given back
        meanwhile is "already", and SumUp is not asked a second time. Asked at
        the same moment, it could only refuse — and that refusal was written
        down over the refund that went through.

        Returns the word for the till, as :meth:`_refund_card` does.
        """
        payment = PosTerminalPayment.settling(sale)
        if payment is None:
            return "none"
        for attempt in range(2):
            with refund_in_hand(payment) as mine:
                if mine:
                    return self._refund_and_settle(request, sale, payment, refund)
            if attempt == 0 and not wait_for_refund(payment):
                break
        # Still in hand after the few seconds SumUp usually takes, or taken
        # again the moment it was let go. Never "none", which has the till
        # count the amount out of the drawer while the card may be getting it
        # back: not known yet, so asked again — under the same key, which the
        # till keeps on a 5xx.
        raise RefundInProgress()

    def _refund_and_settle(self, request, sale, payment, refund):
        """:meth:`_give_card_back`, for the request holding the reader payment."""
        outcome, refusal = self._refund_card(request.event, sale, payment)
        found = self._settle_refund(
            request, refund() if callable(refund) else refund, outcome, refusal
        )
        if found == OrderRefund.REFUND_STATE_DONE and outcome in ("pending", "failed"):
            # Done while SumUp was being asked — by the periodic comparison,
            # which reads SumUp's own history — so what SumUp told this
            # request was about a refund already made. The till hands nothing
            # back, and says the card has it.
            return "already"
        return outcome

    @staticmethod
    def _card_refund_state(sale):
        """
        What became of a sale's card money, from what is written down alone.

        The words of :meth:`_refund_card`, for a cancellation this server did
        not refund itself: ``none`` when no reader took the money, ``already``
        once the reader payment was refunded, ``pending`` while a refund of it
        waits for SumUp, ``failed`` when the last one was refused. A reader
        payment nobody has tried to refund is ``none`` as well: nothing was
        asked of SumUp, so there is nothing to report.
        """
        payment = PosTerminalPayment.settling(sale)
        if payment is None:
            return "none"
        if payment.refunded:
            return "already"
        latest = sale.order.refunds.order_by("-local_id").first() if sale.order_id else None
        if latest is not None and latest.state == OrderRefund.REFUND_STATE_TRANSIT:
            return "pending"
        if latest is not None and latest.state == OrderRefund.REFUND_STATE_FAILED:
            return "failed"
        return "none"

    def _record_refund(self, request, order, sale, reason, *, settle_now):
        """
        Record that the money went back out.

        Cancelling an order does not by itself say the customer was paid back —
        pretix would keep showing the payment as taken. The refund is what makes
        the books agree with the drawer.

        ``settle_now`` is whether it can be marked done here. It can when the
        money moves in the same breath as this call: cash out of the till, or a
        card taken on somebody's phone and given back the same way. It cannot
        when a reader is about to be asked, because that call is made after this
        transaction commits and it can be refused. Marking it done first was a
        real hole: a refusal left pretix showing a completed refund while the
        money was still on the customer's card, which is the one state where the
        books and the customer disagree and nothing records which is right.
        """
        payment = order.payments.filter(
            state=OrderPayment.PAYMENT_STATE_CONFIRMED
        ).order_by("-local_id").first()
        if payment is None:
            logger.warning("POS cancellation of %s has no confirmed payment to refund", order.code)
            return None

        refund = order.refunds.create(
            state=OrderRefund.REFUND_STATE_CREATED,
            # Not the buyer's own doing: an operator corrected the till.
            source=OrderRefund.REFUND_SOURCE_ADMIN,
            amount=payment.amount,
            payment=payment,
            provider=payment.provider,
            info_data={
                "journal_seq": sale.seq,
                "device": sale.device_serial,
                "cashier": sale.cashier,
                "reason": reason,
            },
        )
        # What pretix writes itself whenever it creates a refund, in its API
        # and in its own refund dialog alike. Without it, the order's history
        # showed a refund done — or failed — that had never been created, and
        # pretix' own "refund created" webhook never fired for a till's.
        order.log_action(
            "pretix.event.order.refund.created",
            {"local_id": refund.local_id, "provider": refund.provider},
            user=request.user if request.user.is_authenticated else None,
            auth=request.auth,
        )
        if settle_now:
            self._mark_refund_done(request, refund)
        return refund

    @staticmethod
    def _mark_refund_done(request, refund):
        refund.done(
            user=request.user if request.user.is_authenticated else None,
            auth=request.auth,
        )

    def _settle_refund(self, request, refund, outcome, refusal=""):
        """
        Write down what SumUp actually did with the money.

        Called once the card has been asked, outside the transaction. Anything
        other than a refusal means the amount is on its way back and the refund
        stands; a refusal leaves it failed, which is what makes the order page
        say the money was *not* returned. Without this the operator is the only
        record that it was not, and they are at a bar. SumUp's "not yet" leaves
        it in transit, and the server asks again until SumUp takes it.

        Returns the state the refund stood in when read again here, before
        anything was written; ``None`` when there is no refund.
        """
        if refund is None:
            return None
        with transaction.atomic():
            # Read again, and held: the refund in hand was read before SumUp was
            # asked, and the periodic task or another request may have written
            # it since. "Done" is never written back over.
            refund = OrderRefund.objects.select_for_update(of=OF_SELF).get(pk=refund.pk)
            found = refund.state
            self._settle_refund_held(request, refund, outcome, refusal)
        return found

    def _settle_refund_held(self, request, refund, outcome, refusal):
        """:meth:`_settle_refund`, on the refund as it stands now, held."""
        if refund.state == OrderRefund.REFUND_STATE_DONE:
            return
        if outcome == "pending":
            mark_pending(
                refund,
                refusal,
                user=request.user if request.user.is_authenticated else None,
                auth=request.auth,
            )
            return
        if outcome == "failed":
            refund.state = OrderRefund.REFUND_STATE_FAILED
            # What SumUp answered, where the order page shows it under the
            # failed refund and the Sales page beside it. It is the only
            # record of why: SumUp's own dashboard refuses the same refund
            # without saying, and the log that has it is the server's.
            refund.info_data = {**(refund.info_data or {}), "sumup_error": refusal}
            refund.save(update_fields=["state", "info"])
            # In pretix' own log, on the order, where somebody reconciling the
            # evening will be looking.
            refund.order.log_action(
                "pretix.event.order.refund.failed",
                {"local_id": refund.local_id, "provider": refund.provider},
                user=request.user if request.user.is_authenticated else None,
                auth=request.auth,
            )
            return
        self._mark_refund_done(request, refund)

    def _credit_note_number(self, order):
        invoice = order.invoices.filter(is_cancellation=True).order_by("-pk").first()
        return invoice.number if invoice else None
