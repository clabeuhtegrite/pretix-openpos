import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { redeem, attendance, offlineSnapshot, searchAttendees, scanner } = vi.hoisted(() => ({
  redeem: vi.fn(),
  attendance: vi.fn(),
  offlineSnapshot: vi.fn(),
  searchAttendees: vi.fn(),
  /** Handles on the scanner's props, so a test can put a code in front of it. */
  scanner: { decode: (_secret: string) => {}, close: () => {}, paused: false },
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, redeem, attendance, offlineSnapshot, searchAttendees },
  };
});

// The camera has its own tests. Here it is a thing that hands over a decoded
// string, reports whether it was told to hold, and renders what it is given.
vi.mock("./QrScanner", () => ({
  default: ({ onDecode, onClose, paused, footer, children, title }: {
    onDecode: (text: string) => void;
    onClose: () => void;
    paused?: boolean;
    footer?: React.ReactNode;
    children?: React.ReactNode;
    title: string;
  }) => {
    scanner.decode = onDecode;
    scanner.close = onClose;
    scanner.paused = Boolean(paused);
    return (
      <div>
        <h2>{title}</h2>
        <span data-testid="paused">{String(Boolean(paused))}</span>
        {footer}
        {children}
      </div>
    );
  },
}));

import { markReachable, markUnreachable } from "../connectivity";
import { t } from "../i18n";
import { saveQueue, saveSnapshot } from "../storage";
import type { Attendance, CheckinListInfo, OfflineSnapshot, Pairing, RedeemResult } from "../types";
import CheckinScreen from "./CheckinScreen";

/**
 * The door.
 *
 * Every verdict a person is shown comes from pretix' own check-in RPC, so what
 * is tested here is the screen around it: that a ticket left in front of the
 * lens is not answered with a red "already scanned", that a T-shirt is not
 * answered with a green "let them in", and that a network dropout is answered
 * from the guest list the till carries rather than by guessing.
 */

const pairing: Pairing = {
  token: "tok", organizer: "demo", event: "festival",
  serial: "TILL1", deviceName: "Porte",
};

const lists: CheckinListInfo[] = [
  { id: 7, name: "Porte", all_products: true, include_pending: false },
  { id: 8, name: "VIP", all_products: false, include_pending: false },
];

const ADMISSION = [10];

const inside: Attendance = {
  list: { id: 7, name: "Porte" },
  computed_at: "2026-08-16T22:30:00.000Z",
  inside: 120, entered: 120, exited: 0, expected: 200, not_arrived: 80,
  non_admission_entered: 0,
  items: [{ id: 10, name: "Entrée", inside: 120, entered: 120, expected: 200 }],
};

const snapshot: OfflineSnapshot = {
  list: { id: 7, name: "Porte" },
  generated: "2026-08-16T20:00:00.000Z",
  tickets: [
    { secret: "alice", item: 10, name: "Alice", used: false },
    { secret: "bob", item: 10, name: "Bob", used: true },
  ],
  truncated: false,
};

function admitted(overrides: Partial<RedeemResult> = {}): RedeemResult {
  return {
    status: "ok",
    position: { item: 10, order: "ABC12", attendee_name: "Marie Dupont" },
    ...overrides,
  };
}

function show(props: Partial<Parameters<typeof CheckinScreen>[0]> = {}) {
  const onClose = vi.fn();
  const { container } = render(
    <CheckinScreen
      pairing={pairing}
      lists={lists}
      defaultListId={7}
      admissionItems={ADMISSION}
      onClose={onClose}
      {...props}
    />,
  );
  return {
    user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }),
    container,
    onClose,
  };
}

/** Put a code in front of the camera and let the answer arrive. */
async function scan(secret = "ticket-1") {
  await act(async () => {
    scanner.decode(secret);
  });
}

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
  markReachable();
  redeem.mockResolvedValue(admitted());
  attendance.mockResolvedValue(inside);
  offlineSnapshot.mockResolvedValue(snapshot);
  searchAttendees.mockResolvedValue({ results: [] });
});

