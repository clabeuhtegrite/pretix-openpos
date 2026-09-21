"""
Which paired device is the bar till, and which one is the door.

One screen, organizer-level because that is where pretix keeps devices: a till
is paired once and sells for whichever event is running tonight, so what it is
*for* belongs to the device and not to any one event.

Rendered as a plain table of radio buttons rather than a formset, for the same
reason the price screen is a table of number inputs: there is one question per
device, the answer is one of three words, and an organizer setting up a night
wants to see every device and its role at once rather than click through them.
"""
from django.contrib import messages
from django.db import transaction
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from django.views.generic import TemplateView
from pretix.base.models import Device
from pretix.control.permissions import OrganizerPermissionRequiredMixin
from pretix.control.views.organizer import OrganizerDetailViewMixin

from .models import PosDevice

#: What may be stored, so a hand-made POST cannot invent a role.
VALID_ROLES = {choice for choice, _label in PosDevice.ROLE_CHOICES}


class DevicesView(OrganizerDetailViewMixin, OrganizerPermissionRequiredMixin, TemplateView):
    """
    Assign a role to each till device.

    Guarded by the same permission as pretix' own device screens: whoever may
    pair and revoke a device is whoever may say what it is for.
    """

    template_name = "pretix_openpos/devices.html"
    permission = "organizer.devices:write"

    def _devices(self):
        """
        Every device of this organizer that runs the till app.

        Filtered on the security profile rather than listing everything: an
        organizer using pretixSCAN alongside this plugin would otherwise be
        offered a role for devices that will never ask for one. Revoked devices
        are left out — they cannot pair, so a role for them means nothing.
        """
        return (
            Device.objects.filter(
                organizer=self.request.organizer,
                security_profile="openpos",
                revoked=False,
            )
            .select_related("openpos_device")
            .order_by("name", "pk")
        )

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        ctx["rows"] = [
            {
                "device": device,
                "role": PosDevice.for_device(device).role,
                # Shown rather than editable: a device that drives a reader is
                # the one case where the role screen is not the whole story,
                # and hiding that would make the till's refusals unexplainable.
                "reader": PosDevice.for_device(device).sumup_reader_id,
            }
            for device in self._devices()
        ]
        ctx["roles"] = PosDevice.ROLE_CHOICES
        return ctx

    def post(self, request, *args, **kwargs):
        devices = list(self._devices())
        submitted = {
            device.pk: (request.POST.get(f"role_{device.pk}") or "") for device in devices
        }

        unknown = sorted(set(submitted.values()) - VALID_ROLES)
        if unknown:
            # Nothing is written. The only way to get here is a hand-made POST
            # or a form from a build that knew a role this one does not.
            messages.error(request, _("“{role}” is not a role.").format(role=unknown[0]))
            return self.render_to_response(self.get_context_data())

        changed = 0
        with transaction.atomic():
            for device in devices:
                role = submitted[device.pk]
                current = PosDevice.for_device(device)
                if current.pk and current.role == role:
                    continue
                if not current.pk and role == PosDevice.ROLE_UNSET:
                    # Leave the unassigned unassigned rather than writing a row
                    # that says nothing: "nobody has said" is a state of its own
                    # and the absence of a row is how it is spelled.
                    continue
                PosDevice.objects.update_or_create(
                    device=device, defaults={"role": role}
                )
                changed += 1

        request.organizer.log_action(
            "pretix_openpos.devices.changed", user=request.user, data={"changed": changed}
        )
        messages.success(request, _("The roles have been saved."))
        return redirect(
            reverse(
                "plugins:pretix_openpos:devices",
                kwargs={"organizer": request.organizer.slug},
            )
        )
