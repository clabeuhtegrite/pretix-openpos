"""
The till's own price list, removed.

A product used to be able to cost one thing in the webshop and another at the
door, through a table this plugin kept beside pretix' own prices. That is what
made the takings impossible to read afterwards: one product, two prices, and
nothing on a sold line saying which of them had been charged. A door that
charges more than the webshop now sells a *different* product — one limited to
the ``openpos`` sales channel and priced in pretix like everything else.

The rows go with the table, and nothing can bring them back, so they are said
out loud on the way out: every on-site price is logged with what pretix will
charge in its place. An operator upgrading reads that in the output of
``pretix migrate``, which for the production image is the container's startup
log. Anyone who wants the list *before* upgrading — the useful moment, because
that is when the pretix prices can still be corrected first — is pointed at the
same query in the release notes.
"""
import logging

from django.db import migrations

logger = logging.getLogger("pretix_openpos")


def say_what_is_being_dropped(apps, schema_editor):
    """
    Log every on-site price, and the price that replaces it.

    Read through the historical models on purpose: this runs inside whatever
    pretix the operator has installed, and the one thing that cannot change
    under it is the shape of this plugin's own table at this point of its
    history.
    """
    PosPrice = apps.get_model("pretix_openpos", "PosPrice")
    rows = PosPrice.objects.select_related("event", "item", "variation").order_by(
        "event_id", "item_id", "variation_id"
    )
    said = 0
    for row in rows:
        variation = row.variation
        # The same fallback the till now uses, minus the per-date price: the
        # tariff never had a notion of dates, so there is no date to compare
        # against and a series would need one line per evening to be exact.
        replacement = row.item.default_price
        if variation is not None and variation.default_price is not None:
            replacement = variation.default_price
        name = str(row.item.name)
        if variation is not None:
            name = f"{name} – {variation.value}"
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
    if said:
        logger.warning("openpos: %d on-site price(s) removed.", said)


class Migration(migrations.Migration):

    dependencies = [
        ("pretix_openpos", "0007_category_roles"),
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
