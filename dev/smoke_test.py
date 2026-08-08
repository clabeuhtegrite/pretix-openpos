#!/usr/bin/env python3
"""
End-to-end check of the POS API against the local development stack.

    docker compose exec pretix python -m pretix shell < dev/seed.py   # prints an init token
    python3 dev/smoke_test.py <init-token>

Pairs a device, reads the catalogue, sells something for cash, replays the exact
same request to prove idempotency, and prints the takings. Standard library only.
"""
import json
import sys
import urllib.error
import urllib.request
import uuid

BASE = "http://localhost:8000/api/v1"
ORG = "demo"
EVENT = "festival"

failures = []


def call(method, path, body=None, token=None):
    url = f"{BASE}{path}"
    data = json.dumps(body).encode() if body is not None else None
    request = urllib.request.Request(url, data=data, method=method)
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Device {token}")
    try:
        with urllib.request.urlopen(request) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"null")
        except json.JSONDecodeError:
            return e.code, raw.decode(errors="replace")[:500]


def check(label, condition, detail=""):
    print(f"{'  ok  ' if condition else ' FAIL '} {label}")
    if not condition:
        failures.append(f"{label} {detail}".strip())
        if detail:
            print(f"        {detail}")


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: smoke_test.py <device-initialization-token>")
    init_token = sys.argv[1]

    print("\n-- pairing -------------------------------------------------")
    status, body = call("POST", "/device/initialize", {
        "token": init_token,
        "hardware_brand": "Apple",
        "hardware_model": "iPad",
        "os_name": "iOS",
        "os_version": "18.0",
        "software_brand": "pretix-openpos",
        "software_version": "0.1.0",
    })
    check("device initialize", status == 200, f"HTTP {status}: {body}")
    if status != 200:
        return report()
    token = body["api_token"]
    print(f"        serial {body['unique_serial']}")

    print("\n-- config --------------------------------------------------")
    status, config = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/config/", token=token)
    check("config reachable", status == 200, f"HTTP {status}: {config}")
    if status == 200:
        check("currency present", config.get("event", {}).get("currency") == "EUR", str(config))
        check("check-in configured", config.get("checkin", {}).get("enabled") is True, str(config.get("checkin")))

    print("\n-- catalogue -----------------------------------------------")
    status, catalog = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/catalog/", token=token)
    check("catalog reachable", status == 200, f"HTTP {status}: {catalog}")
    if status != 200:
        return report()

    items = [i for c in catalog["categories"] for i in c["items"]]
    names = {i["name"]: i for i in items}
    print(f"        {len(catalog['categories'])} categories, {len(items)} products")
    for category in catalog["categories"]:
        for item in category["items"]:
            price = item["price"] or "/".join(v["price"] for v in item["variations"])
            print(f"        - [{category['name']}] {item['name']}: {price} (avail {item['available']})")

    check("POS-only product listed", "Entrée sur place" in names, str(sorted(names)))
    check("variations exposed", len(names.get("T-shirt", {}).get("variations", [])) == 3,
          str(names.get("T-shirt")))

    print("\n-- cash sale -----------------------------------------------")
    full = names.get("Plein tarif")
    beer = names.get("Bière")
    if not full or not beer:
        return report()

    key = str(uuid.uuid4())
    payload = {
        "idempotency_key": key,
        "positions": [
            {"item": full["id"], "count": 2},
            {"item": beer["id"], "count": 3},
        ],
        "payment_type": "cash",
        "cash_given": "50.00",
        "cashier": "Alice",
    }
    status, sale = call("POST", f"/organizers/{ORG}/events/{EVENT}/openpos/checkout/", payload, token)
    check("checkout accepted", status == 201, f"HTTP {status}: {sale}")
    if status != 201:
        return report()

    expected_total = 2 * float(full["price"]) + 3 * float(beer["price"])
    check("total computed server-side", float(sale["order"]["total"]) == expected_total,
          f"got {sale['order']['total']}, expected {expected_total:.2f}")
    check("change correct", float(sale["cash_change"]) == 50.00 - expected_total,
          f"got {sale['cash_change']}")
    check("checked in immediately", sale.get("checked_in") == 5,
          f"checked_in={sale.get('checked_in')} errors={sale.get('checkin_errors')}")
    print(f"        order {sale['order']['code']}, journal #{sale['journal_seq']}")

    print("\n-- idempotency ---------------------------------------------")
    status, replay = call("POST", f"/organizers/{ORG}/events/{EVENT}/openpos/checkout/", payload, token)
    check("replay returns 200", status == 200, f"HTTP {status}: {replay}")
    check("replay is flagged", replay.get("replayed") is True, str(replay))
    check("replay is the same order", replay.get("order", {}).get("code") == sale["order"]["code"],
          f"{replay.get('order', {}).get('code')} vs {sale['order']['code']}")

    print("\n-- price is not client-controlled --------------------------")
    status, spoof = call("POST", f"/organizers/{ORG}/events/{EVENT}/openpos/checkout/", {
        "idempotency_key": str(uuid.uuid4()),
        "positions": [{"item": full["id"], "count": 1, "price": "0.01"}],
        "payment_type": "card",
    }, token)
    check("price field ignored", status == 201 and float(spoof["order"]["total"]) == float(full["price"]),
          f"HTTP {status}: total {spoof.get('order', {}).get('total')} vs {full['price']}")

    print("\n-- takings -------------------------------------------------")
    status, summary = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/summary/", token=token)
    check("summary reachable", status == 200, f"HTTP {status}: {summary}")
    if status == 200:
        print(f"        this till : {summary['device']}")
        print(f"        all tills : {summary['event']}")
        check("cash total recorded", float(summary["device"]["cash"]) == expected_total,
              str(summary["device"]))

    return report()


def report():
    print()
    if failures:
        print(f"{len(failures)} check(s) failed:")
        for failure in failures:
            print(f"  - {failure}")
        sys.exit(1)
    print("all checks passed")
    sys.exit(0)


if __name__ == "__main__":
    main()
