# Production image: pretix with the Open POS plugin baked in.
#
#   docker build --platform linux/amd64 -f deploy/Dockerfile \
#       -t your-registry/pretix-openpos:<tag> .
#
# --platform linux/amd64 is not optional when building from an Apple Silicon
# Mac. An arm64 image will build, push and pass every manifest check, and then
# be refused by the kubelet at pull time on an amd64 node.
#
# `2026.7` is pretix' rolling minor tag, not an immutable patch tag: upstream
# moves it to each 2026.7.x patch release, so a rebuild picks up the latest patch
# of that minor, and CI installs `pretix==2026.7.*` to test the same thing. That
# is deliberate: the version also names the published channel (`pretix2026.7`),
# which a cluster mirrors and pins by digest, so the channel stays put across
# patch releases while a base upgrade to a new minor remains a deliberate edit.
# To freeze a patch instead, write it here (`2026.7.1`): the channel becomes
# `pretix2026.7.1`, and whatever pins the old channel has to follow.
ARG PRETIX_VERSION=2026.7

# The PWA bundle is generated rather than committed, and it used to be built by
# hand before this image. That left one way to ship a till that could never come
# right: bump the plugin version, forget the rebuild, and the image carries a
# bundle older than the plugin installed beside it. The till then compares the
# two, sees a server newer than itself, and offers an update that no reload can
# ever apply — along with whatever interface fixes the stale bundle predates.
# Building it here removes the step that could be skipped.
FROM node:22-slim AS bundle

WORKDIR /src

# The manifest on its own first: a change to the app's source should not cost a
# reinstall of node_modules.
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN cd frontend && npm ci

# vite reads the version out of __init__.py and bakes it into the bundle, which
# is exactly the number the running till checks against what the server reports.
# Copied on its own so the two cannot come from different trees.
COPY pretix_openpos/__init__.py ./pretix_openpos/__init__.py
COPY frontend ./frontend
RUN cd frontend && npm run build

FROM pretix/standalone:${PRETIX_VERSION}

USER root

# The upstream image is rebuilt on pretix releases, not on Debian security
# updates: the 2026.7 base shipped with perl, glib, ImageMagick and libraw
# builds that Debian had since patched, and Trivy flagged 40 criticals on an
# image nothing in this repo could fix by rebuilding. Upgrading at build time
# picks up whatever Debian has published, so a rebuild is always enough.
RUN apt-get update \
    && apt-get -y --no-install-recommends upgrade \
    && rm -rf /var/lib/apt/lists/*

# Installing from the source tree keeps the plugin version in lockstep with the
# commit that produced the bundle copied in beside it.
COPY --chown=pretixuser:pretixuser . /plugin
COPY --from=bundle --chown=pretixuser:pretixuser \
     /src/pretix_openpos/static/pretix_openpos/pwa \
     /plugin/pretix_openpos/static/pretix_openpos/pwa

RUN pip3 install --no-cache-dir /plugin \
    && rm -rf /plugin

USER pretixuser

# Collects the plugin's static files into the staticfiles manifest. Skipping
# this does not fail the build — it fails at runtime, with the till 500ing on
# its own JavaScript, because pretix resolves {% static %} through a hashed
# manifest that would not contain the bundle.
RUN cd /pretix/src && python3 -m pretix rebuild
