"""
The plugin's own entries in pretix' history, in words.

pretix shows an action it has no display for as its raw identifier —
``pretix_openpos.prices.changed`` on a line of its own, with the data it
carries not shown at all. That is legible to whoever wrote it and to nobody
else, which is the wrong way round: the history is read by the person asking
who moved the beer to four euros, at ten past midnight, with the drawer open.

So every action this plugin writes is registered here, and each one says what
actually changed rather than that something did. The registry is pretix'
current mechanism; the ``logentry_display`` signal next to it is deprecated.

One rule holds throughout: a log entry is read years after it was written, by
which time the item may be renamed and the device gone. Whatever is needed to
read the line is therefore copied into the entry at the time — names, prices,
both sides of a change — and nothing here follows a foreign key to find out
what something is called today.
"""
from decimal import Decimal, InvalidOperation

from django.utils.html import escape, format_html, format_html_join
from django.utils.translation import gettext_lazy as _
from pretix.base.logentrytypes import (
    EventLogEntryType, LogEntryType, NoOpShredderMixin, OrderLogEntryType, log_entry_types,
)
from pretix.base.templatetags.money import money_filter

from .models import PosDevice


def _money(value, currency):
    """A price as the rest of the control panel writes it, or a dash."""
    if value in (None, ""):
        return _("none")
    try:
        return money_filter(Decimal(str(value)), currency)
    except (InvalidOperation, ValueError, TypeError):
        # A log entry is not worth a 500. Whatever was written, show it.
        return str(value)


def _named(line):
    """An item, with its variation, as it was called when this was written."""
    name = line.get("item_name") or _("(deleted product)")
    variation = line.get("variation_name")
    return f"{name} – {variation}" if variation else str(name)


class OpenPosLogEntryType(NoOpShredderMixin, LogEntryType):
    """
    Nothing this plugin logs is personal data.

    The entries carry product names, prices, device names and reader ids. The
    one field that names a person — the cashier — is on the journal, which is
    append-only by design and deliberately not a log entry.
    """


@log_entry_types.new()
class PricesChanged(NoOpShredderMixin, EventLogEntryType):
    """The on-site price list, line by line."""

    action_type = "pretix_openpos.prices.changed"

    def display(self, logentry, data):
        currency = logentry.event.currency
        changed = data.get("changed")
        # Entries written before this became a list say only how many rows
        # moved. Nothing can recover the detail now, so say the true thing
        # rather than "?" — these are real rows in real installations.
        if not isinstance(changed, list):
            return _("The on-site prices were changed ({count} products).").format(
                count=changed if changed is not None else "?"
            )
        if not changed:
            return _("The on-site prices were saved with nothing changed.")
        return format_html(
            "{}<ul>{}</ul>",
            _("The on-site prices were changed:"),
            format_html_join(
                "", "<li>{}</li>",
                ((self._line(row, currency),) for row in changed),
            ),
        )

    @staticmethod
    def _line(row, currency):
        name = escape(_named(row))
        before, after = row.get("from"), row.get("to")
        if before in (None, "") and after not in (None, ""):
            # No on-site price before: the item sold at its webshop price.
            return format_html(
                _('{item}: {price} on site, where the normal price was charged before'),
                item=name, price=_money(after, currency),
            )
        if after in (None, ""):
            return format_html(
                _('{item}: the on-site price of {price} was removed, so the normal '
                  'price applies again'),
                item=name, price=_money(before, currency),
            )
        return format_html(
            _("{item}: {before} → {after}"),
            item=name,
            before=_money(before, currency),
            after=_money(after, currency),
        )


