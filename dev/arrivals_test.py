"""
Prove the Arrivals pages count the right scans — and only those.

    docker compose exec -T pretix python -m pretix shell < dev/arrivals_test.py

Seeds its own organizer ("arrtest") so no other dev data can leak into the
totals, with three past events whose entry scans form a known histogram, plus
one of everything the organizer's hour-of-day chart must ignore: an
auto-check-in, a test-mode order, exit scans, a failed scan, and a future
event. Every leak would change the grand total, so asserting one number audits
every filter at once. Then each evening's own page, on PostgreSQL: the
arrivals it charts add up to the tickets it says were admitted.

Idempotent the blunt way: if the organizer exists, the fixture is assumed
seeded and only the assertions run. Change the fixture -> bump ORG_SLUG.
"""
import re
import sys
import time
import zoneinfo
from datetime import datetime, timedelta
from decimal import Decimal

from django.test import Client
from django.utils.timezone import now
from django_scopes import scopes_disabled
from pretix.base.models import (
    Checkin, CheckinList, Event, Item, Order, OrderPosition, Organizer, Team,
    User,
)

ORG_SLUG = "arrtest"
TZ = zoneinfo.ZoneInfo("Europe/Paris")
BACKEND = "django.contrib.auth.backends.ModelBackend"

# hour of day (event-local) -> number of entry scans. The May event crosses
# midnight, which is exactly the case an hour-of-day histogram must survive.
EVENTS = {
    "arr-mai": {"days_ago": 100, "scans": {19: 3, 20: 8, 21: 12, 22: 7, 23: 4, 0: 2}},
    "arr-juin": {"days_ago": 70, "scans": {21: 9, 22: 10, 23: 6, 1: 3}},
    "arr-juillet": {"days_ago": 40, "scans": {18: 4, 19: 10, 20: 6}},
}
TOTAL = sum(sum(e["scans"].values()) for e in EVENTS.values())  # 84
MAI_TOTAL = sum(EVENTS["arr-mai"]["scans"].values())  # 36

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


def local_dt(base_day, hour):
    # Scans at 0:00/1:00 belong to the small hours after the party started,
    # not to the morning before it.
    day = base_day + timedelta(days=1 if hour < 12 else 0)
    return datetime(day.year, day.month, day.day, hour, 30, tzinfo=TZ)


