"""
The plugin's own entries in pretix' history, in words.

pretix shows an action it has no display for as its raw identifier —
``pretix_openpos.prices.changed`` on a line of its own, with the data it
carries not shown at all. That is legible to whoever wrote it and to nobody
else, which is the wrong way round: the history is read by the person asking
who moved the beer to four euros, at ten past midnight, with the drawer open.

So every action this plugin writes is described here, and each one says what
actually changed rather than that something did.

They reach pretix by one of two roads, and which one is decided by where the
entry is written rather than by taste:

- **On an event or an order**, through ``log_entry_types``, pretix' current
  registry.
- **On the organizer** — the till roles and the SumUp account, which belong to
  the association rather than to one evening — through the ``logentry_display``
  signal, which pretix documents as deprecated for new types. The registry
  cannot take these. For every entry it knows, the organizer's history page asks
  whether the plugin that registered it is active *on that organizer*, and an
  event-level plugin like this one cannot be asked that: pretix raises
  ``ImproperlyConfigured`` and the whole page is a 500 for as long as one such
  entry is on it. That is what 0.12.0 to 0.15.1 did to the history of every
  organizer that had saved the till devices screen or set up a card reader. See
  ``describe_organizer_entry`` at the bottom for why the signal gets past that.

One rule holds throughout: a log entry is read years after it was written, by
which time the item may be renamed and the device gone. Whatever is needed to
read the line is therefore copied into the entry at the time — names, prices,
both sides of a change — and nothing here follows a foreign key to find out
what something is called today.
"""
from decimal import Decimal, InvalidOperation

from django.dispatch import receiver
from django.utils.html import escape, format_html, format_html_join
from django.utils.translation import gettext_lazy as _
from pretix.base.logentrytypes import (
    EventLogEntryType, LogEntryType, NoOpShredderMixin, OrderLogEntryType, log_entry_types,
)
from pretix.base.signals import logentry_display
from pretix.base.templatetags.money import money_filter

from .models import PosCategory, PosDevice


def _money(value, currency):
    """A price as the rest of the control panel writes it, or a dash."""
    if value in (None, ""):
        return _("none")
    try:
        return money_filter(Decimal(str(value)), currency)
    except (InvalidOperation, ValueError, TypeError):
        # A log entry is not worth a 500. Whatever was written, show it.
        return str(value)


def _amount(value):
    """A stored amount as a number, so "100" and "100.00" compare equal."""
    try:
        return None if value in (None, "") else Decimal(str(value))
    except (InvalidOperation, ValueError):
        return value


def _named(line):
    """An item, with its variation, as it was called when this was written."""
    name = line.get("item_name") or _("(deleted product)")
    variation = line.get("variation_name")
    return f"{name} – {variation}" if variation else str(name)


class OrganizerEntryTypes(dict):
    """
    The organizer-level entries, by action type: a registry of the plugin's own.

    Kept out of pretix' for the reason given at the top of this module, and
    given the same two decorators, so that each class below reads as it would
    if it were registered there — and so that moving one back, the day pretix
    can take it, is a one-word change.
    """

    def new(self):
        def register(cls):
            entry_type = cls()
            self[entry_type.action_type] = entry_type
            return cls

        return register

    def new_from_dict(self, data):
        def register(cls):
            for action_type, plain in data.items():
                self[action_type] = cls(action_type=action_type, plain=plain)
            return cls

        return register


organizer_entry_types = OrganizerEntryTypes()


class OrganizerLogEntryType(NoOpShredderMixin, LogEntryType):
    """
    An entry written on the organizer, and none of it personal data.

    The entries carry device names, reader ids and the names of settings. The
    one field that names a person — the cashier — is on the journal, which is
    append-only by design and deliberately not a log entry.
    """


