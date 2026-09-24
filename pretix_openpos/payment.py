from decimal import Decimal, InvalidOperation

from django.template.loader import get_template
from django.utils.timezone import now
from django.utils.translation import gettext_lazy as _
from pretix.base.payment import BasePaymentProvider, PaymentException

CASH = "openpos_cash"
CARD = "openpos_card"


class OpenPosPaymentProvider(BasePaymentProvider):
    """
    Base for the two till payment methods.

    These exist so the cash/card split shows up in pretix' own order views and
    reports without the POS having to keep a parallel set of books. The money is
    always collected before the order is created, so these providers never take
    part in an interactive checkout: ``is_allowed`` is hard-wired to ``False``
    and the API creates the order as already paid with this provider attached.
    """

    abort_pending_allowed = False

    def is_allowed(self, request, total=None):
        # Never offer these in the webshop checkout.
        return False

    def order_change_allowed(self, order, request=None):
        # Never offer these when changing an existing order in the backend.
        return False

    @property
    def settings_form_fields(self):
        # Nothing to configure: these are driven entirely by the till.
        return {}

    @property
    def is_enabled(self) -> bool:
        # Enabled purely so the identifier resolves when the API creates a paid
        # order. Visibility in checkout is governed by is_allowed() above.
        return True

    def payment_form_render(self, request, total, order=None):
        return ""

    def checkout_confirm_render(self, request, order=None, info_data=None):
        return ""

    def execute_payment(self, request, payment):
        # Reached only if somebody wires this up manually; the money is already
        # in the drawer by the time the order exists.
        payment.confirm()

    def payment_control_render(self, request, payment) -> str:
        info = payment.info_data or {}
        template = get_template("pretix_openpos/payment_control.html")
        return template.render(
            {
                "payment": payment,
                "info": info,
                # Amounts live in the payment info as strings, because that is
                # what belongs in JSON. pretix' `money` filter raises TypeError
                # on anything but a Decimal, and that exception happens while
                # rendering the backend order page — so a string here does not
                # produce a cosmetic glitch, it turns the whole order page into
                # a 500 for every cash sale.
                "cash_given": _decimal_or_none(info.get("cash_given")),
                "cash_change": _decimal_or_none(info.get("cash_change")),
                "provider": self,
            }
        )


def _decimal_or_none(value):
    if value is None or value == "":
        return None
    try:
        return Decimal(str(value))
    except (InvalidOperation, ValueError, TypeError):
        return None


class OpenPosCashProvider(OpenPosPaymentProvider):
    identifier = CASH
    verbose_name = _("Cash (Open POS)")
    public_name = _("Cash")


class OpenPosCardProvider(OpenPosPaymentProvider):
    identifier = CARD
    verbose_name = _("Card terminal (Open POS)")
    public_name = _("Card")

    # -- giving the money back from pretix ----------------------------------
    #
    # A sale cancelled at the till has its card refunded by the till. One
    # cancelled in pretix' back office used to have nobody to do it: pretix
    # offered only a manual refund, and the money went back — or did not —
    # from the SumUp app, by hand, with nothing on either side to say so. These
    # three put "refund automatically" in pretix' own refund dialog for a card
    # a reader of this organizer took, and send it through the same SumUp call
    # the till uses.

    def _terminal_payment(self, payment):
        """The reader payment behind this pretix payment, if a reader took it."""
        from .models import PosSale, PosTerminalPayment

        sale = PosSale.objects.filter(
            event=self.event, order_id=payment.order_id, kind=PosSale.KIND_SALE
        ).first()
        return PosTerminalPayment.settling(sale)

    def payment_refund_supported(self, payment) -> bool:
        """
        Offered for a card a reader took and that has not been given back yet.

        Not for a card taken on somebody's phone: this server never saw that
        transaction and has nothing to name to SumUp. And not once the reader
        payment says it was refunded — at the till, or from here — because
        then the only thing left for an automatic refund to do is the second
        one.
        """
        from .sumup import SumUpAccount

        terminal = self._terminal_payment(payment)
        return (
            terminal is not None
            and terminal.refunded is None
            and SumUpAccount(self.event.organizer).configured
        )

    def payment_partial_refund_supported(self, payment) -> bool:
        # The whole transaction or nothing, as the till does it. SumUp could
        # take an amount, but the reader payment keeps one date of refund, not
        # a running figure — a part given back here would make the till answer
        # "already refunded" for the rest. A part goes back from the SumUp app.
        return False

    def execute_refund(self, refund):
        from .sumup import SumUpAccount, SumUpError

        terminal = self._terminal_payment(refund.payment)
        if terminal is None:
            raise PaymentException(
                _("No card reader of this organizer took this payment, so it can only "
                  "be refunded from the SumUp app.")
            )
        if terminal.refunded is not None:
            raise PaymentException(
                _("This card payment has already been refunded through SumUp.")
            )
        if refund.amount != refund.payment.amount:
            raise PaymentException(
                _("Only the whole payment can be refunded to the card from here. Refund "
                  "a part of it from the SumUp app.")
            )
        try:
            # Without an amount, like the till: SumUp refunds its own
            # transaction in full, which is what the card was charged.
            SumUpAccount(self.event.organizer).refund(terminal.transaction_id)
        except SumUpError as exc:
            # Kept on the refund, which pretix marks failed next: the order
            # page shows it under the failed line and the Sales page beside it.
            # The dialog's message is gone at the next click, and SumUp's own
            # dashboard, refusing the same refund, gives no reason at all.
            refund.info_data = {
                **(refund.info_data or {}),
                "transaction_id": terminal.transaction_id,
                "sumup_error": exc.reason or str(exc.message),
            }
            refund.save(update_fields=["info"])
            if exc.retryable:
                # The request may have reached SumUp and the answer been lost.
                # Asking again blind could send the money twice, so the person
                # at the dialog is told to look first.
                raise PaymentException(
                    _("SumUp did not answer, so it is not known whether the money went "
                      "back. Check transaction {transaction} in the SumUp app before "
                      "refunding again.").format(transaction=terminal.transaction_id)
                ) from exc
            raise PaymentException(exc.explained()) from exc

        terminal.refunded = now()
        terminal.save(update_fields=["refunded", "updated"])
        refund.info_data = {
            **(refund.info_data or {}),
            "transaction_id": terminal.transaction_id,
        }
        refund.done()

        # The money is back on the card, so the sale is no longer takings. A
        # cancellation made before the refund has said so in the journal
        # already, and this finds it done. Otherwise this is what says it:
        # pretix' refund dialog ticks "Mark the order as pending" by default,
        # offers "Do nothing", and its "Cancel the order" cancels only once
        # the money has gone back.
        from .backoffice import record_card_refund

        record_card_refund(refund)

    def refund_control_render(self, request, refund) -> str:
        """
        Under a card refund on the order page: the SumUp transaction, and, for
        one that failed, what SumUp answered.

        The answer is the part worth the space. A refund SumUp will not make is
        refused in its own dashboard too, without a word of why; this is where
        the organiser reconciling the evening finds out whether it was the key,
        the transaction, or SumUp being down.
        """
        info = refund.info_data or {}
        transaction = info.get("transaction_id")
        if not transaction and refund.payment is not None:
            terminal = self._terminal_payment(refund.payment)
            transaction = terminal.transaction_id if terminal else ""
        answer = info.get("sumup_error") if refund.state == refund.REFUND_STATE_FAILED else ""
        if not transaction and not answer:
            return ""
        return get_template("pretix_openpos/refund_control.html").render(
            {"transaction": transaction, "answer": answer}
        )
