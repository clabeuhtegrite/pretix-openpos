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
The organizer's screens as well: the card readers page holds the SumUp account,
so it asks for the organizer settings permission, not the devices one.
"""
import csv
import io
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

    print("\n-- saving the settings form ---------------------------------")
    # The form does more than store its own fields: ticking "issue invoices for
    # till sales" edits pretix' own list of invoiced sales channels, and that is
    # what decides whether cancelling a sale can produce a credit note. A silent
    # failure here would only be noticed the night someone needs an avoir.
    if sales:
        event = sales[0].event
        settings_url = f"/control/event/{event.organizer.slug}/{event.slug}/openpos/"
        before = event.settings.get("invoice_generate_sales_channels", as_type=list) or []
        # Posting the form writes every field it carries, so the configured
        # check-in list has to be sent back as it was — otherwise this test
        # quietly repoints the till's door list at whatever comes first
        # alphabetically, and the next person to run it wonders why.
        before_list = event.settings.get("openpos_checkin_list") or ""
        listed = event.checkin_lists.filter(pk=before_list).first() or event.checkin_lists.first()
        response = client.post(settings_url, {
            "openpos_checkin_list": str(listed.pk) if listed else "",
            "openpos_invoices": "on",
        })
        check("settings form saves", response.status_code in (200, 302),
              f"HTTP {response.status_code}")
        event.settings.flush()
        after = event.settings.get("invoice_generate_sales_channels", as_type=list) or []
        check("ticking it adds the POS channel to the invoiced ones", "openpos" in after, str(after))
        check("and records the plugin's own switch",
              event.settings.get("openpos_invoices", as_type=bool) is True,
              str(event.settings.get("openpos_invoices")))
        check("it leaves the other channels alone",
              all(c in after for c in before if c != "openpos"), f"{before} -> {after}")

        response = client.post(settings_url, {
            "openpos_checkin_list": str(listed.pk) if listed else "",
        })
        event.settings.flush()
        after_off = event.settings.get("invoice_generate_sales_channels", as_type=list) or []
        check("unticking it removes only that channel",
              "openpos" not in after_off and "web" in after_off, str(after_off))
        check("and the switch says so",
              event.settings.get("openpos_invoices", as_type=bool) is False,
              str(event.settings.get("openpos_invoices")))

        # An event nobody has configured invoices its till sales: that is the
        # whole point of the default, and the reason a credit note exists to be
        # issued when a sale is cancelled.
        from pretix_openpos.invoicing import pos_invoices_enabled
        event.settings.delete("openpos_invoices")
        event.settings.flush()
        check("an untouched event invoices till sales by default",
              pos_invoices_enabled(event) is True, "default is off")

        # Leave the dev event exactly as it was found.
        event.settings.set("invoice_generate_sales_channels", before or ["web"])
        if before_list:
            event.settings.set("openpos_checkin_list", before_list)

    print("\n-- plugin screens, per permission ----------------------------")
    event = sales[0].event if sales else None
    if event:
        base = f"/control/event/{event.organizer.slug}/{event.slug}/openpos/"
        for label, path, permission in (
            ("settings", base, "event.settings.general:write"),
            ("categories", base + "categories/", "event.items:write"),
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
            ("categories", base + "categories/", "event.items:write"),
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

        print("\n-- journal export -------------------------------------------")
        response = client.get(base + "sales/?export=csv")
        check("the journal exports as CSV",
              response.status_code == 200
              and response["Content-Type"].startswith("text/csv"),
              f"HTTP {response.status_code} {response.get('Content-Type')}")
        if response.status_code == 200:
            content = b"".join(response.streaming_content).decode("utf-8-sig")
            lines = [line for line in content.splitlines() if line]
            expected_rows = PosSale.objects.filter(event=event).count()
            check("one line per journal entry plus the header",
                  len(lines) == expected_rows + 1,
                  f"{len(lines)} lines vs {expected_rows} entries + header")
            check("the columns a treasurer needs come first",
                  lines[0].startswith("seq;kind;datetime;order"), lines[0][:80])
            # Text that could start a spreadsheet formula goes out behind an
            # apostrophe; the amounts must not, negative ones included, or the
            # column no longer adds up.
            rows = list(csv.DictReader(io.StringIO(content), delimiter=";"))
            reversals = [row for row in rows if row["kind"] == "cancellation"]
            check("a cancellation's amount is still a number",
                  all(row["total"].startswith("-") for row in reversals),
                  str([row["total"] for row in reversals][:5]))
            check("no text cell starts a formula",
                  not any(row[column][:1] in ("=", "+", "-", "@")
                          for row in rows for column in ("till", "cashier", "reason", "drawer")),
                  "a text cell went out unguarded")

    print("\n-- organizer screens, per permission -------------------------")
    # The till devices screen and the cash drawers are the devices permission;
    # the card readers page is the organizer's settings, since it holds the
    # payment account's key. Each checked with exactly its permission and
    # without it, as the event screens above.
    if event:
        organizer = event.organizer
        org_base = f"/control/organizer/{organizer.slug}/openpos/"
        for label, path in (("devices", org_base + "devices/"), ("card readers", org_base + "sumup/"),
                            ("cash drawers", org_base + "drawers/")):
            check(f"{label} renders for an admin", client.get(path).status_code == 200)

        keeper, _ = User.objects.get_or_create(
            email="openpos-orgcheck@localhost", defaults={"is_staff": False}
        )
        keeper.is_staff = False
        keeper.save()
        org_team, _ = Team.objects.get_or_create(
            organizer=organizer,
            name="openpos organizer permission check",
            defaults={"all_events": True, "all_event_permissions": False,
                      "limit_event_permissions": {}, "all_organizer_permissions": False,
                      "limit_organizer_permissions": {}},
        )
        org_team.members.add(keeper)

        def as_keeper(permissions, path):
            org_team.limit_organizer_permissions = dict.fromkeys(permissions, True)
            org_team.save(update_fields=["limit_organizer_permissions"])
            return client_for(keeper).get(path).status_code

        devices_only = ["organizer.devices:write"]
        settings_only = ["organizer.settings.general:write"]
        check("devices needs exactly organizer.devices:write",
              as_keeper(devices_only, org_base + "devices/") == 200
              and as_keeper([], org_base + "devices/") != 200)
        check("card readers need organizer.settings.general:write",
              as_keeper(settings_only, org_base + "sumup/") == 200)
        check("and the devices permission alone does not open them",
              as_keeper(devices_only, org_base + "sumup/") != 200)
        page = client_for(keeper).get(org_base + "devices/").content.decode(errors="replace")
        check("nor shows the link to them", org_base + "sumup/" not in page)
        org_team.limit_organizer_permissions = {}
        org_team.save(update_fields=["limit_organizer_permissions"])

        # The device the smoke test paired has called the API since.
        page = client.get(org_base + "devices/").content.decode(errors="replace")
        check("the devices screen says when a device was last heard from",
              "Last contact" in page or "Dernier contact" in page,
              "no last contact on the page: run dev/smoke_test.py first")

    print("\n-- the shell and its headers ---------------------------------")
    # Unauthenticated on purpose: the shell is public, the CSP is what keeps a
    # public page from being a way at the device token in localStorage.
    anonymous = Client()
    response = anonymous.get("/openpos/")
    check("the shell renders unauthenticated", response.status_code == 200,
          f"HTTP {response.status_code}")
    check("and locks itself to same-origin",
          "default-src 'self'" in response.get("Content-Security-Policy", ""),
          str(response.get("Content-Security-Policy"))[:120])

print()
if failures:
    print(f"{len(failures)} check(s) failed")
    sys.exit(1)
print("all checks passed")
