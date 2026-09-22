"""
The till's own price list, removed.

A product used to be able to cost one thing in the webshop and another at the
door, through a table this plugin kept beside pretix' own prices. That is what
made the takings impossible to read afterwards: one product, two prices, and
nothing on a sold line saying which of them had been charged. A door that
charges more than the webshop now sells a *different* product — one limited to
the ``openpos`` sales channel and priced in pretix like everything else.

The rows go with the table and nothing can bring them back, so they are written
down on the way out, **into pretix' own history**, one entry per event, before
the table is dropped. That is the only copy that survives the upgrade, and it
is deliberately not the container's startup log: a log line scrolls past once,
on a machine an organiser may not be able to read, whereas the history is on
the event, is permanent, and is where somebody asking "why does the beer cost
more tonight" already looks.

The same list still goes to the log, because an operator watching a migration
run should see what it did.

Writing the history entry can never be the reason an upgrade fails. It is
wrapped accordingly: a pretix whose ``LogEntry`` is not shaped the way this
expects costs the entry, not the deployment, and the log still has the list.
"""
import json
import logging

from django.db import migrations

logger = logging.getLogger("pretix_openpos")

#: What the entry is filed under. Rendered by ``PricesRemoved`` in
#: ``logdisplay.py``; without that class pretix shows the bare identifier.
ACTION_TYPE = "pretix_openpos.prices.removed"


def _replacement(row):
    """
    What pretix will charge for this row's product from now on.

    The same fallback the till now uses, minus the per-date price: the tariff
    never had a notion of dates, so there is no date to compare against and a
    series would need one line per evening to be exact.
    """
    variation = row.variation
    if variation is not None and variation.default_price is not None:
        return variation.default_price
    return row.item.default_price


def _name(row):
    name = str(row.item.name)
    if row.variation is not None:
        return f"{name} – {row.variation.value}"
    return name


def _write_history(apps, per_event):
    """
    One entry per event, on the event, in pretix' own history.

    Built by hand rather than through ``log_action``: that method is on the
    live model and not on the historical one, and it queues webhook and
    notification tasks through Celery, which is not something a migration
    should be doing at all.
    """
    LogEntry = apps.get_model("pretixbase", "LogEntry")
    ContentType = apps.get_model("contenttypes", "ContentType")
    # By label rather than ``get_for_model``: that helper keys its cache on the
    # model class, and the class here is a historical rebuild of Event, not the
    # one the control panel will look the entry up with.
    content_type, _ = ContentType.objects.get_or_create(
        app_label="pretixbase", model="event"
    )
    for event, removed in per_event.items():
        LogEntry.objects.create(
            content_type=content_type,
            object_id=event.pk,
            event_id=event.pk,
            organizer_id=event.organizer_id,
            action_type=ACTION_TYPE,
            data=json.dumps({"removed": removed}, sort_keys=True),
        )


def say_what_is_being_dropped(apps, schema_editor):
    """Write every on-site price, and the price that replaces it, then leave."""
    PosPrice = apps.get_model("pretix_openpos", "PosPrice")
    rows = PosPrice.objects.select_related("event", "item", "variation").order_by(
        "event_id", "item_id", "variation_id"
    )
    per_event = {}
    said = 0
    for row in rows:
        replacement = _replacement(row)
        name = _name(row)
        if said == 0:
            logger.warning(
                "openpos: the on-site price list is being removed. Each product "
                "below was charged the first figure at the till and will now be "
                "charged the second, which is its price in pretix. Where the two "
                "differ, set the pretix price, or sell a separate product limited "
                "to the openpos sales channel."
            )
        said += 1
        logger.warning(
            "openpos:   %s/%s — %s: on-site %s, now %s%s",
            row.event.organizer_id, row.event.slug, name, row.price, replacement,
            "" if row.price == replacement else "  <-- CHANGES",
        )
        per_event.setdefault(row.event, []).append({
            "item": row.item_id,
            "item_name": name if row.variation is None else str(row.item.name),
            "variation": row.variation_id,
            "variation_name": None if row.variation is None else str(row.variation.value),
            "from": str(row.price),
            "to": str(replacement),
            "changes": row.price != replacement,
        })
    if not said:
        return
    logger.warning("openpos: %d on-site price(s) removed.", said)
    try:
        _write_history(apps, per_event)
    except Exception:
        # Deliberately broad. Whatever went wrong here, the upgrade is the
        # thing that matters and the list is already in the log above.
        logger.exception(
            "openpos: the on-site prices could not be written to the event "
            "history. The list above is the only remaining copy."
        )


class Migration(migrations.Migration):

    dependencies = [
        ("pretix_openpos", "0007_category_roles"),
        # Named because the entry is filed against Event's content type, and a
        # fresh database can otherwise reach this migration with the
        # contenttypes table not yet created.
        ("contenttypes", "0002_remove_content_type_name"),
    ]

    operations = [
        migrations.RunPython(
            say_what_is_being_dropped,
            # Going back gives the table again, empty. What was in it is gone
            # either way, so a reverse that claimed otherwise would be a lie.
            migrations.RunPython.noop,
            elidable=False,
        ),
        migrations.DeleteModel(name="PosPrice"),
    ]
