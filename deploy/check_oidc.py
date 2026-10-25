"""Run inside the production image: pretix-oidc is there, and pretix uses it.

    docker run --rm -i --network none --entrypoint python3 -w /pretix/src \\
        -e DATA_DIR=/data <image> - < deploy/check_oidc.py

The plugin does nothing until pretix.cfg names its backend. An image without it,
or with one of its dependencies broken, builds, starts and sells all the same;
the login page is what breaks, on the day someone switches it on. So this
switches it on, against a provider that does not exist, and asks pretix for the
URL its login button would send a browser to. Nothing is fetched, hence
--network none, and no database is opened.
"""
import os
from urllib.parse import parse_qs, urlsplit

PROVIDER = "https://id.example.invalid"

# The way an installation configures it: pretix reads PRETIX_<SECTION>_<OPTION>
# from the environment before pretix.cfg, and the [oidc] section is the plugin's.
os.environ.update({
    "PRETIX_PRETIX_AUTH_BACKENDS":
        "pretix.base.auth.NativeAuthBackend,pretix_oidc.auth.OIDCAuthBackend",
    "PRETIX_OIDC_TITLE": "Example SSO",
    "PRETIX_OIDC_ISSUER": PROVIDER,
    "PRETIX_OIDC_AUTHORIZATION_ENDPOINT": PROVIDER + "/authorize",
    "PRETIX_OIDC_TOKEN_ENDPOINT": PROVIDER + "/token",
    "PRETIX_OIDC_USERINFO_ENDPOINT": PROVIDER + "/userinfo",
    "PRETIX_OIDC_END_SESSION_ENDPOINT": PROVIDER + "/logout",
    "PRETIX_OIDC_JWKS_URI": PROVIDER + "/jwks.json",
    "PRETIX_OIDC_CLIENT_ID": "pretix",
    "PRETIX_OIDC_CLIENT_SECRET": "not-a-secret",
    "PRETIX_OIDC_SCOPES": "openid,email,profile,groups",
})
os.environ.setdefault("DJANGO_SETTINGS_MODULE", "production_settings")

import django  # noqa: E402

django.setup()

from importlib.metadata import version  # noqa: E402

from django.apps import apps  # noqa: E402
from django.test import RequestFactory  # noqa: E402
from django.urls import reverse  # noqa: E402
from pretix.base.auth import get_auth_backends  # noqa: E402

assert apps.is_installed("pretix_oidc"), "pretix_oidc is not an installed app"
# The callback the provider has to be told about (README).
assert reverse("plugins:pretix_oidc:oidc_callback") == "/oidc/callback/"

backend = get_auth_backends().get("pretix_oidc")
assert backend is not None, "pretix does not list the OIDC backend"
assert backend.verbose_name == "Example SSO", backend.verbose_name

request = RequestFactory().get(
    "/control/login", HTTP_HOST="tickets.example.org", secure=True)
request.session = {}
url = urlsplit(backend.authentication_url(request))
query = parse_qs(url.query)
assert f"{url.scheme}://{url.netloc}{url.path}" == PROVIDER + "/authorize", url
assert query["response_type"] == ["code"], query
assert query["client_id"] == ["pretix"], query
assert query["redirect_uri"] == ["https://tickets.example.org/oidc/callback/"], query
assert query["scope"][0].split() == ["openid", "email", "profile", "groups"], query
assert query["state"] == list(request.session["oidc_state"]), query

print(f"pretix-oidc {version('pretix-oidc')} on pretix {version('pretix')}: "
      f"backend loaded, login URL {url.scheme}://{url.netloc}{url.path}")
