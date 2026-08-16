from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Room in the journal for a reversal.

    Additive only, and deliberately without a data migration: every existing row
    is a sale, which is exactly what ``kind`` defaults to, and rows written
    before this carry ``hash_version`` 1 or 2 — whose payloads do not include
    these columns. Existing hashes, and the chain they form, are untouched.

    All three columns have a default, so PostgreSQL adds them without rewriting
    the table: the journal of a busy event is the last thing that should hold a
    lock while pretix boots.
    """

    dependencies = [
        ('pretix_openpos', '0002_till_identity_and_testmode'),
    ]

    operations = [
        migrations.AddField(
            model_name='possale',
            name='kind',
            field=models.CharField(
                choices=[('sale', 'Sale'), ('cancellation', 'Cancellation')],
                default='sale',
                max_length=16,
            ),
        ),
        migrations.AddField(
            model_name='possale',
            name='cancels_seq',
            field=models.PositiveIntegerField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name='possale',
            name='reason',
            field=models.CharField(blank=True, default='', max_length=190),
        ),
        migrations.AddIndex(
            model_name='possale',
            index=models.Index(
                fields=['event', 'cancels_seq'],
                name='openpos_sale_cancels_idx',
                condition=models.Q(cancels_seq__isnull=False),
            ),
        ),
    ]
