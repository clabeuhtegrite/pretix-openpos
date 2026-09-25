import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { redeem, attendance, offlineSnapshot, searchAttendees, scanner, play } = vi.hoisted(() => ({
  redeem: vi.fn(),
  attendance: vi.fn(),
  offlineSnapshot: vi.fn(),
  searchAttendees: vi.fn(),
  play: vi.fn(),
  /** Handles on the scanner's props, so a test can put a code in front of it. */
  scanner: {
    decode: (_secret: string) => {},
    close: () => {},
    paused: false,
    errorHint: undefined as string | undefined,
  },
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return {
    ...actual,
    api: { ...actual.api, redeem, attendance, offlineSnapshot, searchAttendees },
  };
});

vi.mock("../sound", () => ({ play }));

// The camera has its own tests. Here it is a thing that hands over a decoded
// string, reports whether it was told to hold, and renders what it is given.
vi.mock("./QrScanner", () => ({
  default: ({ onDecode, onClose, paused, footer, children, title, errorHint, banner }: {
    onDecode: (text: string) => void;
    onClose: () => void;
    paused?: boolean;
    footer?: React.ReactNode;
    children?: React.ReactNode;
    title: string;
    errorHint?: string;
    banner?: React.ReactNode;
  }) => {
    scanner.decode = onDecode;
    scanner.close = onClose;
    scanner.paused = Boolean(paused);
    scanner.errorHint = errorHint;
    return (
      <div>
        <h2>{title}</h2>
        {banner}
        <span data-testid="paused">{String(Boolean(paused))}</span>
        {footer}
        {children}
      </div>
    );
  },
}));

import { ApiError } from "../api";
import { markReachable, markUnreachable } from "../connectivity";
import { locale, t } from "../i18n";
import { loadAdmissions, loadQueue, saveDoorScans, saveQueue, saveSnapshot } from "../storage";
import { fillStorage } from "../test/setup";
import type {
  Attendance, CheckinListInfo, DoorScans, OfflineSnapshot, Pairing, QueuedCheckin, RedeemResult,
} from "../types";
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

/** The event's scans as the server counts them. */
const counted: DoorScans = {
  device: { admitted: 41, refused: 2, other: 0, offline: 3 },
  event: { admitted: 180, refused: 5, other: 1, offline: 7 },
  devices: [],
};

/** A scan waiting in the queue, made just now. */
function waitingScan(overrides: Partial<QueuedCheckin> = {}): QueuedCheckin {
  return {
    kind: "checkin", id: "n1", at: new Date().toISOString(), event: "festival",
    list: 7, secret: "alice", name: "Alice", admits: true, ...overrides,
  };
}

function show(props: Partial<Parameters<typeof CheckinScreen>[0]> = {}) {
  const onClose = vi.fn();
  const screenWith = (more: Partial<Parameters<typeof CheckinScreen>[0]>) => (
    <CheckinScreen
      pairing={pairing}
      lists={lists}
      defaultListId={7}
      admissionItems={ADMISSION}
      onClose={onClose}
      {...props}
      {...more}
    />
  );
  const { container, rerender, unmount } = render(screenWith({}));
  return {
    user: userEvent.setup({ advanceTimers: vi.advanceTimersByTime }),
    container,
    onClose,
    unmount,
    /** The same screen, with some of what the app hands it changed. */
    update: (more: Partial<Parameters<typeof CheckinScreen>[0]>) => rerender(screenWith(more)),
  };
}

/** The offline line as the screen words it for a list pulled at `generated`. */
function offlineLineFor(generated: string, n: number): string {
  const at = new Date(generated);
  const time = at.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
  if (at.toDateString() === new Date().toDateString()) return t("offline.scanning", { n, time });
  const date = at.toLocaleDateString(locale, { day: "numeric", month: "long" });
  return t("offline.scanningOld", { n, date, time });
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

  it("does not say offline when pretix answered it", async () => {
    show();

    await scan();

    expect(screen.queryByText(t("checkin.offline"))).toBeNull();
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

  it("says on the picture that the ticket is being checked, until the verdict", async () => {
    // Only in the line under the camera, it was easy to miss with the phone
    // held up to a ticket; on a slow network the door looked as if it had
    // not read anything, and the ticket was presented again.
    let release: (value: RedeemResult) => void = () => {};
    redeem.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { container } = show();

    await scan("ticket-1");

    const checking = container.querySelector(".scanner-status.is-checking");
    expect(checking?.textContent).toBe(t("checkin.busy"));
    await act(async () => {
      release(admitted());
    });
    expect(container.querySelector(".scanner-status.is-checking")).toBeNull();
    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
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

  it("says no out loud, which is the only channel an iPhone has", async () => {
    // The vibration above does nothing on iOS, and the door is all iPhones.
    play.mockClear();
    redeem.mockResolvedValue({ status: "error", reason: "invalid" });
    show();

    await scan();

    expect(play).toHaveBeenCalledWith("refused");
  });

  it("says yes quietly too, so silence is not the answer to everything", async () => {
    // With no sound at all on a good scan, the operator cannot tell a ticket
    // that went through from one the camera never read, and the ticket gets
    // presented twice.
    play.mockClear();
    show();

    await scan();

    expect(play).toHaveBeenCalledWith("ok");
    expect(play).not.toHaveBeenCalledWith("refused");
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

describe("when pretix cannot answer a scan", () => {
  beforeEach(() => {
    saveSnapshot(snapshot);
  });

  it("waits a few seconds for it, not the thirty a sale gets", async () => {
    // With a queue outside, nobody holds a ticket up to the camera for half a
    // minute of "Checking…": the person is waved in long before.
    show();

    await scan("alice");

    expect(redeem).toHaveBeenCalledWith(pairing, expect.objectContaining({ timeoutMs: 8000 }));
  });

  it("answers from the guest list the device carries, and says so", async () => {
    // It used to end on an error banner with the scan kept nowhere: whoever
    // was let in meanwhile never reached pretix.
    redeem.mockRejectedValue(new ApiError(0, "network"));
    show();

    await scan("alice");

    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
    expect(screen.getByText(t("checkin.offline"))).toBeDefined();
    expect(screen.queryByText(t("error.offline"))).toBeNull();
  });

  it("keeps the scan under the nonce it was sent with", async () => {
    // The request may have reached pretix before its answer was lost: the
    // same nonce makes the replay a repeat rather than a second entry.
    redeem.mockRejectedValue(new ApiError(504, "Gateway Timeout"));
    show();

    await scan("alice");

    const [[, sent]] = redeem.mock.calls;
    expect(loadQueue()).toEqual([
      expect.objectContaining({ kind: "checkin", id: sent.nonce, secret: "alice", admits: true }),
    ]);
  });

  it("answers a scan the server asked to slow down from the list, and keeps it", async () => {
    // A 429 is pretix not taking the scan at all, like a restart: the queue
    // replays it under the same nonce once it will.
    redeem.mockRejectedValue(new ApiError(429, "Request was throttled."));
    show();

    await scan("alice");

    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
    expect(screen.getByText(t("checkin.offline"))).toBeDefined();
    const [[, sent]] = redeem.mock.calls;
    expect(loadQueue()).toEqual([expect.objectContaining({ id: sent.nonce, secret: "alice" })]);
  });

  it("still stops on pretix refusing the device itself", async () => {
    // "No" rather than "not now": answering it from the guest list would hide
    // a phone that has been revoked.
    redeem.mockRejectedValueOnce(new ApiError(403, "Device revoked"));
    show();

    await scan("alice");

    expect(screen.getByText("Device revoked")).toBeDefined();
    expect(loadQueue()).toEqual([]);
  });

  it("lets the same ticket be tried again straight away after that", async () => {
    // The repeat guard must not lock out the ticket that just failed to send.
    redeem.mockRejectedValueOnce(new ApiError(403, "Device revoked"));
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

  it("does not let a ticket in twice once its first scan was sent and the door reopened", async () => {
    // The queue was the only record of who this door let in, and the queue
    // empties the moment it is sent: a door that lost the network again and
    // was reopened answered the same ticket green a second time.
    const first = show();
    act(() => markUnreachable());
    await scan("alice");
    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
    saveQueue([]);
    first.unmount();

    show();
    await scan("alice");

    expect(screen.getByText(t("reason.already_redeemed"))).toBeDefined();
    expect(loadQueue()).toEqual([
      expect.objectContaining({ secret: "alice", refused: "already_redeemed" }),
    ]);
  });

  it("does not let in again offline a ticket it let in online a moment ago", async () => {
    // pretix has the entry; the guest list on the device will not until its
    // next pull, and that is exactly the window a dropout falls in.
    const first = show();
    await scan("alice");
    expect(redeem).toHaveBeenCalledOnce();
    first.unmount();

    show();
    act(() => markUnreachable());
    await scan("alice");

    expect(screen.getByText(t("reason.already_redeemed"))).toBeDefined();
  });

  it("does not count a refusal as the ticket having been used", async () => {
    redeem.mockResolvedValue({ status: "error", reason: "invalid" });
    const first = show();
    await scan("alice");
    first.unmount();

    show();
    act(() => markUnreachable());
    await scan("alice");

    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
  });

  it("forgets what it let in once the guest list it holds has it as used", async () => {
    const first = show();
    await scan("alice");
    expect(loadAdmissions("festival")).toEqual({ 7: { alice: expect.any(Number) } });
    first.unmount();
    saveSnapshot({
      ...snapshot,
      tickets: snapshot.tickets.map((ticket) => ({ ...ticket, used: true })),
    });

    show();

    expect(loadAdmissions("festival")).toEqual({});
  });

  it("says how many tickets it is scanning against, and when the list is from", async () => {
    // "liste de 21:14": the one thing that explains why a ticket bought ten
    // minutes ago is refused — it is the list, not the ticket.
    const pulled = new Date();
    pulled.setMinutes(pulled.getMinutes() - 12);
    saveSnapshot({ ...snapshot, generated: pulled.toISOString() });
    show();

    act(() => markUnreachable());

    const time = pulled.toLocaleTimeString(locale, { hour: "2-digit", minute: "2-digit" });
    expect(screen.getByText(t("offline.scanning", { n: 2, time }))).toBeDefined();
  });

  it("says the day too for a list from another day", async () => {
    show();

    act(() => markUnreachable());

    const pulled = new Date(snapshot.generated);
    const date = pulled.toLocaleDateString(locale, { day: "numeric", month: "long" });
    expect(screen.getByText(offlineLineFor(snapshot.generated, 2))).toBeDefined();
    expect(offlineLineFor(snapshot.generated, 2)).toContain(date);
  });

  it("still says how many when it cannot tell when the list is from", async () => {
    saveSnapshot({ ...snapshot, generated: "not a date" });
    show();

    act(() => markUnreachable());

    expect(screen.getByText(t("offline.scanningUndated", { n: 2 }))).toBeDefined();
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

  it("tells the app it has queued something, so the badge and the drain know", async () => {
    // A door that only ever scans queues entries the app never hears about:
    // the badge reads zero after a whole evening, and when the network comes
    // back the automatic drain bails out because as far as it knows there is
    // nothing to send. The entries then sit in the browser until somebody
    // happens to relaunch the app, and pretix never learns who came in.
    const onQueued = vi.fn();
    show({ onQueued });
    act(() => markUnreachable());

    await scan("alice");

    expect(onQueued).toHaveBeenCalled();
  });

  it("keeps a refusal too, so pretix hears of the ticket it turned away", async () => {
    // Online, pretix writes down every scan it refuses. Offline, nothing did:
    // a ticket bought after the last copy of the guest list was turned away
    // and left no trace — exactly what somebody looking for lost scans needs.
    const onQueued = vi.fn();
    show({ onQueued });
    act(() => markUnreachable());

    await scan("nobody-we-know");

    expect(onQueued).toHaveBeenCalled();
    expect(loadQueue()).toEqual([
      expect.objectContaining({ kind: "checkin", secret: "nobody-we-know", refused: "invalid" }),
    ]);
  });

  it("keeps a scan it could not check at all, in words pretix will show", async () => {
    const { user } = show();
    await user.selectOptions(screen.getByLabelText(t("checkin.list")), "8");
    act(() => markUnreachable());

    await scan("alice");

    expect(loadQueue()).toEqual([
      expect.objectContaining({ list: 8, refused: "error", explanation: t("checkin.unchecked") }),
    ]);
  });

  it("remembers when what it let through admits nobody", async () => {
    saveSnapshot({
      ...snapshot,
      tickets: [...snapshot.tickets, { secret: "shirt", item: 99, name: "", used: false }],
    });
    show();
    act(() => markUnreachable());

    await scan("shirt");

    expect(loadQueue()).toEqual([expect.objectContaining({ secret: "shirt", admits: false })]);
  });

  it("says on the verdict that the phone answered it", async () => {
    show();
    act(() => markUnreachable());

    await scan("alice");

    expect(screen.getByText(t("checkin.offline"))).toBeDefined();
  });

  it("says so when the phone cannot keep the scan, rather than answer it", async () => {
    // A verdict nobody will ever hear about is worse than none: the ticket is
    // checked another way.
    show();
    act(() => markUnreachable());
    fillStorage();

    await scan("alice");

    expect(screen.getByText(t("checkin.queueFailed"))).toBeDefined();
    expect(screen.queryByText(t("checkin.ok"))).toBeNull();
  });

  it("does not take a scan it could not keep for the ticket being used", async () => {
    show();
    act(() => markUnreachable());
    fillStorage();
    await scan("alice");

    await scan("alice");

    expect(screen.queryByText(t("reason.already_redeemed"))).toBeNull();
    expect(screen.getByText(t("checkin.queueFailed"))).toBeDefined();
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

  it("does not take a refusal kept from before a reload for the ticket being used", async () => {
    saveQueue([waitingScan({ secret: "alice", refused: "invalid", admits: undefined })]);
    show();
    act(() => markUnreachable());

    await scan("alice");

    expect(screen.getByText(t("checkin.ok"))).toBeDefined();
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

    expect(screen.getByText(offlineLineFor(snapshot.generated, 2))).toBeDefined();
  });
});

describe("finding somebody by name", () => {
  it("is what the camera's error points to, since it is right below", () => {
    // The hint used to say there was nothing to type, over a screen whose
    // bottom row is a search for exactly that.
    show();

    expect(scanner.errorHint).toBe(t("scan.findByName", { search: t("search.open") }));
    expect(scanner.errorHint).toContain(t("search.open"));
    expect(screen.getByRole("button", { name: new RegExp(t("search.open")) })).toBeDefined();
  });

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
  it("says the server is in trouble, rather than 'HTTP 502', when the figure cannot be read", async () => {
    const { user } = show();
    const button = await screen.findByRole("button", { name: t("attendance.button", { n: 120 }) });
    attendance.mockRejectedValue(new ApiError(502, "HTTP 502"));

    await user.click(button);

    expect(await screen.findByText(t("error.server", { status: 502 }))).toBeDefined();
  });

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

describe("the scanner's counter", () => {
  beforeEach(() => {
    attendance.mockResolvedValue({ ...inside, scans: counted });
  });

  it("is what the server counted for this device over the event", async () => {
    show();

    expect(
      await screen.findByText(new RegExp(t("checkin.counter", { ok: 41, ko: 2 }))),
    ).toBeDefined();
  });

  it("gives every door's figure for the event underneath", async () => {
    show();

    expect(await screen.findByText(t("checkin.counterEvent", { n: 180 }))).toBeDefined();
  });

  it("does not make up the event's figure before the server has given one", () => {
    attendance.mockReturnValue(new Promise(() => {}));
    show();

    expect(screen.getByText(t("checkin.counterEventUnknown"))).toBeDefined();
  });

  it("opens on the last figure when iOS reloads the page with no network", async () => {
    // The complaint from the door on 19 September: step out of the app for a
    // while, and the count started again from zero.
    saveDoorScans("festival", counted);
    attendance.mockRejectedValue(new ApiError(0, "network"));
    show();

    await waitFor(() => expect(attendance).toHaveBeenCalled());
    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 41, ko: 2 })))).toBeDefined();
    expect(screen.getByText(t("checkin.counterEvent", { n: 180 }))).toBeDefined();
  });

  it("adds a scan at once, and not twice once the server has counted it", async () => {
    show();
    await screen.findByText(new RegExp(t("checkin.counter", { ok: 41, ko: 2 })));

    await scan("ticket-1");

    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 42, ko: 2 })))).toBeDefined();
    expect(screen.getByText(t("checkin.counterEvent", { n: 181 }))).toBeDefined();

    attendance.mockResolvedValue({
      ...inside,
      scans: {
        ...counted,
        device: { ...counted.device, admitted: 42 },
        event: { ...counted.event, admitted: 181 },
      },
    });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1200);
    });

    expect(attendance).toHaveBeenCalledTimes(2);
    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 42, ko: 2 })))).toBeDefined();
    expect(screen.getByText(t("checkin.counterEvent", { n: 181 }))).toBeDefined();
  });

  it("does not take a scan off twice when two answers land for it", async () => {
    // The minute's refresh and a scan's can be in flight together; each
    // answer counts the scans made before it was asked, not after.
    let answer: (value: Attendance) => void = () => {};
    show();
    await screen.findByText(new RegExp(t("checkin.counter", { ok: 41, ko: 2 })));
    attendance.mockReturnValueOnce(new Promise<Attendance>((resolve) => (answer = resolve)));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(60_000);
    });

    await scan("ticket-1");
    // The slow one was asked before the scan, so it cannot know of it.
    await act(async () => answer({ ...inside, scans: counted }));

    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 42, ko: 2 })))).toBeDefined();
  });

  it("counts what waits in the queue, and says it is still to be sent", async () => {
    saveQueue([waitingScan()]);
    show();

    expect(
      await screen.findByText(new RegExp(t("checkin.counter", { ok: 42, ko: 2 }))),
    ).toBeDefined();
    expect(screen.getByText(new RegExp(t("checkin.counterWaiting", { n: 1 })))).toBeDefined();
  });

  it("counts a scan that has waited in the queue since an earlier night", async () => {
    // Still one of this event's people, and the figure is the event's.
    saveQueue([waitingScan({ at: new Date(Date.now() - 4 * 86_400_000).toISOString() })]);
    show();

    expect(
      await screen.findByText(new RegExp(t("checkin.counter", { ok: 42, ko: 2 }))),
    ).toBeDefined();
    expect(screen.getByText(t("checkin.counterEvent", { n: 181 }))).toBeDefined();
  });

  it("counts a scan answered offline straight away", async () => {
    saveSnapshot(snapshot);
    show();
    await screen.findByText(new RegExp(t("checkin.counter", { ok: 41, ko: 2 })));
    act(() => markUnreachable());

    await scan("alice");

    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 42, ko: 2 })))).toBeDefined();
    expect(screen.getByText(new RegExp(t("checkin.counterWaiting", { n: 1 })))).toBeDefined();
  });

  it("does not drop while a drain's scans are on their way into the server's figure", async () => {
    // The queue empties a moment before the server's figure counts what was
    // in it. Read from the queue in between, the count would fall, then
    // climb back.
    saveQueue([waitingScan()]);
    const { update } = show({ pending: 1 });
    await screen.findByText(new RegExp(t("checkin.counter", { ok: 42, ko: 2 })));
    attendance.mockReturnValue(new Promise(() => {}));

    saveQueue([]);
    update({ pending: 0 });

    expect(screen.getByText(new RegExp(t("checkin.counter", { ok: 42, ko: 2 })))).toBeDefined();
    expect(screen.queryByText(new RegExp(t("checkin.counterWaiting", { n: 1 })))).toBeNull();
  });

  it("is asked again as soon as a drain has sent scans", async () => {
    const { update } = show({ pending: 2 });
    await waitFor(() => expect(attendance).toHaveBeenCalledOnce());

    update({ pending: 0 });

    await waitFor(() => expect(attendance).toHaveBeenCalledTimes(2));
  });

  it("is not asked again for something merely added to the queue", async () => {
    const { update } = show({ pending: 0 });
    await waitFor(() => expect(attendance).toHaveBeenCalledOnce());

    update({ pending: 1 });

    expect(attendance).toHaveBeenCalledOnce();
  });

  it("is not asked again merely because the network came back", async () => {
    // A failed request followed by one that got through looks just like that,
    // and on a network that drops writes but not reads it happens as fast as
    // the requests go.
    show();
    await waitFor(() => expect(attendance).toHaveBeenCalledOnce());
    act(() => markUnreachable());

    act(() => markReachable());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2000);
    });

    expect(attendance).toHaveBeenCalledOnce();
  });

  it("is kept for the next reload", async () => {
    show();
    await screen.findByText(new RegExp(t("checkin.counter", { ok: 41, ko: 2 })));

    const { loadDoorScans } = await import("../storage");
    expect(loadDoorScans("festival")).toEqual(counted);
  });
});

