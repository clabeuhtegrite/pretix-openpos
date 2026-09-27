"""
Which association invoices which money.

An evening run by several associations is several sellers, and the seller of a
sale is whoever received its money: an invoice goes out in the name of the one
whose account the payment landed in. So the settings here all answer the same
question — whose is this account? — for the three places money arrives:

- **The webshop**: the tickets bought online are paid through the event's
  payment provider (Stripe, most of the time), into one association's account.
  Said per event, since the payment provider is set up per event, and a copied
  event keeps it.
- **The SumUp account**: every card a reader takes lands in it, whatever the
  event. Said on the organizer, like the account itself.
- **A drawer**: the cash that goes into it goes home with whoever keeps it. Said
  on the drawer (:attr:`~pretix_openpos.models.PosDrawer.held_by`).

How the invoice then gets that association's name and number is
:mod:`pretix_openpos.issuers`.

Every reference is an id stored as a setting, so each is read back through
:func:`association_named`, which only ever returns an association of the same
organizer. An event copied from another organizer's, or a setting naming a row
that is gone, reads as "nobody has said" rather than as someone else's.
"""
from django.core.validators import RegexValidator
from django.utils.functional import lazy
from django.utils.translation import gettext_lazy as _, ngettext

from .models import PosAssociation

#: Event setting: the association the webshop's payments are made to, and so
#: the one that invoices every order that did not come from a till. Named for
#: what 0.26.0 used it for — whose account the online payments land in — which
#: is the same fact.
ONLINE_SETTING = "openpos_online_holder"

#: Organizer setting: the association the SumUp account belongs to, and so the
#: one that invoices every card taken on site.
SUMUP_HOLDER_SETTING = "openpos_sumup_holder"

#: Event setting: what goes between an association's prefix and the number, on
#: this event's invoices only — which starts the event on a series of its own,
#: from 1, rather than following on from the one before. Empty is the usual
#: case: an association's numbers run on from one evening to the next.
SERIES_SETTING = "openpos_invoice_series"

#: Every event setting that names an association.
EVENT_SETTINGS = (ONLINE_SETTING,)

#: pretix' own rule for an invoice number prefix, applied to ours: the prefix
#: ends up in the same column, and in the name of every PDF. Not pretix' own
#: message, whose French reads oddly and would win over ours.
prefix_validator = RegexValidator(
    regex="^[a-zA-Z0-9-_%./,&:# ]+$",
    message=lazy(
        lambda: _("Use only the characters {allowed} here.").format(
            allowed="A-Z, a-z, 0-9, -./:#"
        ),
        str,
    )(),
)


def association_named(organizer, value):
    """
    The association of ``organizer`` whose id ``value`` is, or ``None``.

    ``value`` is whatever a setting or a form holds: a string, most of the
    time, and anything at all after a hand-made request.
    """
    try:
        pk = int(value)
    except (TypeError, ValueError):
        return None
    return PosAssociation.objects.filter(organizer=organizer, pk=pk).first()


def online_invoicer(event):
    """The association that invoices the webshop's orders of ``event``, or ``None``."""
    return association_named(event.organizer, event.settings.get(ONLINE_SETTING))


def sumup_holder(organizer):
    """The association the SumUp account belongs to, or ``None`` when nobody said."""
    return association_named(organizer, organizer.settings.get(SUMUP_HOLDER_SETTING))


def event_series(event):
    """What this event puts between an association's prefix and its numbers."""
    return (event.settings.get(SERIES_SETTING) or "").strip()


def set_setting(settings, key, association):
    """Store ``association`` under ``key``, or forget the key for ``None``."""
    if association is None:
        settings.delete(key)
    else:
        settings.set(key, str(association.pk))


def uses(association):
    """
    Everything that still names ``association``, as sentences for a person.

    Empty when it can go. Asked before deleting one, and said back when the
    answer is no: an invoice cannot lose its seller, and a setting that named
    a deleted association would quietly send its sales back to the event.
    """
    from pretix.base.models.event import Event_SettingsStore

    found = []
    issued = association.invoices.count()
    if issued:
        found.append(
            ngettext(
                "It has issued {count} invoice, which names it.",
                "It has issued {count} invoices, which name it.",
                issued,
            ).format(count=issued)
        )
    organizer = association.organizer
    if organizer.settings.get(SUMUP_HOLDER_SETTING) == str(association.pk):
        found.append(_("It invoices the cards taken on the SumUp account."))
    drawers = sorted(drawer.name for drawer in association.drawers.all())
    if drawers:
        found.append(
            _("It invoices the cash of: {drawers}.").format(drawers=", ".join(drawers))
        )
    events = sorted(
        {
            str(row.object.name)
            for row in Event_SettingsStore.objects.filter(
                object__organizer=organizer,
                key__in=EVENT_SETTINGS,
                value=str(association.pk),
            ).select_related("object")
        }
    )
    if events:
        found.append(
            _("It invoices the online ticketing of: {events}.").format(events=", ".join(events))
        )
    return found
