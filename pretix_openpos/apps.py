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
