import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """
    The associations an organizer's evenings are shared between.

    One new table and one new nullable column on the drawer, so nothing
    existing is rewritten and no hash moves: the drawer row is not part of any
    chained record, and every existing drawer reads as "nobody has said who
    holds its cash", which is exactly what is known about it. Which
    association counts which part of an evening lives in event settings, and
    who holds the SumUp account's money in an organizer setting; neither needs
    a column.

    Going back to 0.25.x leaves the table and the column in place, unread: a
    drawer row written with ``held_by`` set is still a valid drawer for the
    older code, which never selects the column by name.
    """

    dependencies = [
        ("pretix_openpos", "0012_device_contact"),
        # The organizer's table has existed since pretix' first migration.
        # Named instead of the latest one: makemigrations invents a fresh
        # pretixbase migration for locale choices, which only exists where it
        # ran (see 0001).
        ("pretixbase", "0001_initial"),
    ]

    operations = [
        migrations.CreateModel(
            name="PosAssociation",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False
                    ),
                ),
                ("name", models.CharField(max_length=190)),
                ("created", models.DateTimeField(auto_now_add=True)),
                (
                    "organizer",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="openpos_associations",
                        to="pretixbase.organizer",
                    ),
                ),
            ],
            options={
                "verbose_name": "Association",
                "verbose_name_plural": "Associations",
                "ordering": ("name", "pk"),
            },
        ),
        migrations.AddConstraint(
            model_name="posassociation",
            constraint=models.UniqueConstraint(
                fields=("organizer", "name"), name="openpos_association_unique_name"
            ),
        ),
        migrations.AddField(
            model_name="posdrawer",
            name="held_by",
            field=models.ForeignKey(
                blank=True,
                null=True,
                on_delete=django.db.models.deletion.PROTECT,
                related_name="drawers",
                to="pretix_openpos.posassociation",
            ),
        ),
    ]
