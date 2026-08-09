"""
Render the pretix backend pages that the plugin touches.

    docker compose exec -T pretix python -m pretix shell < dev/backoffice_test.py

Exists because of a bug that no HTTP smoke test could have caught: amounts are
stored in the payment info as strings (that is what belongs in JSON), and pretix'
`money` template filter raises TypeError on anything but a Decimal. The exception
fired while rendering the *order* page, so every cash sale turned the backend
order view into a 500 — invisible from the till, invisible from the API, and only
found by opening an order by hand.

Checks the plugin's own screens too, each with the exact permission it declares:
an unknown permission string is never in the permission set, so a screen would
lock out every team that is not all-powerful while still working for an admin.
"""
import re
import sys
import time

from django.test import Client
from django_scopes import scopes_disabled
from pretix.base.models import Order, Team, User

from pretix_openpos.models import PosSale

BACKEND = "django.contrib.auth.backends.ModelBackend"
failures = []


def check(label, ok, detail=""):
    print(f"{'  ok  ' if ok else ' FAIL '} {label}")
    if not ok:
        failures.append(label)
        if detail:
            print(f"        {detail}")


def client_for(user):
    c = Client()
    c.force_login(user, backend=BACKEND)
    session = c.session
    session["pretix_auth_login_time"] = int(time.time())
    session["pretix_auth_last_used"] = int(time.time())
    session["pretix_auth_long_session"] = True
    session.save()
    return c


with scopes_disabled():
    user = User.objects.filter(is_staff=True).first()
    if not user:
        sys.exit("no staff user; run dev/seed.py first")
    client = client_for(user)

    print("\n-- backend order pages for till sales ------------------------")
    sales = list(PosSale.objects.select_related("order", "event").order_by("-seq")[:10])
    if not sales:
        print("        no till sales yet; run dev/smoke_test.py first")
    cash_seen = False
    for sale in sales:
        if not sale.order_id:
            continue
        order = Order.objects.get(pk=sale.order_id)
        url = f"/control/event/{sale.event.organizer.slug}/{sale.event.slug}/orders/{order.code}/"
        response = client.get(url)
        kind = sale.payment_type
        cash_seen = cash_seen or kind == "cash"
        check(f"order {order.code} ({kind}) renders", response.status_code == 200,
              f"HTTP {response.status_code} on {url}")
        if response.status_code == 200 and kind == "cash":
            body = response.content.decode(errors="replace")
            check(f"order {order.code} shows the change given",
                  "Change given" in body or "Rendu" in body or "journal" in body.lower(),
                  "payment_control block missing from the page")
    if sales and not cash_seen:
        print("        (no cash sale among the last 10 — the money filter path was not exercised)")

    print("\n-- plugin screens, per permission ----------------------------")
    event = sales[0].event if sales else None
    if event:
        base = f"/control/event/{event.organizer.slug}/{event.slug}/openpos/"
        for label, path, permission in (
            ("settings", base, "event.settings.general:write"),
            ("prices", base + "prices/", "event.items:write"),
            ("sales", base + "sales/", "event.orders:read"),
        ):
            check(f"{label} renders for an admin", client.get(path).status_code == 200)

        volunteer, _ = User.objects.get_or_create(
            email="openpos-permcheck@localhost", defaults={"is_staff": False}
        )
        volunteer.is_staff = False
        volunteer.save()
        team, _ = Team.objects.get_or_create(
            organizer=event.organizer,
            name="openpos permission check",
            defaults={"all_events": True, "all_event_permissions": False,
                      "limit_event_permissions": {}},
        )
        team.members.add(volunteer)
        for label, path, permission in (
            ("settings", base, "event.settings.general:write"),
            ("prices", base + "prices/", "event.items:write"),
            ("sales", base + "sales/", "event.orders:read"),
        ):
            team.limit_event_permissions = {permission: True}
            team.save(update_fields=["limit_event_permissions"])
            granted = client_for(volunteer).get(path).status_code
            team.limit_event_permissions = {}
            team.save(update_fields=["limit_event_permissions"])
            denied = client_for(volunteer).get(path).status_code
            check(f"{label} needs exactly {permission}",
                  granted == 200 and denied != 200,
                  f"with={granted} without={denied}")

print()
if failures:
    print(f"{len(failures)} check(s) failed")
    sys.exit(1)
print("all checks passed")
