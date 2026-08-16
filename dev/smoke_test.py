#!/usr/bin/env python3
"""
End-to-end check of the POS API against the local development stack.

    docker compose exec pretix python -m pretix shell < dev/seed.py   # prints an init token
    python3 dev/smoke_test.py <init-token>

Pairs a device, reads the catalogue, sells something for cash, replays the exact
same request to prove idempotency, and prints the takings. Standard library only.
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid

# Override to point at another instance, e.g. the production image running on
# PostgreSQL rather than the SQLite dev stack:
#   OPENPOS_BASE=http://localhost:8001 python3 dev/smoke_test.py <token>
BASE = os.environ.get("OPENPOS_BASE", "http://localhost:8000").rstrip("/") + "/api/v1"
ORG = os.environ.get("OPENPOS_ORG", "demo")
EVENT = os.environ.get("OPENPOS_EVENT", "festival")

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
    serial = body["unique_serial"]
    print(f"        serial {serial}")

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

    # Head count before selling anything, so the checks further down can be
    # differential. The dev database accumulates across runs — and carries
    # check-ins from before merch was excluded from the door — so an absolute
    # figure would only ever assert the history of this SQLite file.
    _, before = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/attendance/", token=token)

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
    # Two admission tickets and three beers: only the tickets are an entry.
    # Checking in the beers would put merch on the door list and make the till
    # announce "let them in" after a pure shop sale.
    check("only admission products checked in", sale.get("checked_in") == 2,
          f"checked_in={sale.get('checked_in')} (expected 2) errors={sale.get('checkin_errors')}")
    print(f"        order {sale['order']['code']}, journal #{sale['journal_seq']}")

    print("\n-- shop-only sale is not an entry ----------------------------")
    soft = names.get("Soft")
    status, merch = call("POST", f"/organizers/{ORG}/events/{EVENT}/openpos/checkout/", {
        "idempotency_key": str(uuid.uuid4()),
        "positions": [{"item": soft["id"], "count": 2}],
        "payment_type": "cash",
        "cash_given": "10.00",
    }, token)
    check("merch checkout accepted", status == 201, f"HTTP {status}: {merch}")
    merch_total = 0.0
    if status == 201:
        check("nobody admitted", merch.get("checked_in") == 0,
              f"checked_in={merch.get('checked_in')}")
        merch_total = 2 * float(soft["price"])

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

    print("\n-- historique de la caisse ---------------------------------")
    status, history = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/history/", token=token)
    check("history reachable", status == 200, f"HTTP {status}: {history}")
    seqs = [line["seq"] for line in history.get("results", [])]
    check("this till's own sales are listed", sale["journal_seq"] in seqs, str(seqs))
    check("history is scoped to this device", history.get("device") == serial,
          f"{history.get('device')} vs {serial}")
    check("a fresh sale can be cancelled",
          all(line["can_cancel"] for line in history["results"] if line["seq"] == sale["journal_seq"]),
          str(history["results"][:2]))

    print("\n-- annulation ----------------------------------------------")
    # The merch sale, deliberately: nobody was admitted on it, so cancelling it
    # cannot disturb the head count the previous section just checked.
    merch_seq = merch.get("journal_seq") if isinstance(merch, dict) else None
    key_cancel = str(uuid.uuid4())
    cancel_body = {"seq": merch_seq, "idempotency_key": key_cancel, "cashier": "Alice",
                   "reason": "smoke test"}
    status, cancelled = (0, "pas de vente de merch à annuler")
    cancelled_cash = 0.0
    if merch_seq:
        status, cancelled = call("POST", f"/organizers/{ORG}/events/{EVENT}/openpos/cancel/", cancel_body, token)
    check("cancel accepted", status == 201, f"HTTP {status}: {cancelled}")
    if status == 201:
        check("the reversal is a new journal line, not an edit",
              cancelled["cancellation"]["seq"] > merch_seq
              and cancelled["cancellation"]["cancels_seq"] == merch_seq,
              str(cancelled["cancellation"]))
        check("the reversal carries the negative amount",
              float(cancelled["cancellation"]["total"]) == -merch_total,
              f"{cancelled['cancellation']['total']} vs {-merch_total:.2f}")
        check("a credit note was issued", bool(cancelled["credit_note"]), str(cancelled))
        check("the money is recorded as refunded", cancelled["refunded"] is True, str(cancelled))
        cancelled_cash = merch_total
        print(f"        avoir {cancelled['credit_note']}, écriture #{cancelled['cancellation']['seq']}")

        # Replaying the exact same request must not cancel a second time.
        status, replayed = call("POST", f"/organizers/{ORG}/events/{EVENT}/openpos/cancel/", cancel_body, token)
        check("replayed cancellation returns the first one", status == 200
              and replayed["replayed"] is True
              and replayed["cancellation"]["seq"] == cancelled["cancellation"]["seq"],
              f"HTTP {status}: {replayed}")

        # And a second, genuinely new attempt must be refused.
        status, again = call("POST", f"/organizers/{ORG}/events/{EVENT}/openpos/cancel/", {
            "seq": merch_seq, "idempotency_key": str(uuid.uuid4()),
        }, token)
        check("cancelling twice is refused", status == 400, f"HTTP {status}: {again}")

        status, history2 = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/history/", token=token)
        line = next((li for li in history2["results"] if li["seq"] == merch_seq), None)
        check("the cancelled sale is still in the journal", line is not None, str(history2)[:200])
        if line:
            check("it is now flagged as cancelled, not removed",
                  line["cancelled"] is True and line["can_cancel"] is False, str(line))

    print("\n-- attendance ----------------------------------------------")
    status, after = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/attendance/", token=token)
    check("attendance reachable", status == 200, f"HTTP {status}: {after}")
    if status == 200 and isinstance(before, dict) and "inside" in before:
        print(f"        {after['inside']} on site, {after['entered']} in, "
              f"{after['not_arrived']} still to come (of {after['expected']})")
        # Three admission tickets were sold since the snapshot — two on the cash
        # sale, one on the card sale — and each walked its holder in as it was
        # sold. Nothing else in between checks anybody in: the merch sale admits
        # nobody and the replay returns the original order without re-entering.
        check("every ticket sold at the till walked in",
              after["inside"] - before["inside"] == 3,
              f"{before['inside']} -> {after['inside']}")
        # The three beers and two softs went through the same tills, and a drink
        # admits nobody: they must not move any figure above.
        check("merch is not a person",
              after["non_admission_entered"] == before["non_admission_entered"],
              f"{before['non_admission_entered']} -> {after['non_admission_entered']}")
        check("the figures add up",
              after["inside"] + after["exited"] == after["entered"]
              and after["entered"] + after["not_arrived"] == after["expected"],
              str(after))
        check("per-product breakdown sums to the total",
              sum(i["inside"] for i in after["items"]) == after["inside"],
              str(after["items"]))

    print("\n-- takings -------------------------------------------------")
    status, summary = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/summary/", token=token)
    check("summary reachable", status == 200, f"HTTP {status}: {summary}")
    if status == 200:
        print(f"        this till : {summary['device']}")
        print(f"        all tills : {summary['event']}")
        # The cancelled sale is netted off here, which is the whole point: the
        # drawer holds what the journal says it holds, cancellations included.
        expected_cash = expected_total + merch_total - cancelled_cash
        check("cash total is net of the cancellation",
              abs(float(summary["device"]["cash"]) - expected_cash) < 0.005,
              f"got {summary['device']['cash']}, expected {expected_cash:.2f}")
        check("the cancellation is counted apart from the sales",
              summary["device"]["cancellations"] == (1 if cancelled_cash else 0)
              and summary["device"]["count"] == 3,
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
