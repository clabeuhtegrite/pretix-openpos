from django import forms
from django.utils.translation import gettext_lazy as _
from pretix.base.forms import SettingsForm


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

    def __init__(self, *args, **kwargs):
        super().__init__(*args, **kwargs)
        self.fields["openpos_checkin_list"].choices = [
            ("", _("Do not check in automatically")),
        ] + [
            (str(cl.pk), str(cl.name)) for cl in self.obj.checkin_lists.all()
        ]