@log_entry_types.new()
class PricesChanged(NoOpShredderMixin, EventLogEntryType):
    """
    The on-site price list, line by line.

    The price list itself is gone — a product is worth what pretix says it is
    worth, at the door as in the shop — but these entries are not. They are in
    the database of every installation that ran an earlier version, they are the
    only remaining record of what a till charged before the change, and dropping
    this class would turn each of them back into a raw action type with its
    contents not shown. So it stays, and it is the one thing here that describes
    a feature that no longer exists.
    """

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
class PricesRemoved(NoOpShredderMixin, EventLogEntryType):
    """
    The upgrade that took the price list away, and what it cost.

    Written once per event by migration ``0008``, from inside the migration,
    just before the table is dropped. It is the only copy of those rows that
    survives, and the question it exists to answer is a narrow one: *did
    anything I sell change price when I deployed this?*

    So it leads with the products that changed and counts the rest. A list of
    forty products that stayed put is not an answer, it is a haystack.
    """

    action_type = "pretix_openpos.prices.removed"

    def display(self, logentry, data):
        currency = logentry.event.currency
        removed = data.get("removed") or []
        moved = [row for row in removed if row.get("changes")]
        if not moved:
            return _(
                "The on-site price list was removed ({count} products). None of "
                "them changed price: each was already worth its pretix price."
            ).format(count=len(removed))
        rest = len(removed) - len(moved)
        heading = _(
            "The on-site price list was removed, and {count} product(s) changed "
            "price at the till because of it:"
        ).format(count=len(moved))
        tail = (
            ""
            if not rest
            else _(" The other {count} were already worth their pretix price.").format(
                count=rest
            )
        )
        return format_html(
            "{}<ul>{}</ul>{}",
            heading,
            format_html_join(
                "", "<li>{}</li>",
                ((self._line(row, currency),) for row in moved),
            ),
            tail,
        )

    @staticmethod
    def _line(row, currency):
        return format_html(
            _("{item}: {before} at the till, now {after}"),
            item=escape(_named(row)),
            before=_money(row.get("from"), currency),
            after=_money(row.get("to"), currency),
        )


@log_entry_types.new()
class CategoriesChanged(NoOpShredderMixin, EventLogEntryType):
    """Which categories were reserved for the bar, and which for the door."""

    action_type = "pretix_openpos.categories.changed"

    ROLES = {
        PosCategory.ROLE_ALL: _("every till"),
        PosDevice.ROLE_TILL: _("the bar till only"),
        PosDevice.ROLE_DOOR: _("the door only"),
    }

    def display(self, logentry, data):
        # No "written before this carried a list" branch, unlike the two
        # entries above: this action type is new, so every entry that exists
        # was written by the view below it.
        changed = data.get("changed") or []
        if not changed:
            return _("Who sells what was saved with nothing changed.")
        return format_html(
            "{}<ul>{}</ul>",
            _("Who sells what was changed:"),
            format_html_join(
                "", "<li>{}</li>", ((self._line(row),) for row in changed)
            ),
        )

    def _line(self, row):
        return format_html(
            _("{category}: {before} → {after}"),
            category=escape(row.get("category_name") or _("(deleted category)")),
            before=self.ROLES.get(row.get("role_before"), "?"),
            after=self.ROLES.get(row.get("role"), "?"),
        )


@organizer_entry_types.new()
class DevicesChanged(OrganizerLogEntryType):
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
        # Entries written before drawers existed carry neither key, and read
        # as they always did.
        if row.get("drawer", "") != row.get("drawer_before", ""):
            parts.append(self._drawer(row.get("drawer_before"), row.get("drawer")))
        if not parts:
            return name
        # The colon inside the translated string, like every other line here:
        # French sets a space before it.
        return format_html(
            _("{device}: {changes}"),
            device=name,
            changes=format_html_join(", ", "{}", ((p,) for p in parts)),
        )

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

    @staticmethod
    def _drawer(before, after):
        if not before:
            return format_html(_("cash drawer {drawer}"), drawer=escape(after))
        if not after:
            return format_html(
                _("cash drawer {drawer} taken away"), drawer=escape(before)
            )
        return format_html(
            _("cash drawer {before} → {after}"),
            before=escape(before), after=escape(after),
        )


@organizer_entry_types.new()
class DrawerCreated(OrganizerLogEntryType):
    action_type = "pretix_openpos.drawer.created"

    def display(self, logentry, data):
        if data.get("opening_float") is None:
            return _("A cash drawer was created: {name}.").format(name=data.get("name") or "?")
        return _("A cash drawer was created: {name}, usual float {amount}.").format(
            name=data.get("name") or "?",
            amount=_money(data.get("opening_float"), data.get("currency") or ""),
        )