afterEach(() => {
  vi.useRealTimers();
  markReachable();
});

describe("with no list to scan against", () => {
  it("says so instead of opening a camera", () => {
    show({ lists: [], defaultListId: null });

    expect(screen.getByText(t("checkin.noList"))).toBeDefined();
  });

  it("offers the way out", async () => {
    const { user, onClose } = show({ lists: [], defaultListId: null });

    await user.click(screen.getByRole("button", { name: t("settings.close") }));

    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("a scan", () => {
  it("goes through pretix' own RPC, for the list on screen", async () => {
    show();

    await scan("ticket-1");

    expect(redeem).toHaveBeenCalledWith(
      pairing,
      expect.objectContaining({ secret: "ticket-1", lists: [7] }),
    );
  });

  it("carries a fresh nonce each time", async () => {
    // pretix deduplicates on it; a reused one would drop a genuine second scan.
    show();

    await scan("ticket-1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    await scan("ticket-2");

    const [[, first], [, second]] = redeem.mock.calls;
    expect(second.nonce).not.toBe(first.nonce);
  });

  it("shows the verdict with the name on the ticket", async () => {
    show();

    await scan();

    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
    expect(screen.getByText(/Marie Dupont · ABC12/)).toBeDefined();
  });

  it("passes on whatever pretix wanted said at the door", async () => {
    redeem.mockResolvedValue(admitted({ checkin_texts: ["Bracelet rouge"] }));
    show();

    await scan();

    expect(screen.getByText("Bracelet rouge")).toBeDefined();
  });

  it("flags a ticket pretix says to look at", async () => {
    show();
    redeem.mockResolvedValue(admitted({ require_attention: true }));

    await scan();

    expect(screen.getByText(t("checkin.attention"))).toBeDefined();
  });

  it("holds the camera while a verdict is up", async () => {
    // Otherwise the same ticket, still in frame, is read again underneath it.
    show();

    await scan();

    expect(screen.getByTestId("paused").textContent).toBe("true");
  });

  it("resumes once the verdict has been read", async () => {
    show();
    await scan();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(screen.queryByText(t("checkin.ok"))).toBeNull();
  });

  it("keeps a refusal up longer than an admission", async () => {
    redeem.mockResolvedValue({ status: "error", reason: "already_redeemed" });
    show();
    await scan();

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    expect(screen.getByText(t("reason.already_redeemed"))).toBeDefined();
  });

  it("clears on a tap, so a fast queue is never held up", async () => {
    const { user } = show();
    await scan();

    await user.click(screen.getByRole("status"));

    expect(screen.queryByText(t("checkin.ok"))).toBeNull();
  });
});

describe("a ticket left in front of the lens", () => {
  it("is not submitted again", async () => {
    // Re-submitting answers a valid entry with a red "already scanned".
    show();
    await scan("ticket-1");

    await scan("ticket-1");

    expect(redeem).toHaveBeenCalledOnce();
  });

  it("keeps being ignored for as long as it stays there", async () => {
    // A sliding window: the guard expires once the ticket is out of frame,
    // not a fixed time after the first read.
    show();
    await scan("ticket-1");

    for (let i = 0; i < 5; i += 1) {
      await act(async () => {
        await vi.advanceTimersByTimeAsync(4000);
      });
      await scan("ticket-1");
    }

    expect(redeem).toHaveBeenCalledOnce();
  });

  it("is read again once it has been away long enough", async () => {
    show();
    await scan("ticket-1");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    await scan("ticket-1");

    expect(redeem).toHaveBeenCalledTimes(2);
  });

  it("does not stop the next person's ticket", async () => {
    show();
    await scan("ticket-1");

    await scan("ticket-2");

    expect(redeem).toHaveBeenCalledTimes(2);
  });

  it("is ignored while an answer is still being waited for", async () => {
    let release: (value: RedeemResult) => void = () => {};
    redeem.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    show();

    await scan("ticket-1");
    await scan("ticket-2");

    expect(redeem).toHaveBeenCalledOnce();
    await act(async () => {
      release(admitted());
    });
  });

  it("ignores an empty read altogether", async () => {
    show();

    await scan("   ");

    expect(redeem).not.toHaveBeenCalled();
  });
});

describe("what the scan was for", () => {
  it("says 'let them in' for an admission product", async () => {
    show();

    await scan();

    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
  });

  it("does not, for a T-shirt on an all-products list", async () => {
    // pretix dutifully records the scan, but a merch line has no door, and
    // answering it with a green "let them in" is how a door loses its count.
    redeem.mockResolvedValue(admitted({ position: { item: 99, order: "ABC12" } }));
    show();

    await scan();

    expect(screen.getByText(t("checkin.noEntry"))).toBeDefined();
    expect(screen.getByText(t("checkin.noEntryHint"))).toBeDefined();
  });

  it("counts it apart from the admissions", async () => {
    redeem.mockResolvedValue(admitted({ position: { item: 99, order: "ABC12" } }));
    show();

    await scan();

    expect(screen.getByText(new RegExp(t("checkin.counterOther", { n: 1 })))).toBeDefined();
  });

  it("admits a product it has never heard of", async () => {
    // Telling somebody holding a valid ticket that it admits nobody, because
    // the product was created after the app loaded, is the worse failure.
    redeem.mockResolvedValue(admitted({ position: { order: "ABC12" } }));
    show();

    await scan();

    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
  });
});

describe("a refusal", () => {
  it("is named in words the door can act on", async () => {
    redeem.mockResolvedValue({ status: "error", reason: "already_redeemed" });
    show();

    await scan();

    expect(screen.getByText(t("reason.already_redeemed"))).toBeDefined();
  });

  it("falls back to a plain refusal for a reason this build has no words for", async () => {
    // Showing "reason.something_new" to somebody at a door is worse than
    // showing nothing.
    redeem.mockResolvedValue({ status: "error", reason: "invented_last_week" });
    show();

    await scan();

    expect(screen.getByText(t("reason.unknown"))).toBeDefined();
  });

  it("names the check-in questions this till cannot ask", async () => {
    redeem.mockResolvedValue({ status: "incomplete" });
    show();

    await scan();

    expect(screen.getByText(t("reason.incomplete"))).toBeDefined();
  });

  it("passes on pretix' own explanation of a refusal by rule", async () => {
    // "Refused by the rules" names the kind of refusal; which rule is what
    // the operator has to be able to say to the person in front of them.
    redeem.mockResolvedValue({
      status: "error", reason: "rules", reason_explanation: "Entry only after 20:00.",
    });
    show();

    await scan();

    expect(screen.getByText(t("reason.rules"))).toBeDefined();
    expect(screen.getByText("Entry only after 20:00.")).toBeDefined();
  });

  it("names a ticket presented outside the window it is valid in", async () => {
    redeem.mockResolvedValue({ status: "error", reason: "invalid_time" });
    show();

    await scan();

    expect(screen.getByText(t("reason.invalid_time"))).toBeDefined();
  });

  it("buzzes, because looking up at the right moment is not a given", async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    redeem.mockResolvedValue({ status: "error", reason: "invalid" });
    show();

    await scan();

    expect(vibrate).toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "vibrate");
  });

  it("does not buzz for somebody being let in", async () => {
    const vibrate = vi.fn();
    Object.defineProperty(navigator, "vibrate", { value: vibrate, configurable: true });
    show();

    await scan();

    expect(vibrate).not.toHaveBeenCalled();
    Reflect.deleteProperty(navigator, "vibrate");
  });

  it("survives a browser that refuses to vibrate", async () => {
    Object.defineProperty(navigator, "vibrate", {
      value: () => {
        throw new Error("needs a user gesture");
      },
      configurable: true,
    });
    redeem.mockResolvedValue({ status: "error", reason: "invalid" });
    show();

    await scan();

    expect(screen.getByText(t("reason.invalid"))).toBeDefined();
    Reflect.deleteProperty(navigator, "vibrate");
  });

  it("is counted", async () => {
    redeem.mockResolvedValue({ status: "error", reason: "invalid" });
    show();

    await scan();

    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 0, ko: 1 })))).toBeDefined();
  });
});

