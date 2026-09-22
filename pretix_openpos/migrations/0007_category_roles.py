import django.db.models.deletion
from django.db import migrations, models


class Migration(migrations.Migration):
    """
    One row per category an organiser has reserved for a single role.

    A new table, so nothing existing is rewritten and no journal hash moves. No
    data migration, on purpose and for the same reason as the roles themselves:
    a category with no row here is sold by every till, which is what every
    category does today. Deploying this therefore changes nothing on any screen
    until somebody opens the new page and reserves something.
    """

    dependencies = [
        ('pretix_openpos', '0006_terminal_payments'),
        ('pretixbase', '0001_initial'),
    ]

    operations = [
        migrations.CreateModel(
            name='PosCategory',
            fields=[
                ('id', models.BigAutoField(auto_created=True, primary_key=True, serialize=False)),
                ('role', models.CharField(blank=True, choices=[('', 'Every till'), ('pos', 'The bar till only'), ('door', 'The door only')], default='', max_length=8, verbose_name='Sold by')),
                ('category', models.OneToOneField(on_delete=django.db.models.deletion.CASCADE, related_name='openpos_category', to='pretixbase.itemcategory')),
            ],
            options={
                'verbose_name': 'Category at the till',
                'verbose_name_plural': 'Categories at the till',
            },
        ),
    ]