@organizer_entry_types.new()
class DrawerChanged(OrganizerLogEntryType):
    action_type = "pretix_openpos.drawer.changed"

    def display(self, logentry, data):
        currency = data.get("currency") or ""
        parts = []
        if data.get("name") != data.get("name_before"):
            parts.append(
                _("renamed from {before}").format(before=data.get("name_before") or "?")
            )
        if _amount(data.get("opening_float")) != _amount(data.get("opening_float_before")):
            parts.append(
                _("usual float {before} → {after}").format(
                    before=_money(data.get("opening_float_before"), currency),
                    after=_money(data.get("opening_float"), currency),
                )
            )
        return _("The cash drawer {name} was changed: {changes}.").format(
            name=data.get("name") or "?",
            changes=", ".join(str(part) for part in parts) or _("nothing"),
        )


@organizer_entry_types.new()
class DrawerDeleted(OrganizerLogEntryType):
    action_type = "pretix_openpos.drawer.deleted"

    def display(self, logentry, data):
        devices = data.get("devices") or []
        if not devices:
            return _("The cash drawer {name} was deleted.").format(name=data.get("name") or "?")
        return _("The cash drawer {name} was deleted, and taken away from {devices}.").format(
            name=data.get("name") or "?", devices=", ".join(devices)
        )


@organizer_entry_types.new()
class DrawerArchived(OrganizerLogEntryType):
    action_type = "pretix_openpos.drawer.archived"

    def display(self, logentry, data):
        devices = data.get("devices") or []
        if not devices:
            return _("The cash drawer {name} was archived.").format(name=data.get("name") or "?")
        return _("The cash drawer {name} was archived, and taken away from {devices}.").format(
            name=data.get("name") or "?", devices=", ".join(devices)
        )


@organizer_entry_types.new()
class DrawerRestored(OrganizerLogEntryType):
    action_type = "pretix_openpos.drawer.restored"

    def display(self, logentry, data):
        return _("The cash drawer {name} was brought back from the archive.").format(
            name=data.get("name") or "?"
        )


@organizer_entry_types.new()
class DrawerClosed(OrganizerLogEntryType):
    """A drawer a till left open, closed from the back office."""

    action_type = "pretix_openpos.drawer.closed"

    def display(self, logentry, data):
        currency = data.get("currency") or ""
        if data.get("amount") is None:
            text = _("The cash drawer {name} was closed from the back office, without a "
                     "count. It should have held {expected}.").format(
                name=data.get("name") or "?",
                expected=_money(data.get("expected"), currency),
            )
        else:
            text = _("The cash drawer {name} was closed from the back office on a count of "
                     "{amount}. It should have held {expected}.").format(
                name=data.get("name") or "?",
                amount=_money(data.get("amount"), currency),
                expected=_money(data.get("expected"), currency),
            )
        if data.get("reason"):
            return format_html("{} <em>{}</em>", text, data["reason"])
        return text


@organizer_entry_types.new_from_dict({
    "pretix_openpos.sumup.reader.paired": _("A card reader was paired: {reader}"),
    "pretix_openpos.sumup.reader.forgotten": _("A card reader was removed: {reader}"),
    "pretix_openpos.sumup.reader.freed": _(
        "A card reader was asked to clear its screen: {reader}. Whether the card had "
        "already been charged is not known from this — only SumUp knows that."
    ),
})
class ReaderLogEntryType(OrganizerLogEntryType):
    pass


@organizer_entry_types.new()
class SumUpSettingsChanged(OrganizerLogEntryType):
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


