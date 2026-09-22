from django.utils.translation import gettext_lazy as _
from pretix.base.channels import SalesChannelType

#: Identifier of the sales channel created for every organizer. Products have to
#: be explicitly enabled for this channel to become sellable at the till, which
#: is the native pretix way of separating the on-site catalogue from the webshop.
POS_CHANNEL = "openpos"


class PosSalesChannelType(SalesChannelType):
    identifier = POS_CHANNEL
    verbose_name = _("Open POS")
    description = _("On-site sales made at the till through the Open POS cash register.")
    icon = "shopping-cart"

    #: Create the channel for every organizer so the "available on Open POS"
    #: checkbox shows up on products without any manual setup.
    default_created = True

    #: One till channel per organizer. Splitting sales per stand is a reporting
    #: concern and is handled through the device the sale was made on instead.
    multiple_allowed = False

    #: Payment at the till is settled in cash or on a standalone card terminal
    #: before the order is even created, so the organizer restricting payment
    #: providers per channel would have no effect here.
    payment_restrictions_supported = False

    #: A till operator regularly sells more items in one go than a webshop
    #: customer is allowed to.
    unlimited_items_per_order = True

    #: Nobody logs into a customer account while queueing at the door.
    customer_accounts_supported = False

    #: Automatic discounts are driven by webshop-oriented rules — a basket
    #: total, a customer account, a time window — none of which a queue at the
    #: door has. A price that differs at the till is a product of its own,
    #: limited to this channel.
    discounts_supported = False

    testmode_supported = True

    #: Hide the channel entirely on events that do not run the POS.
    required_event_plugin = "pretix_openpos"
