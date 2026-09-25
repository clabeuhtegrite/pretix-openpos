import logging

from django.utils.translation import gettext_lazy as _
from pretix.api.auth.devicesecurity import AllowListSecurityProfile

logger = logging.getLogger(__name__)

#: The name search pretix answers a device with, as the security profile knows it.
SEARCH = ("GET", "api-v1:checkinrpc.search")

#: Characters a name search must hold, spaces not counted, before it is let through.
#:
#: pretix' own floor for a caller without full access to the lists, which a
#: device has: it answers a shorter search with nothing for those callers,
#: and with everything for the others.
SEARCH_MIN_CHARACTERS = 3


def narrow_search(request) -> bool:
    """
    Whether every ``search`` term in this request is long enough to be a search.

    Every term, not only the one pretix will use: a query string may repeat a
    parameter, and which of the copies a filter reads is pretix' business.
    Whitespace does not count, so three spaces are not a search either.
    """
    terms = request.query_params.getlist("search")
    return bool(terms) and all(
        len("".join(term.split())) >= SEARCH_MIN_CHARACTERS for term in terms
    )


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
        # The till's own account of the sales it has not sent yet, for the
        # back office. Writes to this device's row and to nothing else.
        ("POST", "api-v1:openpos-orga-status"),
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
        # The cash drawer this till is assigned: opening it on a counted float,
        # money put in or taken out, the count and the closing. Each one
        # acts on this till's own drawer and no other.
        ("GET", "api-v1:openpos-drawer"),
        ("POST", "api-v1:openpos-drawer-open"),
        ("POST", "api-v1:openpos-drawer-movement"),
        ("POST", "api-v1:openpos-drawer-count"),
        ("POST", "api-v1:openpos-drawer-close"),
        # Scanning tickets at the door. pretix' own check-in RPC is used rather
        # than a POS-specific endpoint: it already carries the rules engine,
        # revoked/blocked secrets, and the exact semantics pretixSCAN relies on.
        ("POST", "api-v1:checkinrpc.redeem"),
        # A refusal given with no network, sent once there is one — pretix'
        # own way of hearing about it, and the one pretixSCAN uses. Online,
        # pretix writes every refused scan down itself; without this, a door
        # that was offline left no trace of the tickets it turned away.
        ("POST", "api-v1:checkinlist-failed_checkins"),
        # Finding a ticket by name. Tickets carry a QR and nothing a human could
        # retype, so when the code will not scan the only way through is to look
        # the holder up. Only with a real search term: see ``is_allowed``.
        SEARCH,
    )

    def is_allowed(self, request):
        """
        The allowlist, and for the name search, a term worth the name.

        pretix only holds a caller to its three-character minimum when that
        caller cannot read every order of the lists it asks about — and a
        device paired for an event can. With no term at all it answers with
        every ticket of the lists asked for: names, e-mail addresses, the
        secrets that are the tickets, for every event the device can see,
        past ones included. One request would take the whole guest list, and
        the door has never needed that: it looks up one holder whose code will
        not scan. So the profile asks for the minimum pretix asks of everybody
        else, per request, since the allowlist only knows paths.
        """
        if not super().is_allowed(request):
            return False
        key = (request.method, f"{request.resolver_match.namespace}:{request.resolver_match.url_name}")
        if key == SEARCH and not narrow_search(request):
            logger.info(
                "Request %s not allowed in profile %s: search term shorter than %s characters",
                key, self.identifier, SEARCH_MIN_CHARACTERS,
            )
            return False
        return True
