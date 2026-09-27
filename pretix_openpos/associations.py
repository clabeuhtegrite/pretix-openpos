"""
Which association counts which part of an evening, and who holds its money.

An evening here has three parts, and they are the three an organiser names
when several associations run it together: the tickets sold online, the
tickets sold at the door, and the bar. Each may belong to a different
association, which keeps its own books, and the question this module answers
for the statements (:mod:`pretix_openpos.statements`) is the plain one: whose
is this euro, and who is holding it?

What belongs to whom is said per event, one association per part, in the
event's settings: it is a fact about the evening, and a copied event keeps it.
A till's sale is sorted into the door or the bar by what *Who sells what*
already says — a category reserved for the bar is the bar's — so a night that
was set up for the two counters needs nothing more than the three names.

Who holds the money is said where the money is: the SumUp account's, on the
organizer, since it is one account whatever the event; a drawer's cash, on the
drawer. Money nobody has said anything about is counted as held by the
association it belongs to, which is to say nobody owes anybody for it.

Every reference is an id stored as a setting, so each is read back through
:func:`association_named`, which only ever returns an association of the same
organizer. An event copied from another organizer's, or a setting naming a
row that is gone, reads as "nobody has said" rather than as someone else's.
"""
from django.utils.translation import gettext_lazy as _

from .models import PosAssociation, PosDevice

#: The tickets and whatever else the webshop sells: every order that did not
#: come from a till.
PART_ONLINE = "online"
#: Sold at the door: the categories reserved for the door, and what a door
#: device sold that nothing else claims.
PART_DOOR = PosDevice.ROLE_DOOR
#: Sold at the bar, the same way round.
PART_BAR = PosDevice.ROLE_TILL

#: In the order a statement lists them: the evening as the public meets it.
PARTS = (PART_ONLINE, PART_DOOR, PART_BAR)

PART_LABELS = {
    PART_ONLINE: _("Online sales"),
    PART_DOOR: _("Door"),
    PART_BAR: _("Bar"),
}

#: The event setting holding, for each part, the id of the association it
#: belongs to. Spelled out rather than built from the part: the bar's part is
#: the till role's ``pos``, which is no name for a setting.
SHARE_SETTINGS = {
    PART_ONLINE: "openpos_share_online",
    PART_DOOR: "openpos_share_door",
    PART_BAR: "openpos_share_bar",
}

#: Event setting: the association whose account the webshop's payments land
#: in, when it is not the one the online sales belong to.
ONLINE_HOLDER_SETTING = "openpos_online_holder"

#: Organizer setting: the association the SumUp account belongs to, and so the
#: one holding every card payment a reader took.
SUMUP_HOLDER_SETTING = "openpos_sumup_holder"

#: Every event setting that names an association.
EVENT_SETTINGS = (*SHARE_SETTINGS.values(), ONLINE_HOLDER_SETTING)


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


def shares(event):
    """
    ``{part: association or None}`` for the three parts of ``event``.

    One query whatever is set, since every screen that asks wants all three.
    """
    ids = {}
    for part, key in SHARE_SETTINGS.items():
        try:
            ids[part] = int(event.settings.get(key) or "")
        except ValueError:
            ids[part] = None
    known = {
        association.pk: association
        for association in PosAssociation.objects.filter(
            organizer=event.organizer, pk__in=[pk for pk in ids.values() if pk]
        )
    }
    return {part: known.get(pk) for part, pk in ids.items()}


def online_holder(event):
    """The association the webshop's money lands with, if it is not the online one."""
    return association_named(event.organizer, event.settings.get(ONLINE_HOLDER_SETTING))


def sumup_holder(organizer):
    """The association the SumUp account belongs to, or ``None`` when nobody said."""
    return association_named(organizer, organizer.settings.get(SUMUP_HOLDER_SETTING))


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
    answer is no: the statements of every evening that named it would
    otherwise change hands without a word.
    """
    from pretix.base.models.event import Event_SettingsStore

    found = []
    organizer = association.organizer
    if organizer.settings.get(SUMUP_HOLDER_SETTING) == str(association.pk):
        found.append(_("It holds the SumUp account's money."))
    drawers = sorted(drawer.name for drawer in association.drawers.all())
    if drawers:
        found.append(
            _("It holds the cash of: {drawers}.").format(drawers=", ".join(drawers))
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
            _("It counts a part of: {events}.").format(events=", ".join(events))
        )
    return found
