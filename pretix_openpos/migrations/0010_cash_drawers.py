import django.db.models.deletion
from django.conf import settings
from django.db import migrations, models


class Migration(migrations.Migration):
    """
    Cash drawers, their openings, and the ledger of what moved their money.

    Three new tables and two new nullable columns, so nothing existing is
    rewritten and no journal hash moves: a sale written before this has no
    drawer, and its hash version says so. No data migration either. A device
    is only tied to a drawer once somebody assigns one, and until then it sells
    exactly as it did — which is what makes deploying this in the middle of a
    season a non-event.
    """

    dependencies = [
        ('pretix_openpos', '0009_terminal_checkout_id'),
        ('pretixbase', '0001_initial'),
        migrations.swappable_dependency(settings.AUTH_USER_MODEL),
    ]

    operations = [
        migrations.CreateModel(
            name='PosDrawer',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('name', models.CharField(max_length=190, verbose_name='Name')),
                ('opening_float', models.DecimalField(blank=True, decimal_places=2, max_digits=13, null=True, verbose_name='Usual opening float')),
                ('created', models.DateTimeField(auto_now_add=True)),
                ('organizer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='openpos_drawers', to='pretixbase.organizer')),
            ],
            options={
                'verbose_name': 'Cash drawer',
                'verbose_name_plural': 'Cash drawers',
                'ordering': ('name', 'pk'),
            },
        ),
        migrations.AddField(
            model_name='posdevice',
            name='drawer',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='devices', to='pretix_openpos.posdrawer', verbose_name='Cash drawer'),
        ),
        migrations.CreateModel(
            name='PosDrawerSession',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('opened_at', models.DateTimeField()),
                ('closed_at', models.DateTimeField(blank=True, null=True)),
                ('drawer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='sessions', to='pretix_openpos.posdrawer')),
            ],
            options={
                'verbose_name': 'Cash drawer opening',
                'verbose_name_plural': 'Cash drawer openings',
                'ordering': ('-opened_at', '-pk'),
            },
        ),
        migrations.CreateModel(
            name='PosDrawerEntry',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('seq', models.PositiveIntegerField()),
                ('datetime', models.DateTimeField(db_index=True)),
                ('kind', models.CharField(choices=[('open', 'Opening float'), ('in', 'Cash in'), ('out', 'Cash out'), ('count', 'Count'), ('close', 'Closing')], max_length=16)),
                ('amount', models.DecimalField(blank=True, decimal_places=2, max_digits=13, null=True)),
                ('expected', models.DecimalField(blank=True, decimal_places=2, max_digits=13, null=True)),
                ('denominations', models.JSONField(blank=True, default=dict)),
                ('reason', models.CharField(blank=True, default='', max_length=190)),
                ('cashier', models.CharField(blank=True, default='', max_length=190)),
                ('source', models.CharField(choices=[('till', 'Till'), ('backoffice', 'Back office')], default='till', max_length=16)),
                ('device_serial', models.CharField(blank=True, default='', max_length=190)),
                ('device_name', models.CharField(blank=True, default='', max_length=190)),
                ('idempotency_key', models.CharField(max_length=190)),
                ('previous_hash', models.CharField(max_length=64)),
                ('hash', models.CharField(max_length=64)),
                ('hash_version', models.PositiveSmallIntegerField(default=1)),
                ('device', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='openpos_drawer_entries', to='pretixbase.device')),
                ('drawer', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='entries', to='pretix_openpos.posdrawer')),
                ('session', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='entries', to='pretix_openpos.posdrawersession')),
                ('user', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='openpos_drawer_entries', to=settings.AUTH_USER_MODEL)),
            ],
            options={
                'verbose_name': 'Cash drawer entry',
                'verbose_name_plural': 'Cash drawer entries',
                'ordering': ('drawer', 'seq'),
            },
        ),
        migrations.AddField(
            model_name='possale',
            name='drawer_session',
            field=models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.RESTRICT, related_name='sales', to='pretix_openpos.posdrawersession'),
        ),
        migrations.AddConstraint(
            model_name='posdrawer',
            constraint=models.UniqueConstraint(fields=('organizer', 'name'), name='openpos_drawer_unique_name'),
        ),
        migrations.AddConstraint(
            model_name='posdrawersession',
            constraint=models.UniqueConstraint(condition=models.Q(('closed_at__isnull', True)), fields=('drawer',), name='openpos_drawer_one_open_session'),
        ),
        migrations.AddConstraint(
            model_name='posdrawerentry',
            constraint=models.UniqueConstraint(fields=('drawer', 'seq'), name='openpos_drawer_unique_seq'),
        ),
        migrations.AddConstraint(
            model_name='posdrawerentry',
            constraint=models.UniqueConstraint(fields=('drawer', 'idempotency_key'), name='openpos_drawer_unique_idempotency'),
        ),
    ]
