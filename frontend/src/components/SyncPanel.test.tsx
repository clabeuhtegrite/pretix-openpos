import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { loadFailures, saveFailures, saveQueue } from "../storage";
import type { QueuedCheckin, QueuedSale, SyncReport } from "../types";
import SyncPanel from "./SyncPanel";

/**
 * The screen that makes offline mode safe to use.
 *
 * A queue that drains silently and a queue that has lost a sale look identical
 * from behind a counter. Everything here exists to make them look different:
 * how many are waiting, what the server made of them, and above all what it
 * refused.
 */

function sale(id: string, event = "festival"): QueuedSale {
  return {
    kind: "sale",
    id,
    at: "2026-08-16T22:02:00.000Z",
    event,
    positions: [{ item: 10, variation: null, count: 1, price: "4.00" }],
    chargedTotal: "4.00",
    paymentType: "cash",
    cashGiven: "10.00",
    cashChange: "6.00",
    cashier: "Ana",
    admits: false,
    label: "1× Bière",
  };
}

function checkin(id: string, event = "festival"): QueuedCheckin {
  return {
    kind: "checkin",
    id,
    at: "2026-08-16T22:10:00.000Z",
    event,
    list: 7,
    secret: "abcdef0123456789",
    name: "Alice",
  };
}

const clean: SyncReport = {
  sales: 0, checkins: 0, failed: 0, stranded: 0, offTariff: [], contested: [],
};

function show(props: Partial<Parameters<typeof SyncPanel>[0]> = {}) {
  const onSync = vi.fn();
  const onClose = vi.fn();
  const { container, rerender } = render(
    <SyncPanel
      online
      syncing={false}
      report={null}
      event="festival"
      onSync={onSync}
      onClose={onClose}
      {...props}
    />,
  );
  return { user: userEvent.setup(), container, rerender, onSync, onClose };
}

describe("whether the server is reachable", () => {
  it("says so when it is", () => {
    show();

    expect(screen.getByText(t("offline.online"))).toBeDefined();
  });

  it("says so when it is not", () => {
    show({ online: false });

    expect(screen.getByText(t("offline.offline"))).toBeDefined();
  });
});

describe("what is still held here", () => {
  it("says plainly when there is nothing", () => {
    show();

    expect(screen.getByText(t("offline.nothingPending"))).toBeDefined();
  });

  it("counts sales and check-ins separately", () => {
    // They fail differently on replay, so they are worth counting apart.
    saveQueue([sale("a"), sale("b"), checkin("c")]);

    show();

    expect(screen.getByText(t("offline.pending", { sales: 2, checkins: 1 }))).toBeDefined();
  });

  it("lists a queued sale with what it was and what it cost", () => {
    saveQueue([sale("a")]);

    show();

    expect(screen.getByText("1× Bière")).toBeDefined();
    expect(screen.getByText("4.00")).toBeDefined();
  });

  it("lists a queued check-in by the name on the ticket", () => {
    saveQueue([checkin("c")]);

    show();

    expect(screen.getByText("Alice")).toBeDefined();
  });

  it("falls back to the start of the secret for a ticket with no name", () => {
    saveQueue([{ ...checkin("c"), name: "" }]);

    show();

    expect(screen.getByText("abcdef01")).toBeDefined();
  });

  it("re-reads the queue when a run finishes", () => {
    // Read once, the panel went on listing sales that had just been sent from
    // the button right below it — the exact thing it exists to make visible.
    saveQueue([sale("a")]);
    const { rerender, onSync, onClose } = show();

    saveQueue([]);
    rerender(
      <SyncPanel
        online
        syncing={false}
        report={{ ...clean, sales: 1 }}
        event="festival"
        onSync={onSync}
        onClose={onClose}
      />,
    );

    expect(screen.getByText(t("offline.nothingPending"))).toBeDefined();
  });
});

