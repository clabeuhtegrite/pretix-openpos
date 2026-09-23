from django.dispatch import receiver
from django.urls import resolve, reverse
from django.utils.translation import gettext_lazy as _
from pretix.api.signals import register_device_security_profile
from pretix.base.signals import (
    event_copy_data, order_canceled, order_reactivated, register_payment_providers, register_sales_channel_types,
)
from pretix.control.signals import nav_event, nav_organizer

from .channels import PosSalesChannelType
from .drawer_views import can_read_drawers
from .payment import OpenPosCardProvider, OpenPosCashProvider
from .security import OpenPosSecurityProfile
from .views import CategoriesView, SalesView


@receiver(register_sales_channel_types, dispatch_uid="openpos_register_sales_channel_type")
def openpos_sales_channel_types(sender, **kwargs):
    # Global signal: it is sent with sender=None and the result is cached
    # process-wide, so this must not depend on any event.
    return PosSalesChannelType()


@receiver(register_device_security_profile, dispatch_uid="openpos_register_security_profile")
def openpos_device_security_profile(sender, **kwargs):
    return OpenPosSecurityProfile()


@receiver(register_payment_providers, dispatch_uid="openpos_register_payment_providers")
def openpos_payment_providers(sender, **kwargs):
    # pretix instantiates these itself with the event, so hand back classes.
    return [OpenPosCashProvider, OpenPosCardProvider]


@receiver(event_copy_data, dispatch_uid="openpos_event_copy_data")
def openpos_event_copy_data(sender, other, **kwargs):
    """An event created as a copy keeps the till set up as the original was."""
    from .copying import copy_pos_setup

    copy_pos_setup(sender, other, kwargs)


@receiver(order_canceled, dispatch_uid="openpos_order_canceled")
def openpos_order_canceled(sender, order, **kwargs):
    """
    A till's sale cancelled anywhere but at the till, reversed in the journal.

    pretix sends this at the end of every cancellation, the till's own
    included; that one is journalled by the till itself, with its cashier and
    its key, and is let through here untouched.
    """
    from .backoffice import cancelled_by_a_till, record_cancellation

    if cancelled_by_a_till():
        return
    record_cancellation(order)


@receiver(order_reactivated, dispatch_uid="openpos_order_reactivated")
def openpos_order_reactivated(sender, order, **kwargs):
    """A cancelled till sale brought back in pretix, put back in the journal."""
    from .backoffice import record_reactivation

    record_reactivation(order)


@receiver(nav_event, dispatch_uid="openpos_nav_event")
def openpos_nav_event(sender, request=None, **kwargs):
    """
    The event's two Open POS screens, in the event's own sidebar.

    They used to be declared only as ``navigation_links`` on the plugin, and
    pretix shows those nowhere but in the "Go to" menu of the plugin's card,
    under Settings → Plugins. That is a settings page, and one of the two is the
    journal an organiser opens at the end of every evening, with the drawer
    counted.

    Each link is shown to whoever may open the page behind it, asked with the
    permission that page's own view enforces rather than a copy of it: a link
    that answers 403 is worse than no link, and a copy is how the two would
    drift apart. Somebody who may open neither gets no entry at all.
    """
    url = resolve(request.path_info)
    here = url.namespace == "plugins:pretix_openpos"
    event_kwargs = {"organizer": request.organizer.slug, "event": request.event.slug}
    children = [
        {
            "label": label,
            "url": reverse(f"plugins:pretix_openpos:{name}", kwargs=event_kwargs),
            "active": here and url.url_name == name,
        }
        for label, name, view in (
            (_("Who sells what"), "categories", CategoriesView),
            (_("Sales"), "sales", SalesView),
        )
        if request.user.has_event_permission(
            request.organizer, request.event, view.permission, request=request
        )
    ]
    if not children:
        return []
    return [
        {
            "label": _("Open POS"),
            # A parent with children still needs a page of its own to open;
            # pretix' own menus give it their first child's.
            "url": children[0]["url"],
            "icon": "calculator",
            "children": children,
        }
    ]


@receiver(nav_organizer, dispatch_uid="openpos_nav_organizer_arrivals")
def openpos_nav_organizer(sender, request=None, **kwargs):
    # Registering an event-level plugin on an organizer signal draws a
    # DeprecationWarning at import time; pretix's own banktransfer plugin is in
    # the same boat, and the alternative — declaring the plugin hybrid — would
    # silently disable every event feature until someone also enables it per
    # organizer. Revisit when the base image moves past 2026.x.
    if not request.user.get_events_with_permission(
        "event.orders:read", request=request
    ).filter(organizer=request.organizer).exists():
        return []
    url = resolve(request.path_info)
    here = url.namespace == "plugins:pretix_openpos"
    nav = [
        {
            "label": _("Arrivals"),
            "url": reverse(
                "plugins:pretix_openpos:arrivals",
                kwargs={"organizer": request.organizer.slug},
            ),
            "icon": "line-chart",
            "active": here and url.url_name == "arrivals",
        }
    ]
    # Assigning a role is a device setting, so it is offered to whoever may
    # change devices — the same gate the screen itself enforces. Anyone else
    # simply does not see the entry, rather than finding a 403 behind it.
    if request.user.has_organizer_permission(
        request.organizer, "organizer.devices:write", request=request
    ):
        nav.append(
            {
                "label": _("Till devices"),
                "url": reverse(
                    "plugins:pretix_openpos:devices",
                    kwargs={"organizer": request.organizer.slug},
                ),
                "icon": "tablet",
                "active": here and url.url_name == "devices",
            }
        )
        nav.append(
            {
                "label": _("Card readers"),
                "url": reverse(
                    "plugins:pretix_openpos:sumup",
                    kwargs={"organizer": request.organizer.slug},
                ),
                "icon": "credit-card",
                "active": here and url.url_name == "sumup",
            }
        )
    # Read by whoever keeps the books as well as by whoever sets up the tills,
    # so the entry follows the screen's own gate rather than the devices'.
    if can_read_drawers(request):
        nav.append(
            {
                "label": _("Cash drawers"),
                "url": reverse(
                    "plugins:pretix_openpos:drawers",
                    kwargs={"organizer": request.organizer.slug},
                ),
                "icon": "money",
                "active": here and url.url_name in ("drawers", "drawer", "drawer.session"),
            }
        )
    return nav