describe("when the request itself fails", () => {
  it("says it is the network", async () => {
    const { ApiError } = await import("../api");
    redeem.mockRejectedValue(new ApiError(0, "network"));
    show();

    await scan();

    expect(screen.getByText(t("error.offline"))).toBeDefined();
  });

  it("lets the same ticket be tried again straight away", async () => {
    // The repeat guard must not lock out the ticket that just failed to send.
    const { ApiError } = await import("../api");
    redeem.mockRejectedValueOnce(new ApiError(0, "network"));
    show();
    await scan("ticket-1");

    await scan("ticket-1");

    expect(redeem).toHaveBeenCalledTimes(2);
  });
});

describe("the head count", () => {
  it("is read for the list on screen", async () => {
    show();

    await waitFor(() => expect(attendance).toHaveBeenCalledWith(pairing, 7));
  });

  it("is shown on the button", async () => {
    show();

    expect(
      await screen.findByRole("button", { name: t("attendance.button", { n: 120 }) }),
    ).toBeDefined();
  });

  it("opens the breakdown", async () => {
    const { user } = show();
    const button = await screen.findByRole("button", { name: t("attendance.button", { n: 120 }) });

    await user.click(button);

    expect(screen.getByText(t("attendance.title"))).toBeDefined();
  });

  it("is re-read a moment after somebody is let in", async () => {
    // Asked of the server rather than added up here: every door and every till
    // checks people in, and a local tally would drift from the first scan made
    // anywhere else.
    show();
    await waitFor(() => expect(attendance).toHaveBeenCalledOnce());

    await scan();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(attendance).toHaveBeenCalledTimes(2);
  });

  it("is not re-read for a refusal", async () => {
    redeem.mockResolvedValue({ status: "error", reason: "invalid" });
    show();
    await waitFor(() => expect(attendance).toHaveBeenCalledOnce());

    await scan();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(attendance).toHaveBeenCalledOnce();
  });

  it("goes stale on its own, so it is re-read on a timer too", async () => {
    show();
    await waitFor(() => expect(attendance).toHaveBeenCalledOnce());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    expect(attendance).toHaveBeenCalledTimes(2);
  });

  it("is dropped rather than carried over when the door is switched", async () => {
    // A figure counted on another list is worse than no figure at all.
    const { user } = show();
    await screen.findByRole("button", { name: t("attendance.button", { n: 120 }) });

    await user.selectOptions(screen.getByLabelText(t("checkin.list")), "8");

    await waitFor(() => expect(attendance).toHaveBeenCalledWith(pairing, 8));
  });

  it("leaves the operator scanning when it cannot be read", async () => {
    const { ApiError } = await import("../api");
    attendance.mockRejectedValue(new ApiError(0, "network"));
    show();

    await waitFor(() => expect(attendance).toHaveBeenCalled());
    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 0, ko: 0 })))).toBeDefined();
  });
});