@log_entry_types.new()
class DevicesChanged(OpenPosLogEntryType):
    """Which tablet is a till, which is a door, and which reader it drives."""

    action_type = "pretix_openpos.devices.changed"

    ROLES = {
        PosDevice.ROLE_UNSET: _("no role"),
        PosDevice.ROLE_TILL: _("till"),
        PosDevice.ROLE_DOOR: _("door"),
    }

    def display(self, logentry, data):
        changed = data.get("changed")
        if not isinstance(changed, list):
            return _("Till roles were changed ({count} devices).").format(
                count=changed if changed is not None else "?"
            )
        if not changed:
            return _("Till roles were saved with nothing changed.")
        return format_html(
            "{}<ul>{}</ul>",
            _("Till roles were changed:"),
            format_html_join(
                "", "<li>{}</li>", ((self._line(row),) for row in changed)
            ),
        )

    def _line(self, row):
        name = escape(row.get("device_name") or _("(deleted device)"))
        parts = []
        if row.get("role") != row.get("role_before"):
            parts.append(
                format_html(
                    _("{before} → {after}"),
                    before=self.ROLES.get(row.get("role_before"), "?"),
                    after=self.ROLES.get(row.get("role"), "?"),
                )
            )
        if row.get("reader") != row.get("reader_before"):
            parts.append(self._reader(row.get("reader_before"), row.get("reader")))
        if not parts:
            return name
        return format_html("{}: {}", name, format_html_join(", ", "{}", ((p,) for p in parts)))

    @staticmethod
    def _reader(before, after):
        if not before:
            return format_html(_("card reader {reader}"), reader=escape(after))
        if not after:
            return format_html(
                _("card reader {reader} taken away"), reader=escape(before)
            )
        return format_html(
            _("card reader {before} → {after}"),
            before=escape(before), after=escape(after),
        )


@log_entry_types.new_from_dict({
    "pretix_openpos.sumup.reader.paired": _("A card reader was paired: {reader}"),
    "pretix_openpos.sumup.reader.forgotten": _("A card reader was removed: {reader}"),
    "pretix_openpos.sumup.reader.freed": _(
        "A card reader was asked to clear its screen: {reader}. Whether the card had "
        "already been charged is not known from this — only SumUp knows that."
    ),
})
class ReaderLogEntryType(OpenPosLogEntryType):
    pass


@log_entry_types.new()
class SumUpSettingsChanged(OpenPosLogEntryType):
    """
    The account, never its key.

    Only the names of the fields that moved are recorded, which is the whole
    reason the settings view does not use pretix' own — that one writes each
    changed field's *value* into the log, and one of these fields is an API key.
    """

    action_type = "pretix_openpos.sumup.settings"

    FIELDS = {
        "openpos_sumup_merchant_code": _("merchant code"),
        "openpos_sumup_api_key": _("API key"),
    }

    def display(self, logentry, data):
        changed = data.get("changed") or []
        names = [str(self.FIELDS.get(field, field)) for field in changed]
        if not names:
            return _("The SumUp account settings were saved with nothing changed.")
        return _("The SumUp account was changed: {fields}. The key itself is never "
                 "written to this history.").format(fields=", ".join(names))


@log_entry_types.new()
class SoldOffTariff(NoOpShredderMixin, OrderLogEntryType):
    """
    A sale replayed at a price that had since moved.

    The one entry here that is not somebody pressing a button: it is written
    when a till hands over a sale it rang up offline, priced from the tariff it
    had cached, and that tariff has changed in the meantime. The order is
    created at what was actually charged — anything else would invoice a sum
    nobody handed over — so this line is the only record that the two ever
    disagreed, and the amount is real money that is in the drawer and not in
    the price list.
    """

    action_type = "pretix_openpos.order.off_tariff"

    def display(self, logentry, data):
        currency = logentry.event.currency
        lines = data.get("lines") or []
        return format_html(
            "{}<ul>{}</ul>",
            _("Rung up offline at a price that had changed since:"),
            format_html_join(
                "", "<li>{}</li>",
                (
                    (
                        format_html(
                            _("{item}: charged {charged}, the price list said {tariff}"),
                            item=escape(_named(line)),
                            charged=_money(line.get("charged"), currency),
                            tariff=_money(line.get("tariff"), currency),
                        ),
                    )
                    for line in lines
                ),
            ),
        )
