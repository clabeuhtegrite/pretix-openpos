from django.db import migrations, models


class Migration(migrations.Migration):
    """
    A drawer can be archived: one nullable column, empty for every drawer.

    Nothing is rewritten and no hash moves — the drawer row is not part of any
    chained record — so every drawer stays offered exactly as before.
    """

    dependencies = [
        ("pretix_openpos", "0010_cash_drawers"),
    ]

    operations = [
        migrations.AddField(
            model_name="posdrawer",
            name="archived_at",
            field=models.DateTimeField(blank=True, null=True),
        ),
    ]
