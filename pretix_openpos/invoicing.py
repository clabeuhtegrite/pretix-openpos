"""
Whether a till sale gets an invoice.

Kept in one place because two questions hang on it and they are easy to confuse.

pretix decides invoicing per event, through ``invoice_generate`` — off, on
demand, by hand from the back office, at order placement, or on payment — and
per sales channel, through ``invoice_generate_sales_channels``, whose default
lists the webshop alone. An event set to "by hand" is a perfectly sensible
choice for a webshop and a useless one for a till: nobody is going to open the
back office for every beer sold at a door.

So the plugin answers for its own channel and only for it. The switch below
means "a till sale is invoiced", whatever the event does elsewhere — and it is
on unless someone turns it off, because a cancellation from the till is supposed
to produce a credit note, and there is no credit note without an invoice.
"""
from .channels import POS_CHANNEL

#: Event setting holding the switch. Absent means on: see the module docstring.
SETTING = "openpos_invoices"


def pos_invoices_enabled(event) -> bool:
    return event.settings.get(SETTING, as_type=bool, default=True)


def set_pos_invoices(event, enabled: bool) -> None:
    """
    Flip the switch, and keep pretix' own channel list in step with it.

    The list matters for everything pretix does with invoices outside this
    plugin — regenerating one from the back office, deciding whether an order is
    invoiceable at all — so leaving it behind would produce an event that half
    agrees with itself. Every other channel is left exactly as the organiser set
    it.
    """
    event.settings.set(SETTING, enabled)

    channels = event.settings.get("invoice_generate_sales_channels", as_type=list) or ["web"]
    channels = [c for c in channels if c != POS_CHANNEL]
    if enabled:
        channels.append(POS_CHANNEL)
    event.settings.set("invoice_generate_sales_channels", channels)


def enable_pos_invoices(event) -> None:
    """Used when the plugin is switched on for an event."""
    set_pos_invoices(event, True)
