from django.dispatch import receiver
from django.urls import resolve, reverse
from django.utils.translation import gettext_lazy as _
from pretix.api.signals import register_device_security_profile
from pretix.base.signals import (
    register_payment_providers, register_sales_channel_types,
)
from pretix.control.signals import nav_organizer

from .channels import PosSalesChannelType
from .payment import OpenPosCardProvider, OpenPosCashProvider
from .security import OpenPosSecurityProfile


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
    return [
        {
            "label": _("Arrivals"),
            "url": reverse(
                "plugins:pretix_openpos:arrivals",
                kwargs={"organizer": request.organizer.slug},
            ),
            "icon": "line-chart",
            "active": (
                url.namespace == "plugins:pretix_openpos"
                and url.url_name == "arrivals"
            ),
        }
    ]
