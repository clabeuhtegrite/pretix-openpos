from django.db import migrations, models


class Migration(migrations.Migration):
    """
    What each device was last heard saying: six columns on the device's row.

    When it last reached the server, and the status its app last reported —
    how many sales it holds that it has not sent, since when, when it last
    synced and which build it runs. Nothing is rewritten and no hash moves:
    the device row is not part of any chained record. Every existing row reads
    as "not heard from since the upgrade" and "nothing reported", which is
    exactly what is known about it.

    The four times are nullable. The count and the version are not, and carry
    their default in the database, not only in Python: Django drops a
    Python-only default from the column once the column is added, and 0.24 —
    should it be put back after this — writes a row without these columns the
    first time a device is given a role. With the default kept in the column,
    that insert still works, on PostgreSQL as on SQLite.
    """

    dependencies = [
        ("pretix_openpos", "0011_drawer_archived_at"),
    ]

    operations = [
        migrations.AddField(
            model_name="posdevice",
            name="app_version",
            field=models.CharField(db_default="", default="", max_length=64),
        ),
        migrations.AddField(
            model_name="posdevice",
            name="last_seen_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="posdevice",
            name="last_sync_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="posdevice",
            name="oldest_pending_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
        migrations.AddField(
            model_name="posdevice",
            name="pending_sales",
            field=models.PositiveIntegerField(db_default=0, default=0),
        ),
        migrations.AddField(
            model_name="posdevice",
            name="status_reported_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
