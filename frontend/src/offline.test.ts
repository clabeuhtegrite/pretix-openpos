import { describe, expect, it } from "vitest";

import { indexSnapshot, offlineVerdict } from "./offline";
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
