from django import forms
from django.utils.translation import gettext_lazy as _
from pretix.base.forms import SettingsForm

from .channels import POS_CHANNEL


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

    #: Not a plugin setting of its own: this drives pretix' own
    #: `invoice_generate_sales_channels`, surfaced here because it is invisible
    #: from the till and decides whether a cancellation can produce a credit
    #: note at all. Without it, correcting a sale still reverses the journal and
    #: refunds the money — there is simply no invoice to credit.
    openpos_invoices = forms.BooleanField(
        label=_("Issue invoices for till sales"),
        help_text=_(
            "Adds the Open POS channel to the sales channels pretix invoices. Cancelling "
            "a sale from the till then issues a credit note for it, which is what makes "
            "a corrected order a paper trail rather than an edit. Requires invoicing to "
            "be switched on for the event at all."
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
        self.fields["openpos_invoices"].initial = POS_CHANNEL in (
            self.obj.settings.get("invoice_generate_sales_channels", as_type=list) or []
        )

    def save(self, *args, **kwargs):
        result = super().save(*args, **kwargs)

        # Edit pretix' own list rather than shadowing it: every other channel
        # the organiser has chosen stays exactly as they left it. The default is
        # ["web"], so a POS-only event starts with the box unticked and nothing
        # about the webshop changes when it is ticked.
        channels = self.obj.settings.get("invoice_generate_sales_channels", as_type=list) or ["web"]
        channels = [c for c in channels if c != POS_CHANNEL]
        if self.cleaned_data.get("openpos_invoices"):
            channels.append(POS_CHANNEL)
        self.obj.settings.set("invoice_generate_sales_channels", channels)
        return result