describe("with no network", () => {
  beforeEach(() => {
    saveSnapshot(snapshot);
  });

  it("answers from the guest list the till carries", async () => {
    show();
    act(() => markUnreachable());

    await scan("alice");

    expect(redeem).not.toHaveBeenCalled();
    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
  });

  it("says how many tickets it is scanning against", async () => {
    show();

    act(() => markUnreachable());

    expect(screen.getByText(t("offline.scanning", { n: 2 }))).toBeDefined();
  });

  it("queues what it admitted, so pretix hears about it later", async () => {
    show();
    act(() => markUnreachable());

    await scan("alice");

    const { loadQueue } = await import("../storage");
    expect(loadQueue()).toEqual([
      expect.objectContaining({ kind: "checkin", secret: "alice", name: "Alice", list: 7 }),
    ]);
  });

  it("refuses a ticket the guest list has never heard of", async () => {
    // The alternative is admitting anything presented to a camera.
    show();
    act(() => markUnreachable());

    await scan("nobody");

    expect(screen.getByText(t("reason.invalid"))).toBeDefined();
  });

  it("refuses one the snapshot already says is in", async () => {
    show();
    act(() => markUnreachable());

    await scan("bob");

    expect(screen.getByText(t("reason.already_redeemed"))).toBeDefined();
  });

  it("refuses a second scan of a ticket admitted during the dropout", async () => {
    show();
    act(() => markUnreachable());
    await scan("alice");

    await act(async () => {
      await vi.advanceTimersByTimeAsync(9000);
    });
    await scan("alice");

    expect(screen.getByText(t("reason.already_redeemed"))).toBeDefined();
  });

  it("remembers what it queued across a reload", async () => {
    saveQueue([{
      kind: "checkin", id: "n1", at: "2026-08-16T22:00:00.000Z", event: "festival",
      list: 7, secret: "alice", name: "Alice",
    }]);
    show();
    act(() => markUnreachable());

    await scan("alice");

    expect(screen.getByText(t("reason.already_redeemed"))).toBeDefined();
  });

  it("says it has no guest list when the door was switched during the dropout", async () => {
    // The other door's list would admit the wrong people.
    const { user } = show();
    await user.selectOptions(screen.getByLabelText(t("checkin.list")), "8");
    act(() => markUnreachable());

    await scan("alice");

    expect(screen.getByText(t("offline.noSnapshot"))).toBeDefined();
    expect(screen.getByText(t("reason.offline_no_snapshot"))).toBeDefined();
  });

  it("does not go on asking the server for a fresh guest list", async () => {
    show();
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());

    act(() => markUnreachable());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(offlineSnapshot).toHaveBeenCalledOnce();
  });
});

