#!/bin/sh
#
# Everything, before anything goes to production.
#
#   scripts/preflight.sh              the lot
#   scripts/preflight.sh --fast       all but the end-to-end run and the image
#
# This is the same set of checks CI runs, in the same order, so that the answer
# on a laptop is the answer on a pull request. Run it before building the image
# you are about to push: CI gates the branch, and this gates the artifact.
#
# Nothing here needs pretix, node or PostgreSQL installed — only Docker, and
# Node for the frontend suite.
set -eu

cd "$(dirname "$0")/.."

FAST=0
for arg in "$@"; do
    case "$arg" in
        --fast) FAST=1 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

TEST_IMAGE=pretix-openpos-test

step() {
    echo
    echo "─── $1"
}

step "frontend: install"
(cd frontend && npm ci --silent)

step "frontend: typecheck and build"
(cd frontend && npm run build)

step "frontend: tests, under the coverage floor"
(cd frontend && npm run test:coverage)

step "backend: building the test image"
# Cheap after the first run: pretix and the test dependencies are a cached
# layer, and the tree itself is mounted rather than copied.
docker build -q -f dev/Dockerfile.test -t "$TEST_IMAGE" . >/dev/null

step "backend: lint"
docker run --rm -v "$PWD:/plugin" "$TEST_IMAGE" \
    "pip install -q flake8 flake8-pyproject isort && flake8 pretix_openpos tests && isort --check-only --diff pretix_openpos tests"

step "backend: is there a migration for every model change?"
docker run --rm -v "$PWD:/plugin" -e DJANGO_SETTINGS_MODULE=tests.settings_migrations "$TEST_IMAGE" \
    "pip install --no-deps -q -e . && python -m django makemigrations --check --dry-run pretix_openpos"

step "backend: tests, under the coverage floor"
docker run --rm -v "$PWD:/plugin" "$TEST_IMAGE" \
    "pip install --no-deps -q -e . && pytest --cov"

if [ "$FAST" = "1" ]; then
    echo
    echo "✓ passed — but --fast skipped the end-to-end run and the image build."
    echo "  Do not push an image on this alone."
    exit 0
fi

step "end to end: PostgreSQL, concurrent tills, back office, arrivals"
dev/integration.sh

step "the production image builds, with the till's own JavaScript in it"
# --platform linux/amd64 is not optional on an Apple Silicon Mac: an arm64
# image builds, pushes and passes every manifest check, then is refused by the
# kubelet at pull time on an amd64 node.
docker build --platform linux/amd64 -f deploy/Dockerfile -t pretix-openpos:preflight .
docker run --rm --platform linux/amd64 --entrypoint sh pretix-openpos:preflight -c \
    'ls /pretix/src/pretix/static.dist/pretix_openpos/pwa/app.js' >/dev/null

echo
echo "✓ everything passed. The image tagged pretix-openpos:preflight is the one"
echo "  this run checked — retag and push that, rather than building again."
