import { describe, expect, it } from "vitest";

import {
  ADMISSION_MEMORY_MS, admittedOn, indexSnapshot, offlineVerdict, pruneAdmissions, recordAdmission,
} from "./offline";
import type { OfflineSnapshot } from "./types";

const snapshot: OfflineSnapshot = {
  list: { id: 7, name: "Porte A" },
  generated: "2026-08-17T18:00:00Z",
  truncated: false,
  tickets: [
    { secret: "alice-secret", item: 1, name: "Alice", used: false },
    { secret: "bob-secret", item: 2, name: "Bob", used: true },
    { secret: "blocked-secret", item: 1, name: "Chloé", used: false, blocked: true },
    {
      secret: "late-secret",
      item: 1,
      name: "Dan",
      used: false,
      valid_from: "2026-08-17T20:00:00Z",
      valid_until: "2026-08-18T02:00:00Z",
    },
  ],
};

const none = new Set<string>();

describe("offlineVerdict", () => {
  const index = indexSnapshot(snapshot);

  it("admits a known, unused ticket with its holder's name", () => {
    const verdict = offlineVerdict(index, 7, "alice-secret", none);
    expect(verdict.status).toBe("ok");
    expect(verdict.position).toEqual({ item: 1, attendee_name: "Alice" });
  });

  it("refuses a secret the guest list does not know", () => {
    expect(offlineVerdict(index, 7, "forged", none)).toEqual({
      status: "error",
      reason: "invalid",
    });
  });

  it("refuses a ticket already used when the snapshot was taken", () => {
    expect(offlineVerdict(index, 7, "bob-secret", none).reason).toBe("already_redeemed");
  });

  it("refuses a ticket this device admitted since the snapshot", () => {
    const scannedHere = new Set(["alice-secret"]);
    expect(offlineVerdict(index, 7, "alice-secret", scannedHere).reason).toBe(
      "already_redeemed",
    );
  });

  it("refuses a ticket pretix has blocked, as pretix does at every door", () => {
    expect(offlineVerdict(index, 7, "blocked-secret", none).reason).toBe("blocked");
  });

  it("refuses a ticket outside the moments it is valid between", () => {
    const at = (iso: string) => offlineVerdict(index, 7, "late-secret", none, Date.parse(iso));

    expect(at("2026-08-17T19:59:00Z").reason).toBe("invalid_time");
    expect(at("2026-08-18T02:01:00Z").reason).toBe("invalid_time");
  });

  it("admits a ticket that became valid during the dropout", () => {
    // The guest list was taken at six; the ticket opens at eight. Checked on
    // this device's clock when scanned, not when the list was taken.
    const at = Date.parse("2026-08-17T20:30:00Z");
    expect(offlineVerdict(index, 7, "late-secret", none, at).status).toBe("ok");
  });

  it("answers nothing without a snapshot", () => {
    expect(offlineVerdict(indexSnapshot(null), 7, "alice-secret", none).reason).toBe(
      "offline_no_snapshot",
    );
  });

  it("answers nothing from another door's guest list", () => {
    // The operator switched lists during the dropout: the old door's list
    // must not admit people through this one.
    expect(offlineVerdict(index, 8, "alice-secret", none).reason).toBe(
      "offline_no_snapshot",
    );
  });
});

describe("indexSnapshot", () => {
  it("carries the size the footer displays", () => {
    expect(indexSnapshot(snapshot)?.count).toBe(4);
  });
});

describe("what this door has let in", () => {
  const now = Date.parse("2026-08-17T21:00:00Z");

  it("is recorded per list, without touching the record it was given", () => {
    const before = recordAdmission({}, 7, "alice-secret", now);

    const after = recordAdmission(before, 8, "alice-secret", now);

    expect(admittedOn(after, 7)).toEqual(new Set(["alice-secret"]));
    expect(admittedOn(after, 8)).toEqual(new Set(["alice-secret"]));
    expect(admittedOn(before, 8).size).toBe(0);
  });

  it("is what stops the guest list letting the same ticket in twice", () => {
    const admitted = recordAdmission({}, 7, "alice-secret", now);

    expect(offlineVerdict(indexSnapshot(snapshot), 7, "alice-secret", admittedOn(admitted, 7)))
      .toEqual({ status: "error", reason: "already_redeemed" });
  });

  it("is forgotten once the guest list for that door says the ticket is used", () => {
    // pretix has the entry and the list carries it: nothing left to cover.
    const admitted = recordAdmission(recordAdmission({}, 7, "bob-secret", now), 7, "alice-secret", now);

    const pruned = pruneAdmissions(admitted, snapshot, now);

    expect(admittedOn(pruned, 7)).toEqual(new Set(["alice-secret"]));
  });

  it("is kept while a newer list still has the ticket unused", () => {
    // Admitted offline, not sent yet: a list pulled since cannot know.
    const admitted = recordAdmission({}, 7, "alice-secret", now);

    expect(pruneAdmissions(admitted, snapshot, now)).toBe(admitted);
  });

  it("is not forgotten because another door's list has the ticket used", () => {
    const admitted = recordAdmission({}, 8, "bob-secret", now);

    expect(pruneAdmissions(admitted, snapshot, now)).toBe(admitted);
  });

  it("is kept when there is no list to check against", () => {
    const admitted = recordAdmission({}, 7, "bob-secret", now);

    expect(pruneAdmissions(admitted, null, now)).toBe(admitted);
  });

  it("is forgotten after a day and a half, list or no list", () => {
    const admitted = recordAdmission(
      recordAdmission({}, 7, "old-secret", now - ADMISSION_MEMORY_MS - 1),
      8, "recent-secret", now - 1000,
    );

    const pruned = pruneAdmissions(admitted, null, now);

    expect(pruned).toEqual({ 8: { "recent-secret": now - 1000 } });
  });

  it("drops what is not a time at all", () => {
    const damaged = { 7: { "alice-secret": "yesterday" } } as unknown as Record<
      string, Record<string, number>
    >;

    expect(pruneAdmissions(damaged, null, now)).toEqual({});
  });
});
