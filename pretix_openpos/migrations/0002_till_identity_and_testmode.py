from django.db import migrations, models


def backfill(apps, schema_editor):
    """
    Classify the rows written before these columns existed.

    Journal rows are append-only as a rule, and this is the exception that
    proves it: nothing here touches a hashed field. Rows written before this
    migration carry ``hash_version = 1``, whose payload does not include
    ``testmode`` — so labelling them leaves every existing hash, and the chain
    they form, exactly as it was. ``device_name`` was never hashed at all.
    """
    PosSale = apps.get_model("pretix_openpos", "PosSale")

    # An orphaned row can only come from a test order. pretix' single bulk
    # deletion path is `event.orders.filter(testmode=True)`, run when test mode
    # is switched off; real orders get cancelled, never deleted. Without this,
    # money that never existed keeps being counted in the takings long after
    # the orders behind it were purged.
    PosSale.objects.filter(order__isnull=True).update(testmode=True)

    # Where the order survives, it holds the answer itself.
    PosSale.objects.filter(order__isnull=False, order__testmode=True).update(testmode=True)

    # The till's human name, for rows whose device still exists.
    for sale in PosSale.objects.filter(device__isnull=False).select_related("device").iterator():
        name = (sale.device.name or "").strip()
        if name:
            PosSale.objects.filter(pk=sale.pk).update(device_name=name)


class Migration(migrations.Migration):

    dependencies = [
        ('pretix_openpos', '0001_initial'),
    ]

    operations = [
        migrations.AddField(
            model_name='possale',
            name='device_name',
            field=models.CharField(blank=True, default='', max_length=190),
        ),
        migrations.AddField(
            model_name='possale',
            name='hash_version',
            field=models.PositiveSmallIntegerField(default=1),
        ),
        migrations.AddField(
            model_name='possale',
            name='testmode',
            field=models.BooleanField(default=False),
        ),
        migrations.RunPython(backfill, migrations.RunPython.noop),
    ]