@log_entry_types.new()
class SoldOutsideRole(NoOpShredderMixin, OrderLogEntryType):
    """
    A till that replayed a sale from outside the categories its role covers.

    Never written for a sale rung up live — that one is refused at the
    checkout, before anything is taken. This is the other case: a till that was
    cut off sold something, the customer paid, and by the time the sale reaches
    the server its category has been reserved for the other role. The sale is
    recorded, because refusing would leave the money in the drawer with nothing
    to point at, and this line is the only place it is ever said.

    The ordinary reading is dull: a tablet that sold beer before anybody gave
    it the door's role. It is worth writing down anyway, because the dull
    reading and the interesting one look identical from here, and only the
    organiser can tell them apart.
    """

    action_type = "pretix_openpos.order.off_role"

    def display(self, logentry, data):
        lines = data.get("lines") or []
        device = data.get("device")
        heading = (
            _("Replayed by {device}, from outside what that till sells:").format(
                device=device
            )
            if device
            else _("Replayed from outside what that till sells:")
        )
        return format_html(
            "{}<ul>{}</ul>",
            heading,
            format_html_join(
                "", "<li>{}</li>",
                (
                    (
                        format_html(
                            _("{count}× {item}, in {category}"),
                            count=line.get("count", "?"),
                            item=escape(_named(line)),
                            category=escape(
                                line.get("category_name") or _("no category")
                            ),
                        ),
                    )
                    for line in lines
                ),
            ),
        )


def _journal_rows(data, currency):
    """The journal rows an entry names, one per line, as the Sales page lists them."""
    return format_html_join(
        "", "<li>{}</li>",
        (
            (
                format_html(
                    _("#{seq}, reversing #{target}: {total}"),
                    seq=row.get("seq", "?"),
                    target=row.get("cancels_seq", "?"),
                    total=_money(row.get("total"), currency),
                ),
            )
            for row in data.get("rows") or []
        ),
    )


@log_entry_types.new()
class JournalCancelled(NoOpShredderMixin, OrderLogEntryType):
    """
    A till's sale that pretix cancelled, reversed in the till journal.

    Written when the order is cancelled anywhere but at the till — the order
    page, the REST API, a whole event cancelled — or later, from the Sales
    page, for one cancelled before Open POS listened for it.
    """

    action_type = "pretix_openpos.order.journal.cancelled"

    def display(self, logentry, data):
        heading = (
            _("Cancelled earlier in pretix, and written to the till journal only now:")
            if data.get("late")
            else _("Written to the till journal, so the takings no longer count this sale:")
        )
        return format_html(
            "{}<ul>{}</ul>", heading, _journal_rows(data, logentry.event.currency)
        )


@log_entry_types.new()
class JournalRefunded(NoOpShredderMixin, OrderLogEntryType):
    """
    A till's card sale refunded from pretix, reversed at the refund.

    Seen when no cancellation reversed it first: pretix' refund dialog marks
    the order pending by default, or does nothing to it, and its "Cancel the
    order" cancels only once the money has gone back. Either way the card has
    its money, so the takings stop counting the sale.
    """

    action_type = "pretix_openpos.order.journal.refunded"

    def display(self, logentry, data):
        return format_html(
            "{}<ul>{}</ul>",
            _("Refunded to the card from pretix, and written to the till journal, so "
              "the takings no longer count this sale:"),
            _journal_rows(data, logentry.event.currency),
        )


@log_entry_types.new()
class JournalReactivated(NoOpShredderMixin, OrderLogEntryType):
    """A reactivated till sale, counted in the takings again."""

    action_type = "pretix_openpos.order.journal.reactivated"

    def display(self, logentry, data):
        return format_html(
            "{}<ul>{}</ul>",
            _("Back in the till journal: the order came back paid, so the cancellation "
              "is undone."),
            _journal_rows(data, logentry.event.currency),
        )


@log_entry_types.new()
class JournalNotRestored(NoOpShredderMixin, OrderLogEntryType):
    """
    A till sale reactivated after its money went back, left out of the takings.

    pretix brings such an order back as pending: the customer holds the money
    again. The till journal records what the drawer and the card did, and they
    gave it back — so the cancellation stands there, and this says why the two
    now disagree on purpose.
    """

    action_type = "pretix_openpos.order.journal.not_restored"

    def display(self, logentry, data):
        return _("Reactivated after the money was paid back, so the till journal keeps "
                 "this sale cancelled. If the customer pays again, that payment is not a "
                 "till sale and is not counted in the till takings.")


@log_entry_types.new()
class JournalFailed(NoOpShredderMixin, OrderLogEntryType):
    """pretix changed the order, and the till journal could not follow."""

    action_type = "pretix_openpos.order.journal.failed"

    def display(self, logentry, data):
        if data.get("action") == "reactivation":
            return _("The reactivation could not be written to the till journal. The "
                     "server log has the details.")
        if data.get("action") == "refund":
            return _("The card refund could not be written to the till journal, which "
                     "still counts this sale. The server log has the details.")
        return _("The cancellation could not be written to the till journal. The Open POS "
                 "Sales page lists this sale until it is.")


