#!/bin/sh
set -e

# Reinstall on every boot so that changes to pyproject.toml (new entry points,
# new dependencies) are picked up. Plain Python edits are handled by Django's
# autoreloader without a restart.
echo "==> installing pretix-openpos in editable mode"
pip install --no-cache-dir --no-deps -e /plugin

echo "==> pretix version: $(python -c 'import pretix; print(pretix.__version__)')"

echo "==> applying migrations"
python -m pretix migrate --noinput

# pretix uses a hashed staticfiles manifest, so {% static %} fails outright for
# any file that has not been collected. STATIC_ROOT lives inside site-packages
# and therefore does not survive a container rebuild. This is incremental, so it
# is cheap on every boot after the first.
echo "==> collecting static files"
python -m pretix collectstatic --noinput 2>&1 | tail -1

if [ "$1" = "runserver" ]; then
    echo "==> creating the initial admin user if there is none"
    python -m pretix shell -c "
from pretix.base.models import User
if not User.objects.filter(is_staff=True).exists():
    User.objects.create_superuser('admin@localhost', 'admin')
    print('created admin@localhost / admin')
else:
    print('admin user already exists')
" || echo "!! could not seed the admin user, create one with 'python -m pretix createsuperuser'"

    # --insecure because DEBUG is off (see dev/pretix.cfg) and staticfiles would
    # otherwise refuse to serve anything.
    echo "==> starting dev server on http://localhost:8000"
    exec python -m pretix runserver --insecure 0.0.0.0:8000
fi

exec python -m pretix "$@"
