# Development image for pretix-openpos.
#
# This is NOT a production image. It runs pretix on SQLite with the Django dev
# server so the plugin can be iterated on with autoreload. For the homelab
# deployment, build a slim image on top of pretix/standalone instead and just
# `pip install pretix-openpos`.
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

RUN pip install --no-cache-dir --upgrade pip \
    && pip install --no-cache-dir pretix

RUN mkdir -p /etc/pretix /data
COPY dev/pretix.cfg /etc/pretix/pretix.cfg
COPY dev/entrypoint.sh /usr/local/bin/entrypoint.sh
RUN chmod +x /usr/local/bin/entrypoint.sh

WORKDIR /plugin
EXPOSE 8000
ENTRYPOINT ["/usr/local/bin/entrypoint.sh"]
CMD ["runserver"]
