"""
Which paired device is the bar till, which one is the door, and which reader
each till drives.

One screen, organizer-level because that is where pretix keeps devices: a till
is paired once and sells for whichever event is running tonight, so what it is
*for* belongs to the device and not to any one event.

Rendered as a plain table rather than a formset, for the same reason the price
screen is a table of number inputs: there is one question per device, the
answer is short, and an organizer setting up a night wants to see every device
and its role at once rather than click through them.
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
from .sumup import SumUpAccount, SumUpError

#: What may be stored, so a hand-made POST cannot invent a role.
VALID_ROLES = {choice for choice, _label in PosDevice.ROLE_CHOICES}


class DevicesView(OrganizerDetailViewMixin, OrganizerPermissionRequiredMixin, TemplateView):
    """
    Assign a role, and a card reader, to each till device.

    Guarded by the same permission as pretix' own device screens: whoever may
    pair and revoke a device is whoever may say what it is for.
    """

    template_name = "pretix_openpos/devices.html"
    permission = "organizer.devices:write"

    #: Filled on first use; see ``_readers``.
    _reader_cache = None

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

    def _readers(self):
        """
        The readers that may be picked, as ``(id, label)``, and what went wrong.

        SumUp being unreachable does not close this screen: the roles are the
        main thing here and they are stored locally. The list then holds only
        what is already assigned, so saving the form cannot silently drop a
        reader nobody could see.

        Asked once per request: rendering the page after a rejected POST would
        otherwise call SumUp twice to draw the same table.
        """
        if self._reader_cache is not None:
            return self._reader_cache
        self._reader_cache = self._fetch_readers()
        return self._reader_cache

    def _fetch_readers(self):
        account = SumUpAccount(self.request.organizer)
        if not account.configured:
            return [], None
        try:
            readers = account.readers()
        except SumUpError as exc:
            return [], exc.message
        return [
            (str(reader.get("id") or ""), str(reader.get("name") or reader.get("id") or ""))
            for reader in readers
            if reader.get("id")
        ], None

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        readers, reader_error = self._readers()
        rows = []
        for device in self._devices():
            pos_device = PosDevice.for_device(device)
            rows.append(
                {
                    "device": device,
                    "role": pos_device.role,
                    "reader": pos_device.sumup_reader_id,
                    # A reader assigned here but not in SumUp's list — unpaired
                    # from their dashboard, or simply unreachable right now. It
                    # is offered as an option of its own so that saving this
                    # form does not quietly detach it.
                    "reader_unknown": bool(pos_device.sumup_reader_id)
                    and pos_device.sumup_reader_id not in {r for r, _l in readers},
                }
            )
        # Which tills share a machine. Said on the screen rather than refused:
        # sharing works, and the one thing an organizer needs to know about it
        # is that the two tills take turns on the card.
        shared = {
            row["reader"]
            for row in rows
            if row["reader"] and sum(1 for r in rows if r["reader"] == row["reader"]) > 1
        }
        for row in rows:
            row["shares_reader"] = row["reader"] in shared
        ctx["rows"] = rows
        ctx["roles"] = PosDevice.ROLE_CHOICES
        ctx["readers"] = readers
        ctx["reader_error"] = reader_error
        ctx["sumup_url"] = reverse(
            "plugins:pretix_openpos:sumup",
            kwargs={"organizer": self.request.organizer.slug},
        )
        ctx["till_role"] = PosDevice.ROLE_TILL
        return ctx

    def post(self, request, *args, **kwargs):
        devices = list(self._devices())
        submitted = {
            device.pk: (
                (request.POST.get(f"role_{device.pk}") or ""),
                (request.POST.get(f"reader_{device.pk}") or "").strip(),
            )
            for device in devices
        }

        error = self._problem(devices, submitted)
        if error:
            # Nothing is written, and the page comes back with what is stored
            # rather than what was posted: every one of these is either a
            # hand-made POST or a form from a build that knew something this
            # one does not.
            messages.error(request, error)
            return self.render_to_response(self.get_context_data())

        # Both sides of every device that moved, not a count. "3 devices were
        # changed" is unreadable the moment anyone needs it — which is when a
        # till has stopped taking cards and somebody is working out whether the
        # reader was moved to the other tablet an hour ago, and by whom.
        changed = []
        with transaction.atomic():
            for device in devices:
                role, reader = submitted[device.pk]
                current = PosDevice.for_device(device)
                if current.pk and current.role == role and current.sumup_reader_id == reader:
                    continue
                if not current.pk and role == PosDevice.ROLE_UNSET and not reader:
                    # Leave the unassigned unassigned rather than writing a row
                    # that says nothing: "nobody has said" is a state of its own
                    # and the absence of a row is how it is spelled.
                    continue
                PosDevice.objects.update_or_create(
                    device=device, defaults={"role": role, "sumup_reader_id": reader}
                )
                changed.append({
                    "device": device.pk,
                    "device_name": device.name,
                    "role": role,
                    "role_before": current.role,
                    "reader": reader,
                    "reader_before": current.sumup_reader_id,
                })

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

    def _problem(self, devices, submitted):
        """What is wrong with this POST, or ``None``."""
        unknown_roles = sorted({role for role, _reader in submitted.values()} - VALID_ROLES)
        if unknown_roles:
            return _("“{role}” is not a role.").format(role=unknown_roles[0])

        offered, _error = self._readers()
        allowed = {reader_id for reader_id, _label in offered}
        # What is already stored stays valid even while SumUp cannot be asked,
        # so that a save made during an outage does not detach a working reader.
        allowed |= {
            PosDevice.for_device(device).sumup_reader_id
            for device in devices
            if PosDevice.for_device(device).sumup_reader_id
        }

        seen = set()
        for device in devices:
            role, reader = submitted[device.pk]
            if not reader:
                continue
            if reader not in allowed:
                return _("This organizer has no card reader “{reader}”.").format(
                    reader=reader
                )
            if role != PosDevice.ROLE_TILL:
                # The rule the whole split exists for: a reader is attached to
                # one till, and a device that is not a till has no business
                # driving one.
                return _(
                    "A card reader can only be given to a till. Set “{device}” to "
                    "till, or take its reader away."
                ).format(device=device.name)
            # Two tills sharing one reader is allowed: a bar with two tablets
            # and one machine between them is a real counter. It is safe
            # because the server serialises them — a basket cannot go on a
            # reader another till is still waiting on — and the second till
            # keeps taking cash meanwhile.
            seen.add(reader)
        return None
