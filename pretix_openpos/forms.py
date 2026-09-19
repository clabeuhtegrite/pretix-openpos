from django import forms
from django.utils.translation import gettext_lazy as _
from pretix.base.forms import SettingsForm

from .invoicing import pos_invoices_enabled, set_pos_invoices


class OpenPosSettingsForm(SettingsForm):
    openpos_checkin_list = forms.ChoiceField(
        label=_("Check-in list for immediate entry"),
        help_text=_(
            "Tickets sold at the till are checked in on this list straight away, so the "
            "customer can walk in without being handed anything. Leave empty to sell "
            "without checking in."
        ),
        required=False,
    )

    #: On unless turned off — see invoicing.py for why the plugin answers this
    #: question for its own channel instead of deferring to the event.
    openpos_invoices = forms.BooleanField(
        label=_("Issue invoices for till sales"),
        help_text=_(
            "Every sale made at the till gets an invoice, so cancelling one issues a "
            "credit note for it — which is what makes a corrected order a paper trail "
            "rather than an edit. This covers the Open POS channel only: the webshop "
            "keeps whatever invoicing rules you set for it."
        ),
        required=False,
    )

    #: Off unless a product is named. This is the one setting that lets the till
    #: decide a price, so it is deliberately not a checkbox: enabling it means
    #: naming the single product every free-amount sale is booked against, and
    #: the server refuses any other.
    openpos_custom_item = forms.ChoiceField(
        label=_("Product for free-amount sales"),
        help_text=_(
            "Adds a “free amount” button to the till, for what has no product of its "
            "own — a damaged glass, a donation, a plate at a stand. The cashier types "
            "the amount and a reason; the sale is booked against this product and the "
            "reason is kept in the till journal and on the order. Leave empty to keep "
            "the button off, which is the default: everywhere else the till sends "
            "product ids and the server decides what they cost."
        ),
        required=False,
    )

    #: Off unless a product is named. Enabling it puts a second button at the
    #: till — the return — beside the deposit product's own tile.
    openpos_deposit_item = forms.ChoiceField(
        label=_("Cup deposit product"),
        help_text=_(
            "Sell the deposit like any other product, then let the till hand it back: "
            "naming it here adds a “deposit back” button that takes its on-site price "
            "off the basket. A return is not a pretix order — an order cannot total "
            "less than nothing, and the end of an evening is people returning cups and "
            "buying nothing — so it is recorded in the till journal, where the takings "
            "and the drawer are reconciled. Leave empty to keep the button off."
        ),
        required=False,
    )

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["openpos_checkin_list"].choices = [
            ("", _("Do not check in automatically")),
        ] + [
            (str(cl.pk), str(cl.name)) for cl in self.obj.checkin_lists.all()
        ]
        self.fields["openpos_invoices"].initial = pos_invoices_enabled(self.obj)

        # Products with variations are excluded from both: a free amount and a
        # returned cup have no option for the cashier to pick, and offering one
        # here would produce a till button that the order pipeline then refuses
        # for want of a variation.
        plain_items = [
            (str(item.pk), str(item.name))
            for item in self.obj.items.prefetch_related("variations").order_by(
                "category__position", "category_id", "position", "pk"
            )
            if not item.variations.all()
        ]
        self.fields["openpos_custom_item"].choices = [
            ("", _("No free-amount button")),
        ] + plain_items
        self.fields["openpos_deposit_item"].choices = [
            ("", _("No deposit button")),
        ] + plain_items

    def save(self, *args, **kwargs):
        result = super().save(*args, **kwargs)
        set_pos_invoices(self.obj, bool(self.cleaned_data.get("openpos_invoices")))
        return result