describe("the guest list carried for a dropout", () => {
  it("is pulled as soon as the door opens", async () => {
    show();

    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledWith(pairing, 7));
  });

  it("is refreshed while there is a network to refresh it from", async () => {
    // Tickets are still being sold, online and at the other tills, all evening.
    show();
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalledOnce());

    await act(async () => {
      await vi.advanceTimersByTimeAsync(300_000);
    });

    expect(offlineSnapshot).toHaveBeenCalledTimes(2);
  });

  it("keeps the one it has when a refresh fails", async () => {
    saveSnapshot(snapshot);
    offlineSnapshot.mockRejectedValue(new Error("boom"));
    show();
    await waitFor(() => expect(offlineSnapshot).toHaveBeenCalled());

    act(() => markUnreachable());

    expect(screen.getByText(t("offline.scanning", { n: 2 }))).toBeDefined();
  });
});

describe("finding somebody by name", () => {
  it("opens the search", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: new RegExp(t("search.open")) }));

    expect(screen.getByText(t("search.title"))).toBeDefined();
  });

  it("holds the camera while it is open", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: new RegExp(t("search.open")) }));

    expect(screen.getByTestId("paused").textContent).toBe("true");
  });

  it("checks in the person the operator picked", async () => {
    searchAttendees.mockResolvedValue({
      results: [{
        id: 1, order: "ABC12", secret: "picked-secret", attendee_name: "Marie Dupont",
        seat: null, checkins: [], require_attention: false, order__status: "p",
      }],
    });
    const { user } = show();
    await user.click(screen.getByRole("button", { name: new RegExp(t("search.open")) }));
    await user.type(screen.getByPlaceholderText(t("search.placeholder")), "marie");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await user.click(await screen.findByRole("button", { name: /Marie Dupont/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });

    await user.click(screen.getByRole("button", { name: t("search.confirmAdmit") }));

    await waitFor(() =>
      expect(redeem).toHaveBeenCalledWith(
        pairing, expect.objectContaining({ secret: "picked-secret" }),
      ),
    );
  });

  it("does not swallow a deliberate pick as a repeated frame", async () => {
    // The guard is keyed on the code. Somebody scanned a moment ago and then
    // looked up by name is a person the operator meant to admit twice.
    searchAttendees.mockResolvedValue({
      results: [{
        id: 1, order: "ABC12", secret: "ticket-1", attendee_name: "Marie Dupont",
        seat: null, checkins: [], require_attention: false, order__status: "p",
      }],
    });
    const { user } = show();
    await scan("ticket-1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });

    await user.click(screen.getByRole("button", { name: new RegExp(t("search.open")) }));
    await user.type(screen.getByPlaceholderText(t("search.placeholder")), "marie");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    await user.click(await screen.findByRole("button", { name: /Marie Dupont/ }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await user.click(screen.getByRole("button", { name: t("search.confirmAdmit") }));

    await waitFor(() => expect(redeem).toHaveBeenCalledTimes(2));
  });

  it("closes without admitting anyone", async () => {
    const { user } = show();
    await user.click(screen.getByRole("button", { name: new RegExp(t("search.open")) }));

    await user.click(screen.getByRole("button", { name: t("settings.close") }));

    expect(screen.queryByText(t("search.title"))).toBeNull();
    expect(redeem).not.toHaveBeenCalled();
  });
});

describe("the head count panel", () => {
  it("re-reads the figure on demand", async () => {
    const { user } = show();
    const button = await screen.findByRole("button", { name: t("attendance.button", { n: 120 }) });
    await user.click(button);
    attendance.mockClear();

    await user.click(screen.getByRole("button", { name: t("attendance.refresh") }));

    await waitFor(() => expect(attendance).toHaveBeenCalled());
  });

  it("closes back onto the camera", async () => {
    const { user } = show();
    const button = await screen.findByRole("button", { name: t("attendance.button", { n: 120 }) });
    await user.click(button);

    await user.click(screen.getByRole("button", { name: t("settings.close") }));

    expect(screen.queryByText(t("attendance.title"))).toBeNull();
    expect(screen.getByTestId("paused").textContent).toBe("false");
  });
});

describe("leaving", () => {
  it("closes on the scanner's own way out", async () => {
    const { onClose } = show();

    await act(async () => {
      scanner.close();
    });

    expect(onClose).toHaveBeenCalledOnce();
  });

  it("shows the door's tally as it goes", async () => {
    show();

    await scan("ticket-1");
    await act(async () => {
      await vi.advanceTimersByTimeAsync(7000);
    });
    redeem.mockResolvedValue({ status: "error", reason: "invalid" });
    await scan("ticket-2");

    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 1, ko: 1 })))).toBeDefined();
  });

  it("offers one list without a switcher", () => {
    const { container } = show({ lists: [lists[0]] });

    expect(within(container).queryByLabelText(t("checkin.list"))).toBeNull();
  });

  it("tells the app which list it was switched to", async () => {
    // So the guest list for a dropout goes on being carried for this door
    // once the screen is closed, and the door reopens on it.
    const onListChange = vi.fn();
    const { user } = show({ onListChange });

    await user.selectOptions(screen.getByLabelText(t("checkin.list")), "8");

    expect(onListChange).toHaveBeenCalledWith(8);
  });
});

describe("selling a ticket at the door", () => {
  it("offers no way out to the grid unless this device is a door", () => {
    // Everywhere else the grid is already underneath: the ✕ is the way back
    // and a second button saying the same thing would be noise.
    show();

    expect(screen.queryByRole("button", { name: `🛒 ${t("checkin.sell")}` })).toBeNull();
  });

  it("hands the door over to the grid when asked", async () => {
    const onSell = vi.fn();
    const { user } = show({ onSell });

    await user.click(screen.getByRole("button", { name: `🛒 ${t("checkin.sell")}` }));

    expect(onSell).toHaveBeenCalled();
  });

  it("stays available while the head count and the search are still loading", async () => {
    // Those two need a list to be chosen; selling does not, and a door should
    // be able to take somebody's ten euros the moment it is on screen.
    const onSell = vi.fn();
    const { user } = show({ onSell });

    await user.click(screen.getByRole("button", { name: `🛒 ${t("checkin.sell")}` }));

    expect(onSell).toHaveBeenCalledTimes(1);
    expect(
      screen.getByRole("button", { name: `🛒 ${t("checkin.sell")}` }),
    ).toHaveProperty("disabled", false);
  });
});
