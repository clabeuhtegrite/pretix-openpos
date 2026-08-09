from decimal import Decimal, InvalidOperation

from django.template.loader import get_template
from django.utils.translation import gettext_lazy as _
from pretix.base.payment import BasePaymentProvider

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
