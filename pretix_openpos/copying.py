"""
Carrying the till's set-up across when an event is created as a copy.

pretix lets an organiser start an event from another one — "copy configuration
from…" in the event wizard, or the clone call of its API — and an association's
evenings are exactly that shape: next Saturday is last Saturday with another
date. pretix copies every event setting as it stands, then sends
``event_copy_data`` with a map from each product, category and check-in list of
the old event to its copy, and leaves each plugin to put its own references
right. Nothing else will do it.

Three of the till's settings name one of the event's own rows by number, and a
number does not survive a copy: the check-in list door sales walk straight
into, the product free amounts are booked against, and the cup deposit. Left
as they were copied, they name the *old* event's rows, which the new event
cannot see — so every lookup comes back empty, and the till behaves exactly as
if nobody had set anything. Tickets sold at the door stop being checked in, and
the free-amount and deposit buttons are gone, with no screen anywhere saying so.

Who sells what is the same failure in another shape. It hangs off the category
on purpose (see :class:`~pretix_openpos.models.PosCategory`), and the copied
categories are new rows that nobody has reserved. Hung off the category, the
restriction was meant to lapse only where an organiser had said nothing — which
is not true of a copy, where the organiser said it once and expects it kept.
"""
from .models import PosCategory

#: The event settings that hold the id of one of the event's own rows, and the
#: map ``event_copy_data`` translates it through.
REFERENCES = (
    ("openpos_checkin_list", "checkin_list_map"),
    ("openpos_custom_item", "item_map"),
    ("openpos_deposit_item", "item_map"),
)


def _row_id(value):
    try:
        return int(value)
    except (TypeError, ValueError):
        return None


def copy_pos_setup(event, other, maps):
    """
    Point the copied ``event`` at its own rows, where ``other`` pointed at its.

    ``maps`` is what pretix sent with the signal. Only a setting the copy
    actually carried over is touched: pretix skips a setting the new event
    already had, and one of those is the new event's own, which no map of the
    old event's rows can say anything about.
    """
    for key, map_name in REFERENCES:
        copied_value = event.settings.get(key)
        old_id = _row_id(copied_value)
        if old_id is None or copied_value != other.settings.get(key):
            continue
        copy = (maps.get(map_name) or {}).get(old_id)
        if copy is None:
            # The old event named a row that is gone — deleted after it was
            # chosen. Nothing on either side answers to it, so the copy starts
            # without the setting rather than with a number that means nothing.
            event.settings.delete(key)
        else:
            # A string, as the settings form writes it.
            event.settings.set(key, str(copy.pk))

    category_map = maps.get("category_map") or {}
    reserved = PosCategory.objects.filter(category__event=other).exclude(
        role=PosCategory.ROLE_ALL
    )
    for row in reserved:
        copy = category_map.get(row.category_id)
        if copy is not None:
            PosCategory.objects.update_or_create(category=copy, defaults={"role": row.role})
