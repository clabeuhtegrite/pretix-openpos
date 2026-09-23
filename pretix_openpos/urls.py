from django.urls import re_path
from pretix.api.urls import event_router, orga_router

from . import arrivals, devices, drawer_views, pwa, sumup_views, views, webhook
from .api.views import OpenPosOrganizerViewSet, OpenPosViewSet

urlpatterns = [
    # The till app itself. Public: the bundle carries no secrets, and the device
    # token is obtained through pairing and lives in the browser.
    re_path(r"^openpos/$", pwa.ShellView.as_view(), name="pwa"),
    re_path(r"^openpos/manifest\.webmanifest$", pwa.manifest, name="pwa.manifest"),
    # Must be served from this path, not from /static/, or its scope could not
    # cover /openpos/.
    re_path(r"^openpos/sw\.js$", pwa.service_worker, name="pwa.sw"),
    # Where SumUp posts when a reader payment ends. Public by necessity and
    # unauthenticated by SumUp's design — which is why nothing it says is
    # believed; see webhook.py.
    re_path(
        r"^openpos/sumup/(?P<organizer>[^/]+)/(?P<token>[^/]+)/$",
        webhook.sumup_callback,
        name="sumup.callback",
    ),
    re_path(
        r"^control/event/(?P<organizer>[^/]+)/(?P<event>[^/]+)/openpos/$",
        views.SettingsView.as_view(),
        name="settings",
    ),
    # Event-level, unlike the roles themselves: a category belongs to one
    # event, a paired device does not. The two meet in the role.
    re_path(
        r"^control/event/(?P<organizer>[^/]+)/(?P<event>[^/]+)/openpos/categories/$",
        views.CategoriesView.as_view(),
        name="categories",
    ),
    re_path(
        r"^control/event/(?P<organizer>[^/]+)/(?P<event>[^/]+)/openpos/sales/$",
        views.SalesView.as_view(),
        name="sales",
    ),
    re_path(
        r"^control/event/(?P<organizer>[^/]+)/(?P<event>[^/]+)/openpos/sales/catch-up/$",
        views.CatchUpView.as_view(),
        name="sales.catch_up",
    ),
    # One evening's arrivals, next to its takings: who came in, and when.
    re_path(
        r"^control/event/(?P<organizer>[^/]+)/(?P<event>[^/]+)/openpos/arrivals/$",
        arrivals.EventArrivalsView.as_view(),
        name="event_arrivals",
    ),
    # Organizer-level, unlike the screens above: "when do people arrive?" is a
    # question about all past events at once, not about any single one.
    re_path(
        r"^control/organizer/(?P<organizer>[^/]+)/openpos/arrivals/$",
        arrivals.ArrivalsView.as_view(),
        name="arrivals",
    ),
    # Organizer-level for a different reason: pretix keeps devices there, and a
    # till is paired once and sells for whichever event is running tonight.
    re_path(
        r"^control/organizer/(?P<organizer>[^/]+)/openpos/devices/$",
        devices.DevicesView.as_view(),
        name="devices",
    ),
    # Organizer-level because a card reader belongs to the association rather
    # than to one evening, and because the devices it is given to are here too.
    re_path(
        r"^control/organizer/(?P<organizer>[^/]+)/openpos/sumup/$",
        sumup_views.SumUpView.as_view(),
        name="sumup",
    ),
    # Organizer-level too: a drawer is the bar's drawer whichever event is on,
    # and its tills are given to it on the devices screen next door.
    re_path(
        r"^control/organizer/(?P<organizer>[^/]+)/openpos/drawers/$",
        drawer_views.DrawersView.as_view(),
        name="drawers",
    ),
    re_path(
        r"^control/organizer/(?P<organizer>[^/]+)/openpos/drawers/(?P<drawer>\d+)/$",
        drawer_views.DrawerView.as_view(),
        name="drawer",
    ),
    re_path(
        r"^control/organizer/(?P<organizer>[^/]+)/openpos/drawers/(?P<drawer>\d+)/(?P<session>\d+)/$",
        drawer_views.DrawerSessionView.as_view(),
        name="drawer.session",
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
