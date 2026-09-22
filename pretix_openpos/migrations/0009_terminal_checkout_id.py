from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Keep SumUp's handle on the request put on the reader.

    A column with an empty default, so existing rows need no rewrite and no
    journal hash moves. A payment written before this simply has none, and
    settles the way it always did: from the Transactions API alone.
    """

    dependencies = [
        ('pretix_openpos', '0008_remove_on_site_prices'),
    ]

    operations = [
        migrations.AddField(
            model_name='posterminalpayment',
            name='checkout_id',
            field=models.CharField(default='', max_length=190),
        ),
    ]