with scopes_disabled():
    existed = Organizer.objects.filter(slug=ORG_SLUG).exists()
    if not existed:
        organizer = Organizer.objects.create(name="Arrivals Test", slug=ORG_SLUG)
        organizer.create_default_sales_channels()
        web = organizer.sales_channels.get(identifier="web")

        def build_event(slug, days_ago, live_scans, tz=TZ):
            base_day = (now() - timedelta(days=days_ago)).date()
            start = datetime(base_day.year, base_day.month, base_day.day, 19, 0, tzinfo=tz)
            event = Event.objects.create(
                organizer=organizer, slug=slug, name=slug, currency="EUR",
                date_from=start, date_to=start + timedelta(hours=8), live=True,
                plugins="pretix_openpos",
            )
            event.settings.set("timezone", "Europe/Paris")
            item = Item.objects.create(
                event=event, name="Billet", default_price=Decimal("10.00"),
                admission=True,
            )
            clist = CheckinList.objects.create(event=event, name="Porte", all_products=True)
            order = Order.objects.create(
                event=event, status=Order.STATUS_PAID, email="arr@test.local",
                datetime=start, expires=now() + timedelta(days=365),
                total=Decimal("0.00"), sales_channel=web, locale="en",
            )
            positions = []
            positionid = 0
            for hour, count in live_scans.items():
                for _ in range(count):
                    positionid += 1
                    pos = OrderPosition.objects.create(
                        order=order, item=item, price=Decimal("0.00"),
                        positionid=positionid,
                    )
                    Checkin.objects.create(
                        position=pos, list=clist, type=Checkin.TYPE_ENTRY,
                        datetime=local_dt(base_day, hour),
                    )
                    positions.append(pos)
            return event, item, clist, order, positions, base_day

        for slug, spec in EVENTS.items():
            event, item, clist, order, positions, base_day = build_event(
                slug, spec["days_ago"], spec["scans"]
            )
            if slug == "arr-mai":
                # Everything the page must NOT count, all in one event, all at
                # hours (12h-15h) where no real scan ever lands.
                def extra_pos(pid):
                    return OrderPosition.objects.create(
                        order=order, item=item, price=Decimal("0.00"), positionid=pid,
                    )

                Checkin.objects.create(  # checked in at payment, nobody walked in
                    position=extra_pos(900), list=clist, type=Checkin.TYPE_ENTRY,
                    auto_checked_in=True, datetime=local_dt(base_day, 12),
                )
                test_order = Order.objects.create(
                    event=event, status=Order.STATUS_PAID, email="arr@test.local",
                    datetime=order.datetime, expires=now() + timedelta(days=365),
                    total=Decimal("0.00"), sales_channel=web, locale="en",
                    testmode=True,
                )
                test_pos = OrderPosition.objects.create(
                    order=test_order, item=item, price=Decimal("0.00"), positionid=1,
                )
                Checkin.objects.create(
                    position=test_pos, list=clist, type=Checkin.TYPE_ENTRY,
                    datetime=local_dt(base_day, 13),
                )
                Checkin.all.create(  # a scan that was refused at the door
                    position=extra_pos(901), list=clist, type=Checkin.TYPE_ENTRY,
                    successful=False, datetime=local_dt(base_day, 14),
                )
                for pos in positions[:5]:  # exits are not arrivals
                    Checkin.objects.create(
                        position=pos, list=clist, type=Checkin.TYPE_EXIT,
                        datetime=local_dt(base_day, 23),
                    )

        # A future event with scans (pre-checked guests at a preview, say):
        # not a *past* event, so none of it belongs on the page.
        build_event("arr-futur", -30, {15: 5})

        admin = User.objects.create_user(f"admin@{ORG_SLUG}.local", "arrtest")
        full_team = Team.objects.create(
            organizer=organizer, name="Arr full", all_events=True,
            all_event_permissions=True, all_organizer_permissions=True,
        )
        full_team.members.add(admin)

        limited = User.objects.create_user(f"limited@{ORG_SLUG}.local", "arrtest")
        limited_team = Team.objects.create(
            organizer=organizer, name="Arr limited", all_events=False,
            limit_event_permissions={"event.orders:read": True},
        )
        limited_team.limit_events.set([Event.objects.get(organizer=organizer, slug="arr-mai")])
        limited_team.members.add(limited)

        no_orders = User.objects.create_user(f"noorders@{ORG_SLUG}.local", "arrtest")
        no_orders_team = Team.objects.create(
            organizer=organizer, name="Arr no-orders", all_events=False,
            all_organizer_permissions=True,
        )
        no_orders_team.members.add(no_orders)
        print(f"seeded organizer {ORG_SLUG} ({TOTAL} countable scans)")
    else:
        print(f"organizer {ORG_SLUG} already seeded, running assertions only")

    admin = User.objects.get(email=f"admin@{ORG_SLUG}.local")
    limited = User.objects.get(email=f"limited@{ORG_SLUG}.local")
    no_orders = User.objects.get(email=f"noorders@{ORG_SLUG}.local")
    url = f"/control/organizer/{ORG_SLUG}/openpos/arrivals/"

    print("\n-- the page itself -------------------------------------------")
    response = client_for(admin).get(url)
    check("arrivals page renders", response.status_code == 200,
          f"HTTP {response.status_code}")
    body = response.content.decode(errors="replace") if response.status_code == 200 else ""

    tiles = re.findall(r'<div class="op-num[^"]*">([^<]+)</div>', body)
    check(f"grand total is {TOTAL} (every exclusion filter audited at once)",
          str(TOTAL) in tiles, f"tiles: {tiles}")
    # 21h holds 12 (mai) + 9 (juin) = 21 scans, ahead of 22h's 17.
    check("busiest hour is 21:00–22:00", "21:00–22:00" in tiles, f"tiles: {tiles}")
    check("quietest active hour is 00:00–01:00", "00:00–01:00" in tiles,
          f"tiles: {tiles}")
    check("all three past events listed",
          all(slug in body for slug in ("arr-mai", "arr-juin", "arr-juillet")))
    check("future event not listed", "arr-futur" not in body)
    check("hourly table carries the midnight bucket", "00:00–01:00" in body)

    print("\n-- French locale ---------------------------------------------")
    # Django localizes bare floats in templates: under fr, 507.8 renders as
    # "507,8", and inside an SVG attribute that comma is a coordinate LIST —
    # every label shows its first glyph in place and piles the rest at the
    # chart edge. Found in production, where the real account is French; the
    # geometry must therefore reach the template pre-formatted, never as
    # floats. The HTML-level signature of the bug is a decimal comma inside
    # an attribute value.
    admin.locale = "fr"
    admin.save(update_fields=["locale"])
    try:
        response = client_for(admin).get(url)
        check("page renders for a French-locale user", response.status_code == 200,
              f"HTTP {response.status_code}")
        body_fr = response.content.decode(errors="replace") if response.status_code == 200 else ""
        commas = re.findall(r'\S+="\d+,\d+"', body_fr)
        check("no SVG attribute carries a localized decimal comma", not commas,
              f"e.g. {commas[:3]}")
        check("x-axis labels survive in the markup", "22:00" in body_fr)
    finally:
        admin.locale = "en"
        admin.save(update_fields=["locale"])

    print("\n-- permission scoping ----------------------------------------")
    response = client_for(limited).get(url)
    body = response.content.decode(errors="replace") if response.status_code == 200 else ""
    tiles = re.findall(r'<div class="op-num[^"]*">([^<]+)</div>', body)
    check("limited team gets the page", response.status_code == 200,
          f"HTTP {response.status_code}")
    check(f"limited team sees only its event's total ({MAI_TOTAL})",
          str(MAI_TOTAL) in tiles, f"tiles: {tiles}")
    check("limited team does not see the other events", "arr-juin" not in body)

    response = client_for(no_orders).get(url)
    check("a team without orders:read is refused", response.status_code == 403,
          f"HTTP {response.status_code}")

    print("\n-- one evening -----------------------------------------------")
    # The organizer's table leads to each evening's own page, and both read
    # the door's own calculation. Unlike the hour-of-day chart, that one counts
    # tickets the way pretix and the door screen do, so the automatic
    # check-in and the test-mode ticket of the May event are among its
    # admitted: what matters is that the chart and the figure agree.
    from pretix_openpos.attendance import arrivals, attendance

    body = client_for(admin).get(url).content.decode(errors="replace")
    check("each past evening links to its own page",
          all(f"/control/event/{ORG_SLUG}/{slug}/openpos/arrivals/" in body for slug in EVENTS))
    mai = Event.objects.get(organizer__slug=ORG_SLUG, slug="arr-mai")
    mai_list = mai.checkin_lists.get()
    figures = attendance(mai_list)
    timeline = arrivals(mai_list)
    check("arrivals add up to the admitted figure",
          timeline["total"] == figures["entered"],
          f"{timeline['total']} arrivals, {figures['entered']} admitted")
    check("exits make the room's fullest point known", timeline["room"] is not None)

    event_url = f"/control/event/{ORG_SLUG}/arr-mai/openpos/arrivals/"
    response = client_for(admin).get(event_url)
    check("evening page renders", response.status_code == 200, f"HTTP {response.status_code}")
    body = response.content.decode(errors="replace") if response.status_code == 200 else ""
    tiles = re.findall(r'<div class="op-num[^"]*">([^<]+)</div>', body)
    check(f"admitted tile reads {figures['entered']}",
          tiles[:1] == [str(figures["entered"])], f"tiles: {tiles}")
    # 12 people at 21:30, the most in any quarter of an hour of that night.
    check("busiest quarter is 21:30–21:45", "21:30–21:45" in tiles, f"tiles: {tiles}")

    admin.locale = "fr"
    admin.save(update_fields=["locale"])
    try:
        response = client_for(admin).get(event_url)
        body_fr = response.content.decode(errors="replace") if response.status_code == 200 else ""
        commas = re.findall(r'\S+="\d+,\d+"', body_fr)
        check("evening page renders in French with no decimal comma in its chart",
              response.status_code == 200 and not commas,
              f"HTTP {response.status_code}, e.g. {commas[:3]}")
    finally:
        admin.locale = "en"
        admin.save(update_fields=["locale"])

    check("limited team gets its own evening",
          client_for(limited).get(event_url).status_code == 200)
    status = client_for(limited).get(f"/control/event/{ORG_SLUG}/arr-juin/openpos/arrivals/").status_code
    check("limited team is kept out of another evening", status in (403, 404), f"HTTP {status}")
    status = client_for(no_orders).get(event_url).status_code
    check("a team without orders:read is kept out of an evening", status in (403, 404),
          f"HTTP {status}")

    print("\n-- navigation ------------------------------------------------")
    response = client_for(admin).get(f"/control/organizer/{ORG_SLUG}/")
    check("organizer page links to the arrivals screen",
          response.status_code == 200 and "/openpos/arrivals/" in response.content.decode(errors="replace"),
          f"HTTP {response.status_code}")
    response = client_for(admin).get(f"/control/event/{ORG_SLUG}/arr-mai/")
    check("event page links to its arrivals screen",
          response.status_code == 200 and event_url in response.content.decode(errors="replace"),
          f"HTTP {response.status_code}")

print()
if failures:
    print(f"{len(failures)} FAILURE(S): {failures}")
    sys.exit(1)
print("all arrivals checks passed")
