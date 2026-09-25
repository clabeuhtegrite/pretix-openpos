"""
The SumUp side of the back office: the account, and the readers paired to it.

Kept apart from the device screen next door, which answers a different question.
That one says what each tablet is for; this one is about the card readers
themselves — whose account they belong to, and which ones exist. A reader is
then attached to a till on the device screen, because that is where the till is.
"""
import logging

from django.contrib import messages
from django.db import transaction
from django.shortcuts import redirect
from django.urls import reverse
from django.utils.translation import gettext_lazy as _
from pretix.base.models import Organizer
from pretix.control.views.organizer import OrganizerSettingsFormView

from .forms import SumUpSettingsForm
from .models import PosDevice
from .sumup import SumUpAccount, SumUpError, is_reader_id
from .webhook import webhook_url

logger = logging.getLogger(__name__)


class SumUpView(OrganizerSettingsFormView):
    """
    Credentials, the readers they reach, and pairing a new one.

    A ``FormView`` for the credentials with two extra POST actions hung off it,
    told apart by a hidden ``action`` field. They belong on one page because
    they are one job — "set up the card readers" — and splitting them would
    mean an organizer who has just typed an API key has to go somewhere else to
    find out whether it works.
    """

    model = Organizer
    form_class = SumUpSettingsForm
    template_name = "pretix_openpos/sumup.html"
    #: The permission pretix asks for its own organizer settings — the one
    #: ``OrganizerSettingsFormView`` declares, spelt out here so that nobody
    #: reading this class has to go and look, and so that the menu entry can
    #: ask for the same thing.
    #:
    #: It used to be the devices one, because readers felt like devices. But
    #: this page holds the merchant code and the key, and whoever holds those
    #: decides whose account every card payment at every till lands in. The
    #: devices permission is the one handed to whoever pairs the tablets on
    #: the evening; it must not be enough to send the takings somewhere else.
    #: Attaching a reader to a till stays on the devices screen, under the
    #: devices permission: it can only pick among the readers of the account
    #: this page set up.
    permission = "organizer.settings.general:write"

    def get_success_url(self):
        return reverse(
            "plugins:pretix_openpos:sumup",
            kwargs={"organizer": self.request.organizer.slug},
        )

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        account = SumUpAccount(self.request.organizer)
        ctx["configured"] = account.configured
        ctx["readers"] = []
        ctx["reader_error"] = None
        ctx["orphans"] = []

        assigned = {
            row.sumup_reader_id: row
            for row in PosDevice.objects.filter(
                device__organizer=self.request.organizer
            ).exclude(sumup_reader_id="").select_related("device")
        }
        if account.configured:
            try:
                readers = account.readers()
            except SumUpError as exc:
                # Shown rather than raised: a key that has been revoked, or a
                # SumUp that is down, must not turn this page into a 500 — it
                # is the page an organizer comes to in order to fix exactly
                # that.
                ctx["reader_error"] = exc.message
            else:
                ctx["readers"] = [
                    self._row(reader, assigned, account) for reader in readers
                ]
                # A till pointing at a reader SumUp has never heard of refuses
                # every card payment, and does so silently as far as the cashier
                # is concerned. It happens when a reader is unpaired from the
                # SumUp dashboard rather than from here, so it is worth saying
                # out loud on the one screen that can see both sides.
                known = {str(reader.get("id") or "") for reader in readers}
                ctx["orphans"] = [
                    row for reader_id, row in sorted(assigned.items())
                    if reader_id not in known
                ]
        # So an organizer can see whether SumUp will be able to call back, and
        # why it will not on a plain-HTTP install.
        ctx["webhook_url"] = webhook_url(self.request.organizer)
        return ctx

    @staticmethod
    def _row(reader, assigned, account):
        """One reader as the template wants it, rather than as SumUp sends it."""
        reader_id = str(reader.get("id") or "")
        status = str(reader.get("status") or "")
        row = assigned.get(reader_id)
        paired = status == "paired"
        # Only the paired ones, and only one call each: a reader that is still
        # acknowledging its pairing has nothing to say, and this runs while an
        # organizer waits for a page.
        live = account.reader_status(reader_id) if paired else None
        state = str((live or {}).get("state") or "")
        # A float in SumUp's answer (72.5), which nobody reads to the decimal.
        battery = (live or {}).get("battery_level")
        return {
            "id": reader_id,
            "name": reader.get("name") or reader_id,
            "model": (reader.get("device") or {}).get("model") or "",
            "status": status,
            "paired": paired,
            # SumUp answers a pairing request before the physical device has
            # acknowledged it, so this state is normal for a few seconds and
            # not a failure.
            "pairing": status == "processing",
            "till": row.device if row else None,
            # None when the reader could not be asked — firmware too old, or
            # SumUp slow to answer. Distinct from "offline", which is a thing
            # SumUp actually said.
            "live": live,
            "online": bool(live) and live.get("status") == "ONLINE",
            "state": state,
            "busy": state in SumUpAccount.BUSY_STATES,
            # It takes no payment until it has finished, and SumUp readers
            # update themselves when switched on — the start of an evening.
            "updating": state == SumUpAccount.STATE_UPDATING,
            "battery": round(battery) if isinstance(battery, (int, float)) else None,
            "firmware": (live or {}).get("firmware_version") or "",
            "connection": (live or {}).get("connection_type") or "",
        }

    def post(self, request, *args, **kwargs):
        action = request.POST.get("action", "settings")
        if action == "pair":
            return self._pair(request)
        if action == "forget":
            return self._forget(request)
        if action == "free":
            return self._free(request)
        return self._save_settings(request)

    @transaction.atomic
    def _save_settings(self, request):
        """
        Like pretix' own settings view, minus what it logs.

        ``OrganizerSettingsFormView`` writes every changed field's *value* into
        the organizer's log. One of these fields is an API key, and a log entry
        is not where it belongs, so only the names of what changed are recorded.
        """
        form = self.get_form()
        if not form.is_valid():
            messages.error(request, _("We could not save your changes. See below for details."))
            return self.render_to_response(self.get_context_data(form=form))
        form.save()
        if form.has_changed():
            request.organizer.log_action(
                "pretix_openpos.sumup.settings",
                user=request.user,
                data={"changed": sorted(form.changed_data)},
            )
        messages.success(request, _("Your changes have been saved."))
        return redirect(self.get_success_url())

    def _pair(self, request):
        """Claim the reader showing a pairing code."""
        account = SumUpAccount(request.organizer)
        code = (request.POST.get("pairing_code") or "").strip()
        name = (request.POST.get("reader_name") or "").strip() or _("Till reader")
        if not code:
            messages.error(request, _("Enter the pairing code shown on the reader."))
            return redirect(self.get_success_url())
        try:
            reader = account.pair_reader(code, str(name))
        except SumUpError as exc:
            messages.error(request, exc.message)
            return redirect(self.get_success_url())

        request.organizer.log_action(
            "pretix_openpos.sumup.reader.paired",
            user=request.user,
            data={"reader": reader.get("id", "")},
        )
        if reader.get("status") == "paired":
            messages.success(request, _("The reader is paired."))
        else:
            # SumUp answers before the physical device has acknowledged, which
            # takes a few seconds. Saying "paired" here would have an organizer
            # assign a reader that is not ready and then wonder why the till
            # refuses.
            messages.success(
                request,
                _("SumUp has accepted the code. The reader will show as paired "
                  "once the device itself confirms — reload in a few seconds."),
            )
        return redirect(self.get_success_url())

    @staticmethod
    def _posted_reader(request):
        """
        The reader a form names, or ``None`` after saying it is not one.

        The id goes into the path of a call made with the organizer's key, so
        it is held to the shape of a SumUp reader id before anything else
        happens. The page only ever posts ids SumUp itself listed; anything
        else was typed by hand, and is not echoed back.
        """
        reader_id = (request.POST.get("reader_id") or "").strip()
        if is_reader_id(reader_id):
            return reader_id
        messages.error(request, _("This is not a SumUp reader."))
        return None

    def _free(self, request):
        """
        Take whatever is on a reader's screen off it.

        For the reader left showing an amount nobody is coming back for: a till
        that crashed mid-payment, a basket put on and then abandoned. Until it
        is cleared the reader refuses the next payment as busy, which at the
        door reads as "the card machine is broken".

        Deliberately does *not* touch the payment row. Terminating is
        best-effort and SumUp confirms nothing, so this cannot say whether the
        cardholder had already paid — only SumUp's own transaction can, and
        that is what settling asks. Writing "failed" here on a guess is exactly
        the mistake this plugin has already made once.
        """
        reader_id = self._posted_reader(request)
        if reader_id is None:
            return redirect(self.get_success_url())
        account = SumUpAccount(request.organizer)
        try:
            account.terminate_checkout(reader_id)
        except SumUpError as exc:
            messages.error(request, exc.message)
            return redirect(self.get_success_url())
        request.organizer.log_action(
            "pretix_openpos.sumup.reader.freed",
            user=request.user,
            data={"reader": reader_id},
        )
        messages.success(
            request,
            _("The reader has been asked to clear its screen. If a card had "
              "already been accepted, that payment still stands — check the "
              "till sales page before charging again."),
        )
        return redirect(self.get_success_url())

    def _forget(self, request):
        reader_id = self._posted_reader(request)
        if reader_id is None:
            return redirect(self.get_success_url())
        account = SumUpAccount(request.organizer)
        try:
            account.forget_reader(reader_id)
        except SumUpError as exc:
            messages.error(request, exc.message)
            return redirect(self.get_success_url())
        # A till still pointing at it would refuse every card payment, with no
        # way for the cashier to know why. Detaching here keeps the two in step.
        PosDevice.objects.filter(
            device__organizer=request.organizer, sumup_reader_id=reader_id
        ).update(sumup_reader_id="")
        request.organizer.log_action(
            "pretix_openpos.sumup.reader.forgotten",
            user=request.user,
            data={"reader": reader_id},
        )
        messages.success(request, _("The reader has been removed."))
        return redirect(self.get_success_url())
