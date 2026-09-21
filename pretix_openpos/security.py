from django.utils.translation import gettext_lazy as _
from pretix.api.auth.devicesecurity import AllowListSecurityProfile


class OpenPosSecurityProfile(AllowListSecurityProfile):
    """
    Restricts a paired till to exactly the endpoints the PWA needs.

    A device token is stored in the browser of a tablet that lives on a counter,
    so it should be assumed to leak eventually. Devices already cannot touch
    events, products or vouchers, but the default profile still grants blanket
    read/write on every order of every event the device can see. This profile
    narrows that down to the POS endpoints plus the device lifecycle calls the
    app needs to pair, refresh and revoke itself.
    """

    identifier = "openpos"
    verbose_name = _("Open POS")

    allowlist = (
        # Device lifecycle, mirroring what pretixSCAN is allowed to do.
        ("GET", "api-v1:version"),
        ("GET", "api-v1:device.info"),
        ("POST", "api-v1:device.update"),
        ("POST", "api-v1:device.roll"),
        ("POST", "api-v1:device.revoke"),
        ("GET", "api-v1:device.eventselection"),
        # Event context, needed to display the event name and currency.
        ("GET", "api-v1:event-list"),
        ("GET", "api-v1:event-detail"),
        # The POS endpoints themselves.
        ("GET", "api-v1:openpos-orga-list"),
        ("GET", "api-v1:openpos-config"),
        ("GET", "api-v1:openpos-catalog"),
        ("POST", "api-v1:openpos-checkout"),
        # Driving the card reader this till is assigned. Starting a payment is
        # a write and is deliberately in the same profile as the checkout it
        # leads to: a token that can sell can also ask for the money.
        ("POST", "api-v1:openpos-terminal-start"),
        ("GET", "api-v1:openpos-terminal-status"),
        ("POST", "api-v1:openpos-terminal-cancel"),
        ("GET", "api-v1:openpos-summary"),
        ("GET", "api-v1:openpos-attendance"),
        # Correcting a sale made on this same till. The endpoint itself refuses
        # anything that is not this device's own, so the token cannot be used to
        # unpick another till's takings.
        ("GET", "api-v1:openpos-history"),
        # The snapshot a till carries so a network dropout does not close the door.
        ("GET", "api-v1:openpos-offline"),
        ("POST", "api-v1:openpos-cancel"),
        # Scanning tickets at the door. pretix' own check-in RPC is used rather
        # than a POS-specific endpoint: it already carries the rules engine,
        # revoked/blocked secrets, and the exact semantics pretixSCAN relies on.
        ("POST", "api-v1:checkinrpc.redeem"),
        # Finding a ticket by name. Tickets carry a QR and nothing a human could
        # retype, so when the code will not scan the only way through is to look
        # the holder up.
        ("GET", "api-v1:checkinrpc.search"),
    )
