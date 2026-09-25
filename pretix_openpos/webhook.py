"""
Where SumUp tells us a card was tapped.

This endpoint is an optimisation and nothing more. The till settles every
payment by asking SumUp's Transactions API on a timer, so an installation SumUp
cannot reach — a pretix behind a VPN, a laptop on a venue wifi — works exactly
the same, a second or two slower. What this buys is the second or two, in front
of a customer, which is worth having.

Two things follow from that, and they are the whole design:

**Nothing here is believed.** SumUp's reader callback carries no signature: an
event id, a client transaction id, a merchant code and a word saying
"successful", none of it authenticated. So the callback is not evidence. It
causes the server to go and ask the Transactions API what happened, and that
answer — fetched over an authenticated connection — is what gets written down.
A forged callback can, at most, make the server look something up early.

**The URL is unguessable.** Not as a security boundary, since the paragraph
above is the boundary, but so that the lookup cannot be made to run by anyone
who merely knows an organizer's slug. The token is a random string per
organizer, minted the first time a reader payment is started.
"""
import logging

from django.http import Http404, HttpResponse
from django.utils.crypto import get_random_string
from django.views.decorators.csrf import csrf_exempt
from django.views.decorators.http import require_POST
from django_scopes import scopes_disabled
from pretix.base.models import Organizer

logger = logging.getLogger(__name__)

#: Long enough that guessing is not a strategy.
TOKEN_LENGTH = 40
TOKEN_SETTING = "openpos_sumup_webhook_token"


def webhook_token(organizer) -> str:
    """This organizer's callback token, minted on first use."""
    token = organizer.settings.get(TOKEN_SETTING)
    if not token:
        token = get_random_string(TOKEN_LENGTH)
        organizer.settings.set(TOKEN_SETTING, token)
    return token


def webhook_url(organizer) -> str | None:
    """
    Where SumUp should post, or ``None`` when it could not reach us anyway.

    SumUp requires an HTTPS callback. An installation served over plain HTTP —
    a development box, mostly — gets no ``return_url`` at all rather than one
    SumUp will refuse: the polling path settles those payments on its own, and
    a rejected checkout in front of a customer would be a real failure in
    exchange for a cosmetic one.
    """
    from django.conf import settings

    base = (getattr(settings, "SITE_URL", "") or "").rstrip("/")
    if not base.startswith("https://"):
        return None
    return f"{base}/openpos/sumup/{organizer.slug}/{webhook_token(organizer)}/"


@csrf_exempt
@require_POST
def sumup_callback(request, organizer, token):
    """
    A nudge from SumUp that a reader payment reached a final state.

    Answers 200 to anything it recognises, including a payment it has already
    settled: SumUp retries a callback up to five times on any other status, and
    there is nothing to retry once the answer is known. The body is read for a
    single field — which payment to go and look up — and nothing in it is
    written down.
    """
    from .api.terminal import settle_terminal_payment
    from .models import PosTerminalPayment
    from .sumup import SumUpAccount

    with scopes_disabled():
        organizer_obj = Organizer.objects.filter(slug=organizer).first()
        if organizer_obj is None:
            raise Http404()
        # Constant-time-ish is not the point — the token is not a credential,
        # it only keeps the lookup below from being trivially reachable — but
        # a mismatch is still a 404 rather than a hint.
        if token != organizer_obj.settings.get(TOKEN_SETTING):
            raise Http404()

        try:
            payload = _json(request)
        except ValueError:
            return HttpResponse(status=400)

        client_transaction_id = str(
            (payload.get("payload") or {}).get("client_transaction_id") or ""
        )
        if not client_transaction_id:
            return HttpResponse(status=400)

        payment = PosTerminalPayment.objects.filter(
            client_transaction_id=client_transaction_id,
            event__organizer=organizer_obj,
        ).first()
        if payment is None:
            # Not ours, or already gone. Answering 200 stops SumUp retrying
            # something that will never resolve.
            return HttpResponse(status=200)

        settle_terminal_payment(payment, SumUpAccount(organizer_obj))
        return HttpResponse(status=200)


def _json(request):
    import json

    return json.loads(request.body.decode("utf-8") or "{}")