describe("what the app is told", () => {
  it("that the door is busy while a verdict is on screen, and free once it is gone", async () => {
    // The app applies an update only on a door with nothing on screen: a
    // reload must never land on a verdict somebody is reading.
    const onBusyChange = vi.fn();
    show({ onBusyChange });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);

    await scan("alice");
    expect(onBusyChange).toHaveBeenLastCalledWith(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(4000);
    });
    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("that it is busy while a name is being looked up", async () => {
    const onBusyChange = vi.fn();
    const { user } = show({ onBusyChange });

    await user.click(screen.getByRole("button", { name: new RegExp(t("search.open")) }));

    expect(onBusyChange).toHaveBeenLastCalledWith(true);
  });

  it("that it is free once it has gone, whatever it was doing", async () => {
    const onBusyChange = vi.fn();
    const { user, unmount } = show({ onBusyChange });
    await user.click(screen.getByRole("button", { name: new RegExp(t("search.open")) }));

    unmount();

    expect(onBusyChange).toHaveBeenLastCalledWith(false);
  });

  it("carries the app's notice onto the scanner", () => {
    show({ notice: <button>New version</button> });

    expect(screen.getByRole("button", { name: "New version" })).toBeDefined();
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

  it("moves off a list deleted in pretix while the door had it on screen", async () => {
    // The lists now arrive again with every config the app reads while the
    // door is up. Staying on a list that is gone would send every scan to it.
    const vip = { id: 9, name: "Invités", all_products: true, include_pending: false };
    const { user, update } = show({ lists: [...lists, vip] });
    await user.selectOptions(screen.getByLabelText(t("checkin.list")), "9");

    update({ lists });

    expect((screen.getByLabelText(t("checkin.list")) as HTMLSelectElement).value).toBe("7");
  });

  it("falls back on the first list when the app's own is gone too", async () => {
    const { user, update } = show();
    await user.selectOptions(screen.getByLabelText(t("checkin.list")), "8");

    const other = { id: 11, name: "Balcon", all_products: true, include_pending: false };
    update({ lists: [other, lists[0]], defaultListId: 99 });

    expect((screen.getByLabelText(t("checkin.list")) as HTMLSelectElement).value).toBe("11");
  });

  it("says so when the event has no list left at all", async () => {
    const { update } = show();

    update({ lists: [], defaultListId: null });

    expect(screen.getByText(t("checkin.noList"))).toBeDefined();
  });
});

describe("selling a ticket at the door", () => {
  it("offers no way out to the grid unless this device is a door", () => {
    // Everywhere else the grid is already underneath: the ✕ is the way back
    // and a second button saying the same thing would be noise.
    show();

    expect(screen.queryByRole("button", { name: `🛒 ${t("checkin.sell")}` })).toBeNull();
  });

  it("puts selling first, on a row of its own above the search and the head count", () => {
    // Three buttons side by side did not fit an iPhone. jsdom lays nothing
    // out, so what is pinned here is the markup the layout in styles.css rests
    // on: the button leads the row, and carries the class that gives it a
    // whole line.
    const { container } = show({ onSell: vi.fn() });

    const sell = screen.getByRole("button", { name: `🛒 ${t("checkin.sell")}` });
    expect(container.querySelector(".scanner-actions")?.firstElementChild).toBe(sell);
    expect(sell.className).toContain("sell-button");
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
