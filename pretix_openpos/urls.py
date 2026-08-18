from django.urls import re_path
from pretix.api.urls import event_router, orga_router

from . import arrivals, pwa, views
from .api.views import OpenPosOrganizerViewSet, OpenPosViewSet

urlpatterns = [
    # The till app itself. Public: the bundle carries no secrets, and the device
    # token is obtained through pairing and lives in the browser.
    re_path(r"^openpos/$", pwa.ShellView.as_view(), name="pwa"),
    re_path(r"^openpos/manifest\.webmanifest$", pwa.manifest, name="pwa.manifest"),
    # Must be served from this path, not from /static/, or its scope could not
    # cover /openpos/.
    re_path(r"^openpos/sw\.js$", pwa.service_worker, name="pwa.sw"),
    re_path(
        r"^control/event/(?P<organizer>[^/]+)/(?P<event>[^/]+)/openpos/$",
        views.SettingsView.as_view(),
        name="settings",
    ),
    re_path(
        r"^control/event/(?P<organizer>[^/]+)/(?P<event>[^/]+)/openpos/prices/$",
        views.PricesView.as_view(),
        name="prices",
    ),
    re_path(
        r"^control/event/(?P<organizer>[^/]+)/(?P<event>[^/]+)/openpos/sales/$",
        views.SalesView.as_view(),
        name="sales",
    ),
    # Organizer-level, unlike the screens above: "when do people arrive?" is a
    # question about all past events at once, not about any single one.
    re_path(
        r"^control/organizer/(?P<organizer>[^/]+)/openpos/arrivals/$",
        arrivals.ArrivalsView.as_view(),
        name="arrivals",
    ),
]

# pretix force-imports this module from pretix.api.urls once the routers exist,
# so registering on event_router here is the supported way for a plugin to add
# API endpoints. Routes land under
# /api/v1/organizers/<org>/events/<event>/openpos/<action>/
event_router.register(r"openpos", OpenPosViewSet, basename="openpos")

# Organizer level: which events may this till sell for? Answering that needs to
# happen before an event is picked, so it cannot live on the event router.
orga_router.register(r"openpos", OpenPosOrganizerViewSet, basename="openpos-orga")