describe("entries belonging to another event", () => {
  it("are named as such rather than counted as pending", () => {
    // Neither pending nor refused: this till was switched, and "send now" will
    // not shift them however often it is pressed.
    saveQueue([sale("a", "gala")]);

    show();

    expect(screen.getByText(t("offline.stranded", { n: 1, events: "gala" }))).toBeDefined();
    expect(screen.getByText(t("offline.nothingPending"))).toBeDefined();
  });

  it("do not make the send button offer to send them", () => {
    saveQueue([sale("a", "gala")]);

    show();

    expect(screen.getByRole("button", { name: t("offline.sync") })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("what the last run did", () => {
  it("reports the counts", () => {
    show({ report: { ...clean, sales: 3, checkins: 1, failed: 1 } });

    expect(
      screen.getByText(t("offline.lastRun", { sales: 3, checkins: 1, failed: 1 })),
    ).toBeDefined();
  });

  it("names a sale charged at a price that had since moved", () => {
    // The customer paid one figure and the tariff says another. Nobody can put
    // that right from here, but pretending it did not happen is worse.
    show({
      report: {
        ...clean,
        sales: 1,
        offTariff: [{ order: "POS02", item_name: "Bière", charged: "3.50", tariff: "4.00" }],
      },
    });

    expect(
      screen.getByText(
        t("offline.offTariff", {
          order: "POS02", item: "Bière", charged: "3.50", tariff: "4.00",
        }),
      ),
    ).toBeDefined();
  });

  it("names a ticket the server contested on replay", () => {
    // The person is inside either way; the organiser hears about it.
    show({
      report: {
        ...clean,
        checkins: 1,
        contested: [{ name: "Alice", secret: "abc", reason: "already_redeemed" }],
      },
    });

    expect(
      screen.getByText(t("offline.contested", { name: "Alice", reason: "already_redeemed" })),
    ).toBeDefined();
  });
});

describe("what the server refused", () => {
  it("is shown with the reason and the amount that was taken", () => {
    saveFailures([
      { entry: sale("a"), at: "2026-08-16T22:02:00.000Z", message: "not on sale at the till" },
    ]);

    show();

    expect(screen.getByText(t("offline.refused"))).toBeDefined();
    expect(screen.getByText(/1× Bière \(4\.00\)/)).toBeDefined();
    expect(screen.getByText(/not on sale at the till/)).toBeDefined();
  });

  it("names a refused check-in by the start of its secret", () => {
    saveFailures([
      { entry: checkin("c"), at: "2026-08-16T22:10:00.000Z", message: "gone" },
    ]);

    show();

    expect(screen.getByText(/abcdef01/)).toBeDefined();
  });

  it("goes away only when a human clears it", async () => {
    // The one list that must not disappear because an app was restarted.
    saveFailures([
      { entry: sale("a"), at: "2026-08-16T22:02:00.000Z", message: "refused" },
    ]);
    const { user } = show();

    await user.click(screen.getByRole("button", { name: t("offline.dismissRefused") }));

    expect(loadFailures()).toEqual([]);
    expect(screen.queryByText(t("offline.refused"))).toBeNull();
  });

  it("offers nothing to clear when there is nothing", () => {
    show();

    expect(screen.queryByRole("button", { name: t("offline.dismissRefused") })).toBeNull();
  });
});

describe("sending now", () => {
  it("is offered once there is something to send and a server to send it to", async () => {
    saveQueue([sale("a")]);
    const { user, onSync } = show();

    await user.click(screen.getByRole("button", { name: t("offline.sync") }));

    expect(onSync).toHaveBeenCalledOnce();
  });

  it("is refused while the till is cut off", () => {
    saveQueue([sale("a")]);

    show({ online: false });

    expect(screen.getByRole("button", { name: t("offline.sync") })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("is refused while a run is already going", () => {
    // Two drains at once would replay the same entries against each other.
    saveQueue([sale("a")]);

    show({ syncing: true });

    expect(screen.getByRole("button", { name: t("offline.syncing") })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("is refused when there is nothing to send", () => {
    show();

    expect(screen.getByRole("button", { name: t("offline.sync") })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("getting back to the till", () => {
  it("closes on the button", async () => {
    const { user, onClose } = show();

    await user.click(screen.getByRole("button", { name: t("settings.close") }));

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("closes on a tap outside the panel", async () => {
    const { user, onClose, container } = show();

    await user.click(container.querySelector(".overlay") as HTMLElement);

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open on a tap inside it", async () => {
    const { user, onClose } = show();

    await user.click(screen.getByText(t("offline.title")));

    expect(onClose).not.toHaveBeenCalled();
  });
});
