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

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["openpos_checkin_list"].choices = [
            ("", _("Do not check in automatically")),
        ] + [
            (str(cl.pk), str(cl.name)) for cl in self.obj.checkin_lists.all()
        ]
        self.fields["openpos_invoices"].initial = pos_invoices_enabled(self.obj)

    def save(self, *args, **kwargs):
        result = super().save(*args, **kwargs)
        set_pos_invoices(self.obj, bool(self.cleaned_data.get("openpos_invoices")))
        return result
