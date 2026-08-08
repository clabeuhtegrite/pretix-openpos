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

STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static", "pretix_openpos")


class ShellView(TemplateView):
    """
    The app shell.

    Deliberately unauthenticated: the bundle holds no secrets, and the device
    token that does is obtained through the pairing flow and kept in the
    browser's own storage.
    """

    template_name = "pretix_openpos/pwa.html"


def manifest(request):
    return JsonResponse(
        {
            "name": str(_("Open POS")),
            "short_name": "Open POS",
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
