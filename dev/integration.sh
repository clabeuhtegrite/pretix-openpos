#!/bin/sh
#
# The end-to-end run: pretix on PostgreSQL, seeded, with every script in dev/
# fired at it.
#
#   dev/integration.sh
#
# These four are not redundant with the unit suites. They exercise what only
# exists in a whole running system: the journal's savepoint handling under
# concurrent tills, which is forgiving on SQLite and unforgiving on PostgreSQL;
# the back-office pages rendered through a real session; the arrivals pages over
# three seeded events; and the offline replay over real HTTP.
#
# Used by CI and by hand, the same way, so a failure on a laptop is the failure
# CI saw. Leaves nothing behind: the stack is torn down on the way out, whether
# it passed or not.
set -eu

cd "$(dirname "$0")/.."

COMPOSE="docker compose -f dev/compose.integration.yml"
BASE="${OPENPOS_BASE:-http://localhost:8001}"
# Threads for the concurrency test. Six is enough to make two tills collide on
# a sequence number reliably without making a laptop unusable.
THREADS="${OPENPOS_THREADS:-6}"

cleanup() {
    status=$?
    if [ "${OPENPOS_KEEP_STACK:-}" = "1" ]; then
        echo "==> leaving the stack up (OPENPOS_KEEP_STACK=1)"
    else
        echo "==> tearing the stack down"
        $COMPOSE down -v --remove-orphans >/dev/null 2>&1 || true
    fi
    exit $status
}
trap cleanup EXIT INT TERM

# The PWA bundle is generated, not committed, so a fresh checkout has none —
# and pretix serves the shell through a hashed staticfiles manifest, which does
# not contain what was never collected. The back-office script renders that
# shell, so without this the run fails on a missing manifest entry rather than
# on anything it was testing. Built in a container so this script needs nothing
# but Docker; preflight sets OPENPOS_SKIP_BUNDLE because it has just built the
# same bundle from the same tree.
if [ "${OPENPOS_SKIP_BUNDLE:-}" = "1" ]; then
    echo "==> reusing the bundle preflight just built"
else
    echo "==> building the till's own JavaScript"
    # The anonymous volume over node_modules matters: without it, npm ci
    # installs Linux binaries straight into the host's frontend/node_modules
    # and every `npm test` on the machine afterwards fails on the wrong
    # architecture. The bundle itself is written to the mounted tree, which is
    # the point.
    docker run --rm \
        -v "$PWD:/src" -v /src/frontend/node_modules \
        -w /src/frontend node:22-slim \
        sh -c "npm ci --silent && npm run build" >/dev/null
fi

echo "==> building and starting pretix on PostgreSQL"
$COMPOSE up -d --build

echo "==> waiting for it to answer"
# The first boot installs the plugin, runs pretix' whole migration history and
# collects static files, which is minutes rather than seconds.
waited=0
# The login page rather than /healthcheck/: pretix' own probe also wants Redis
# and a celery worker, which this stack deliberately does not run.
until curl -fsS "$BASE/control/login" >/dev/null 2>&1; do
    waited=$((waited + 2))
    if [ "$waited" -gt 600 ]; then
        echo "!! pretix never came up; last 80 lines of its log:"
        $COMPOSE logs --tail=80 pretix
        exit 1
    fi
    sleep 2
done
echo "    up after ${waited}s"

echo "==> seeding the demo organizer, event and till"
seed_output=$($COMPOSE exec -T pretix python -m pretix shell < dev/seed.py)
echo "$seed_output"
TOKEN=$(echo "$seed_output" | sed -n 's/^init token *: *//p' | tr -d '\r')
if [ -z "$TOKEN" ] || [ "$TOKEN" = "None" ]; then
    echo "!! the seed produced no pairing token; the device may already be paired."
    echo "   Run '$COMPOSE down -v' and try again."
    exit 1
fi

echo
echo "==> smoke test: pair, sell, replay, cancel, count the takings"
OPENPOS_BASE="$BASE" python3 dev/smoke_test.py "$TOKEN"

echo
echo "==> concurrency: several tills writing to one journal at once"
# A fresh pairing code: the smoke test consumed the first one.
TOKEN2=$($COMPOSE exec -T pretix python -m pretix shell -c "
from django_scopes import scopes_disabled
from pretix.base.models import Device
with scopes_disabled():
    device = Device.objects.create(
        organizer_id=Device.objects.first().organizer_id,
        name='Caisse concurrence',
        all_events=True,
        security_profile='openpos',
    )
    print(device.initialization_token)
" | tail -1 | tr -d '\r')
OPENPOS_BASE="$BASE" python3 dev/concurrency_test.py "$TOKEN2" "$THREADS"

echo
echo "==> back office: the pages a cash sale must not turn into a 500"
$COMPOSE exec -T pretix python -m pretix shell < dev/backoffice_test.py

echo
echo "==> arrivals: the histogram, every scan it must ignore, and one evening"
$COMPOSE exec -T pretix python -m pretix shell < dev/arrivals_test.py

echo
echo "==> end to end: everything passed"
