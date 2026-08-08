from django.dispatch import receiver
from pretix.api.signals import register_device_security_profile
from pretix.base.signals import (
    register_payment_providers, register_sales_channel_types,
)

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
