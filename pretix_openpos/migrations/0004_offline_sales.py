from django.db import migrations, models


class Migration(migrations.Migration):
    """
    One flag for the sales a till recorded while it had no network.

    Additive with a default, so PostgreSQL adds the column without rewriting the
    table. No data migration: every existing row was written by a till that was
    online, which is what the default says, and rows written before this carry
    ``hash_version`` 1 to 3 — whose payloads do not include the column. Existing
    hashes, and the chain they form, are untouched.
    """

    dependencies = [
        ('pretix_openpos', '0003_cancellations'),
    ]

    operations = [
        migrations.AddField(
            model_name='possale',
            name='offline',
            field=models.BooleanField(default=False),
        ),
    ]