@log_entry_types.new()
class RefundPending(NoOpShredderMixin, OrderLogEntryType):
    """A card refund SumUp would not take yet, left waiting and asked for again."""

    action_type = "pretix_openpos.order.refund.pending"

    def display(self, logentry, data):
        return _("SumUp did not take the card refund yet, so Open POS asks again on its "
                 "own until it does. SumUp answered: {answer}").format(
            answer=data.get("answer") or "—"
        )


@log_entry_types.new()
class RefundAccepted(NoOpShredderMixin, OrderLogEntryType):
    """A waiting card refund SumUp took on a later try."""

    action_type = "pretix_openpos.order.refund.accepted"

    def display(self, logentry, data):
        return _("SumUp took the card refund on a later try.")


@log_entry_types.new()
class RefundGaveUp(NoOpShredderMixin, OrderLogEntryType):
    """A waiting card refund SumUp kept refusing, failed for a person to look at."""

    action_type = "pretix_openpos.order.refund.gave_up"

    def display(self, logentry, data):
        return _("SumUp still refused the card refund, so Open POS stopped asking. Refund "
                 "it from the SumUp dashboard or with “Create a refund”. SumUp answered: "
                 "{answer}").format(answer=data.get("answer") or "—")


@log_entry_types.new()
class GivenBackInSumUp(NoOpShredderMixin, OrderLogEntryType):
    """
    A card payment given back in SumUp — its dashboard, its app — brought into pretix.

    Says what SumUp reported, then what Open POS did about it: the two are
    read together by whoever wonders why an order nobody touched in pretix
    was cancelled overnight.
    """

    action_type = "pretix_openpos.order.sumup.given_back"

    def display(self, logentry, data):
        amount = _money(data.get("amount"), logentry.event.currency)
        transaction = data.get("transaction_id") or "—"
        if data.get("status") == "CANCELLED":
            reported = _("Card payment {transaction} was cancelled in SumUp ({amount}).")
        else:
            reported = _("Card payment {transaction} was refunded in SumUp ({amount}).")
        if not data.get("whole"):
            done = _("Open POS recorded it as a refund made outside pretix: process it on "
                     "this order to say what becomes of the order.")
        elif data.get("cancelled"):
            done = _("Open POS cancelled the order and recorded the refund.")
        elif data.get("cancel_failed"):
            done = _("Open POS recorded the refund but could not cancel the order: process "
                     "the refund on this order.")
        elif data.get("confirmed") and not data.get("external"):
            done = _("The refund that was waiting for SumUp is done.")
        elif data.get("already"):
            done = _("pretix already had this refund recorded, so nothing was added.")
        else:
            done = _("Open POS recorded the refund.")
        return "{} {}".format(
            reported.format(transaction=transaction, amount=amount), done
        )


@receiver(logentry_display, dispatch_uid="openpos_organizer_logentry_display")
def describe_organizer_entry(sender, logentry, **kwargs):
    """
    The organizer-level entries above, in words, by the deprecated road.

    pretix sends this signal for an entry its registry does not know, with the
    entry's event as the sender — and an entry written on the organizer has
    none. A plugin signal sent with no sender goes to every receiver without
    asking whether its plugin is active anywhere, so nothing is checked against
    the organizer and nothing raises. The page's other question, which object
    the entry is about, takes the same detour: an unregistered entry falls
    through to its ``content_object`` and the ``logentry_object_link`` signal,
    which this plugin does not answer, and pretix leaves that column empty
    rather than failing.

    Deprecated is not gone. pretix 2026.7 still sends it, from
    ``LogEntry.display``, for exactly this case. Should it ever stop, these
    entries would read as their raw action type again — ugly rather than
    broken — and the classes above could move to ``log_entry_types`` as soon as
    pretix can check this plugin against an organizer.
    """
    entry_type = organizer_entry_types.get(logentry.action_type)
    if entry_type is not None:
        return entry_type.display(logentry, logentry.parsed_data)
