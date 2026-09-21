import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """
    One row per card payment put on a reader.

    A new table, so nothing existing is touched and no journal hash moves. It
    is not part of the journal and does not want to be: the journal is the
    append-only record of what the drawer did, and a payment still waiting for
    a cardholder is not yet anything. What reaches the journal is the sale, once
    this row says the money moved.
    """

    dependencies = [
        ('pretix_openpos', '0005_device_roles'),
        ('pretixbase', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='PosTerminalPayment',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('device_serial', models.CharField(blank=True, default='', max_length=190)),
                ('idempotency_key', models.CharField(max_length=190)),
                ('client_transaction_id', models.CharField(blank=True, default='', max_length=190)),
                ('transaction_id', models.CharField(blank=True, default='', max_length=190)),
                ('reader_id', models.CharField(max_length=190)),
                ('amount', models.DecimalField(decimal_places=2, max_digits=13)),
                ('currency', models.CharField(max_length=8)),
                ('positions', models.JSONField(default=list)),
                ('status', models.CharField(choices=[('pending', 'Waiting for the cardholder'), ('successful', 'Paid'), ('failed', 'Not paid')], default='pending', max_length=16)),
                ('failure', models.CharField(blank=True, default='', max_length=190)),
                ('refunded', models.DateTimeField(blank=True, null=True)),
                ('created', models.DateTimeField(auto_now_add=True)),
                ('updated', models.DateTimeField(auto_now=True)),
                ('device', models.ForeignKey(blank=True, null=True, on_delete=django.db.models.deletion.SET_NULL, related_name='openpos_terminal_payments', to='pretixbase.device')),
                ('event', models.ForeignKey(on_delete=django.db.models.deletion.CASCADE, related_name='openpos_terminal_payments', to='pretixbase.event')),
            ],
            options={
                'verbose_name': 'Terminal payment',
                'verbose_name_plural': 'Terminal payments',
                'indexes': [models.Index(fields=['client_transaction_id'], name='openpos_terminal_ctid_idx')],
                'constraints': [models.UniqueConstraint(fields=('event', 'idempotency_key'), name='openpos_terminal_unique_key')],
            },
        ),
    ]
