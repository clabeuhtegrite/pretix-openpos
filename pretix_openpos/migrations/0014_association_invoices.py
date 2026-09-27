import django.db.models.deletion
from django.db import migrations, models

#: The event settings of 0.26.0's statements that said which association
#: counted which part of an evening. Gone with the statements.
SHARES = ("openpos_share_online", "openpos_share_door", "openpos_share_bar")
#: Who the webshop's payments are made to: kept, and now who invoices them.
ONLINE = "openpos_online_holder"


def online_invoicer_from_shares(apps, schema_editor):
    """
    Keep who the online payments were said to go to, then drop the shares.

    In 0.26.0 an event whose online sales were counted by one association and
    whose payments were said to go nowhere else left the second setting empty:
    empty meant "the online sales' own". That association is the one the
    payments go to, so it is the one that invoices them now.
    """
    Store = apps.get_model("pretixbase", "Event_SettingsStore")
    shared = Store.objects.filter(key="openpos_share_online")
    for row in shared:
        if not Store.objects.filter(object_id=row.object_id, key=ONLINE).exists():
            Store.objects.create(object_id=row.object_id, key=ONLINE, value=row.value)
    Store.objects.filter(key__in=SHARES).delete()


class Migration(migrations.Migration):
    """
    Invoices in each association's name.

    New columns on the association for what an invoice says about its seller,
    all blank to start with: an association from 0.26.0 has a name and nothing
    else, and reads as not ready to invoice until somebody fills it in — its
    evenings are invoiced in the event's name meanwhile, exactly as before.
    One new table, recording which association issued which invoice.

    Going back to 0.26.x leaves the columns and the table unread, and the
    shares of its statements empty. The columns keep their empty default in
    the database, not only in Python, so that its Associations page can still
    add one without knowing them (see 0012). Invoices already issued in an
    association's name keep their numbers; the older code invoices whatever
    comes next in the event's name.
    """

    dependencies = [
        ("pretix_openpos", "0013_associations"),
        # See 0013: named rather than the latest pretixbase migration. Invoices
        # and settings have existed long before 0001 of this plugin required.
        ("pretixbase", "0001_initial"),
    ]

    operations = [
        migrations.AddField(
            model_name="posassociation",
            name="address",
            field=models.TextField(blank=True, db_default="", default=""),
        ),
        migrations.AddField(
            model_name="posassociation",
            name="zipcode",
            field=models.CharField(blank=True, db_default="", default="", max_length=30),
        ),
        migrations.AddField(
            model_name="posassociation",
            name="city",
            field=models.CharField(blank=True, db_default="", default="", max_length=190),
        ),
        migrations.AddField(
            model_name="posassociation",
            name="country",
            field=models.CharField(blank=True, db_default="", default="", max_length=2),
        ),
        migrations.AddField(
            model_name="posassociation",
            name="siret",
            field=models.CharField(blank=True, db_default="", default="", max_length=32),
        ),
        migrations.AddField(
            model_name="posassociation",
            name="vat_id",
            field=models.CharField(blank=True, db_default="", default="", max_length=190),
        ),
        migrations.AddField(
            model_name="posassociation",
            name="invoice_prefix",
            field=models.CharField(blank=True, db_default="", default="", max_length=100),
        ),
        migrations.AddField(
            model_name="posassociation",
            name="invoice_footer",
            field=models.TextField(blank=True, db_default="", default=""),
        ),
        migrations.AddConstraint(
            model_name="posassociation",
            constraint=models.UniqueConstraint(
                condition=models.Q(("invoice_prefix", ""), _negated=True),
                fields=("organizer", "invoice_prefix"),
                name="openpos_association_unique_prefix",
            ),
        ),
        migrations.CreateModel(
            name="PosInvoiceIssuer",
            fields=[
                (
                    "id",
                    models.BigAutoField(
                        auto_created=True, primary_key=True, serialize=False
                    ),
                ),
                ("via", models.CharField(max_length=16)),
                (
                    "association",
                    models.ForeignKey(
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="invoices",
                        to="pretix_openpos.posassociation",
                    ),
                ),
                (
                    "drawer",
                    models.ForeignKey(
                        blank=True,
                        null=True,
                        on_delete=django.db.models.deletion.PROTECT,
                        related_name="+",
                        to="pretix_openpos.posdrawer",
                    ),
                ),
                (
                    "invoice",
                    models.OneToOneField(
                        on_delete=django.db.models.deletion.CASCADE,
                        related_name="openpos_issuer",
                        to="pretixbase.invoice",
                    ),
                ),
            ],
            options={
                "verbose_name": "Invoice issuer",
                "verbose_name_plural": "Invoice issuers",
            },
        ),
        migrations.RunPython(online_invoicer_from_shares, migrations.RunPython.noop),
    ]
