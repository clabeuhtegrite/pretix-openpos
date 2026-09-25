# Development image for pretix-openpos.
#
# This is NOT a production image. It runs pretix on SQLite with the Django dev
# server so the plugin can be iterated on with autoreload. The production image
# is deploy/Dockerfile, on top of pretix/standalone.
FROM python:3.13-slim

ENV PYTHONUNBUFFERED=1 \
    PYTHONDONTWRITEBYTECODE=1 \
    PRETIX_CONFIG_FILE=/etc/pretix/pretix.cfg \
    DATA_DIR=/data

# Build dependencies for the wheels pretix pulls in (lxml, Pillow, cryptography)
# plus gettext, which pretix needs to compile translations.
RUN apt-get update && apt-get install -y --no-install-recommends \
        build-essential \
        gettext \
        git \
        libffi-dev \
        libjpeg-dev \
        libopenjp2-7-dev \
        libssl-dev \
        libxml2-dev \
        libxslt1-dev \
        zlib1g-dev \
    && rm -rf /var/lib/apt/lists/*

# The pretix the production image is built on, read out of deploy/Dockerfile
# rather than typed a second time here. This image is also the pretix of the
# end-to-end run (dev/compose.integration.yml), in CI and on a laptop, and a run
# against whatever pretix released last week says nothing about production.
# Read by the image itself rather than handed in as a build argument, so that
# `docker compose up --build` needs no variable set to get it right. Copied on
# its own, just before the install, so that only an edit to that file costs a
# reinstall.
COPY deploy/Dockerfile /tmp/deploy.Dockerfile
RUN set -e; \
    version=$(sed -n 's/^ARG PRETIX_VERSION=\(.*\)$/\1/p' /tmp/deploy.Dockerfile); \
    if [ -z "$version" ]; then echo "no ARG PRETIX_VERSION in deploy/Dockerfile" >&2; exit 1; fi; \
    pip install --no-cache-dir --upgrade pip; \
    pip install --no-cache-dir "pretix==${version}.*"; \
    rm /tmp/deploy.Dockerfile

RUN mkdir -p /etc/pretix /data
COPY dev/pretix.cfg /etc/pretix/pretix.cfg
COPY dev/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /plugin
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["runserver"]
