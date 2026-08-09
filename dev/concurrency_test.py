#!/usr/bin/env python3
"""
Hammer the till from several threads at once and check the journal holds.

    OPENPOS_BASE=http://localhost:8001 python3 dev/concurrency_test.py <token> [n]

This exists because PosSale.record() claims its sequence number optimistically
and lets the unique constraint arbitrate, retrying inside a savepoint. That
pattern is forgiving on SQLite and unforgiving on PostgreSQL, where an
IntegrityError poisons the surrounding transaction unless the savepoint is
placed correctly — so it has to be exercised on the engine that actually runs in
production.

What must hold afterwards: every sale committed, sequence numbers gapless and
unique, and no two sales sharing an order.
"""
import json
import os
import sys
import urllib.error
import urllib.request
import uuid
from concurrent.futures import ThreadPoolExecutor

BASE = os.environ.get("OPENPOS_BASE", "http://localhost:8000").rstrip("/") + "/api/v1"
ORG = os.environ.get("OPENPOS_ORG", "demo")
EVENT = os.environ.get("OPENPOS_EVENT", "festival")


def call(method, path, body=None, token=None):
    request = urllib.request.Request(
        f"{BASE}{path}",
        data=json.dumps(body).encode() if body is not None else None,
        method=method,
    )
    request.add_header("Content-Type", "application/json")
    if token:
        request.add_header("Authorization", f"Device {token}")
    try:
        with urllib.request.urlopen(request, timeout=60) as response:
            return response.status, json.loads(response.read() or b"null")
    except urllib.error.HTTPError as e:
        raw = e.read()
        try:
            return e.code, json.loads(raw or b"null")
        except json.JSONDecodeError:
            return e.code, raw.decode(errors="replace")[:300]


def main():
    if len(sys.argv) < 2:
        sys.exit("usage: concurrency_test.py <device-token-or-init-token> [n]")
    token = sys.argv[1]
    parallel = int(sys.argv[2]) if len(sys.argv) > 2 else 24

    # Accept either a device token or a fresh initialization token.
    status, body = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/config/", token=token)
    if status != 200:
        status, body = call("POST", "/device/initialize", {
            "token": token, "hardware_brand": "Test", "hardware_model": "load",
            "os_name": "Web", "os_version": "1", "software_brand": "pretix-openpos",
            "software_version": "0.1.0",
        })
        if status != 200:
            sys.exit(f"could not authenticate: HTTP {status}: {body}")
        token = body["api_token"]

    status, catalog = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/catalog/", token=token)
    if status != 200:
        sys.exit(f"catalog unavailable: HTTP {status}: {catalog}")
    item = next(
        i for c in catalog["categories"] for i in c["items"] if not i["variations"]
    )

    status, before = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/summary/", token=token)
    print(f"before : {before['event']}")
    print(f"firing {parallel} concurrent checkouts of 1x {item['name']}…")

    def sell(_index):
        return call("POST", f"/organizers/{ORG}/events/{EVENT}/openpos/checkout/", {
            "idempotency_key": str(uuid.uuid4()),
            "positions": [{"item": item["id"], "count": 1}],
            "payment_type": "cash",
            "cash_given": item["price"],
            "cashier": "load",
        }, token)

    with ThreadPoolExecutor(max_workers=parallel) as pool:
        results = list(pool.map(sell, range(parallel)))

    created = [body for status, body in results if status == 201]
    failed = [(status, body) for status, body in results if status != 201]

    seqs = sorted(sale["journal_seq"] for sale in created)
    orders = [sale["order"]["code"] for sale in created]

    print()
    print(f"created        : {len(created)}/{parallel}")
    print(f"failed         : {len(failed)}")
    for status, body in failed[:5]:
        print(f"    HTTP {status}: {str(body)[:200]}")
    print(f"sequences      : {seqs[0]}..{seqs[-1]}" if seqs else "sequences      : none")
    print(f"unique seqs    : {len(set(seqs))} (expected {len(created)})")
    print(f"gapless        : {seqs == list(range(seqs[0], seqs[0] + len(seqs)))}" if seqs else "")
    print(f"unique orders  : {len(set(orders))} (expected {len(created)})")

    status, after = call("GET", f"/organizers/{ORG}/events/{EVENT}/openpos/summary/", token=token)
    print(f"after  : {after['event']}")

    # Two different things can go wrong, and conflating them makes the result
    # useless. A refused request is a capacity problem — the SQLite dev stack
    # serialises writers and answers "database is locked" under load, where
    # PostgreSQL does not. A journal that does not add up is a correctness
    # problem, and it is the only one this test exists to catch: what matters is
    # that whatever DID commit left a gapless, unique, unbroken sequence.
    integrity = (
        bool(seqs)
        and len(set(seqs)) == len(created)
        and seqs == list(range(seqs[0], seqs[0] + len(seqs)))
        and len(set(orders)) == len(created)
    )
    print()
    if not integrity:
        print("JOURNAL BROKEN — committed sales do not form a clean sequence")
        sys.exit(1)
    if failed:
        print(f"JOURNAL INTACT for the {len(created)} sales that committed, "
              f"but {len(failed)} request(s) were refused.")
        print("On SQLite that is the writer lock, not a defect; re-run against "
              "PostgreSQL to exercise real concurrency.")
        sys.exit(2)
    print("JOURNAL INTACT")
    sys.exit(0)


if __name__ == "__main__":
    main()
