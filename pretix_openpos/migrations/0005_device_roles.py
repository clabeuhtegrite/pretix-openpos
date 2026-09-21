import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """
    One row per paired device saying what that device is for.

    A new table, so nothing existing is rewritten and no journal hash moves. No
    data migration either, on purpose: a device with no row keeps the behaviour
    it has today — the till, with the door one tap away — and the split only
    takes effect for the devices an organizer actually assigns. Rolling this out
    mid-event therefore changes nothing on its own.
    """

    dependencies = [
        ('pretix_openpos', '0004_offline_sales'),
        ('pretixbase', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='PosDevice',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('role', models.CharField(blank=True, choices=[('', 'Not assigned'), ('pos', 'Till'), ('door', 'Door')], default='', max_length=8, verbose_name='Role')),
                ('sumup_reader_id', models.CharField(blank=True, default='', max_length=190, verbose_name='SumUp reader')),
                ('device', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='openpos_device', to='pretixbase.device')),
            ],
            options={
                'verbose_name': 'Till device',
                'verbose_name_plural': 'Till devices',
            },
        ),
    ]
