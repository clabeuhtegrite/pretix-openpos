"""
Serving of the progressive web app shell.

Three things are served from under ``/openpos/`` rather than straight out of the
static directory:

* the **shell**, so the app has a stable, bookmarkable, installable URL;
* the **manifest**, so ``start_url`` and ``scope`` can point at that URL;
* the **service worker**, because a worker may only control URLs at or below its
  own path. Served from ``/static/…`` it could never control ``/openpos/``.
"""
import os

from django.http import FileResponse, JsonResponse
from django.templatetags.static import static
from django.utils.translation import gettext_lazy as _
from django.views.decorators.cache import cache_control
from django.views.generic import TemplateView
from pretix.base.settings import GlobalSettingsObject

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "pretix_openpos")

#: Fallback name of the installed app. Overridable per installation, because the
#: label a volunteer sees on the home screen is the venue's, not the software's:
#:
#:     python -m pretix shell -c "
#:     from pretix.base.settings import GlobalSettingsObject
#:     GlobalSettingsObject().settings.set('openpos_app_name', 'Your name here')"
#:
#: The manifest is served from a single global URL, so this cannot be per-event.
DEFAULT_APP_NAME = "Open POS"


def app_name() -> str:
    return GlobalSettingsObject().settings.get("openpos_app_name") or DEFAULT_APP_NAME


#: Everything the shell loads is same-origin, so say exactly that.
#:
#: The device token lives in localStorage on a tablet that sits on a counter;
#: a script injected from anywhere would walk off with it, and this header is
#: the cheap way to make "from anywhere" mean "from nowhere". style-src keeps
#: 'unsafe-inline' because React writes style attributes; scripts get no such
#: allowance.
#:
#: This is a request, not the final answer. pretix' CSP middleware re-parses the
#: header and merges its own instance-wide policy into it, so what reaches the
#: browser is wider than what is written here — the site URL joins several
#: directives, and ``form-action`` ends up allowing ``http:`` and ``https:``
#: outright. What survives the merge is the part that matters: no
#: ``'unsafe-inline'`` and no ``'unsafe-eval'`` in ``script-src``. The test suite
#: asserts that on the header actually sent rather than on this constant.
#:
#: The middleware also refuses directives outside its own whitelist — with a
#: 500, found by serving the page, not by reading the docs. So no
#: ``frame-ancestors`` and no ``base-uri`` here: framing is already denied by the
#: global X-Frame-Options, and the page carries no ``<base>`` for the latter to
#: police.
SHELL_CSP = (
    "default-src 'self'; "
    "script-src 'self'; "
    "style-src 'self' 'unsafe-inline'; "
    "img-src 'self' data:; "
    "connect-src 'self'; "
    "manifest-src 'self'; "
    "worker-src 'self'; "
    "object-src 'none'; "
    "form-action 'self'"
)


class ShellView(TemplateView):
    """
    The app shell.

    Deliberately unauthenticated: the bundle holds no secrets, and the device
    token that does is obtained through the pairing flow and kept in the
    browser's own storage.
    """

    template_name = "pretix_openpos/pwa.html"

    def get(self, request, *args, **kwargs):
        response = super().get(request, *args, **kwargs)
        response["Content-Security-Policy"] = SHELL_CSP
        return response

    def get_context_data(self, **kwargs):
        ctx = super().get_context_data(**kwargs)
        ctx["app_name"] = app_name()
        return ctx


def manifest(request):
    name = app_name()
    return JsonResponse(
        {
            "name": name,
            "short_name": name,
            "description": str(_("Point of sale for pretix")),
            "start_url": "/openpos/",
            "scope": "/openpos/",
            "display": "standalone",
            "orientation": "any",
            "background_color": "#12161f",
            "theme_color": "#12161f",
            "icons": [
                {
                    "src": static("pretix_openpos/icons/icon-192.png"),
                    "sizes": "192x192",
                    "type": "image/png",
                },
                {
                    "src": static("pretix_openpos/icons/icon-512.png"),
                    "sizes": "512x512",
                    "type": "image/png",
                },
                {
                    "src": static("pretix_openpos/icons/icon-maskable-512.png"),
                    "sizes": "512x512",
                    "type": "image/png",
                    "purpose": "maskable",
                },
            ],
        },
        content_type="application/manifest+json",
    )


@cache_control(no_cache=True, must_revalidate=True, max_age=0)
def service_worker(request):
    # Never cached: a stale worker is how a PWA gets stuck on an old build.
    return FileResponse(
        open(os.path.join(STATIC_DIR, "sw.js"), "rb"),
        content_type="text/javascript",
    )
