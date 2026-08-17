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
    expect(indexSnapshot(snapshot)?.count).toBe(2);
  });
});
