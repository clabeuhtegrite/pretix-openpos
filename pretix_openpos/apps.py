from django.utils.translation import gettext_lazy as _
from pretix.base.plugins import PluginConfig

from . import __version__


class PluginApp(PluginConfig):
    default = True
    name = "pretix_openpos"
    verbose_name = "Open POS"

    class PretixPluginMeta:
        name = _("Open POS")
        author = "clabeuhtegrite"
        category = "FEATURE"
        visible = True
        version = __version__
        # register_sales_channel_types and the SalesChannelType class landed in 2024.7.0.
        compatibility = "pretix>=2024.7.0"
        description = _(
            "Open-source point of sale: sell tickets at the door from a tablet or phone "
            "using a progressive web app, with cash and card payments."
        )
        settings_links = [
            ((_("Open POS"), _("Settings")), "plugins:pretix_openpos:settings", {}),
        ]
        navigation_links = [
            ((_("Open POS"), _("On-site prices")), "plugins:pretix_openpos:prices", {}),
            ((_("Open POS"), _("Sales")), "plugins:pretix_openpos:sales", {}),
        ]

    def ready(self):
        from . import signals  # noqa

    def installed(self, event):
        """
        Called by pretix when the plugin is switched on for an event.

        Till sales are invoiced from the start, because that is what makes a
        cancellation from the till produce a credit note rather than just a
        reversal. It only concerns the Open POS channel — the webshop keeps
        whatever invoicing rules the organiser set for it — and the box that
        controls it sits in the plugin's own settings, one click from off.
        """
        from .invoicing import enable_pos_invoices

        enable_pos_invoices(event)
