import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { searchAttendees } = vi.hoisted(() => ({ searchAttendees: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, searchAttendees } };
});

import { t } from "../i18n";
import type { AttendeeMatch, Pairing } from "../types";
import AttendeeSearch from "./AttendeeSearch";

/**
 * The way through when a code will not scan — a crumpled printout, a dead
 * phone screen, a ticket left at home.
 *
 * A scan cannot admit the wrong person: the barcode is the person. This can.
 * The results are a list of strangers' names an arm's length apart, on a phone
 * held in one hand, at a door, in the dark, with a queue — and a till that let
 * one tap admit somebody let the wrong person in once already. Hence the second
 * gesture, and hence the half second before it counts.
 */

const pairing: Pairing = {
  token: "tok", organizer: "demo", event: "festival",
  serial: "TILL1", deviceName: "Porte",
};

function match(overrides: Partial<AttendeeMatch> = {}): AttendeeMatch {
  return {
    id: 1,
    order: "ABC12",
    secret: "secret-1",
    attendee_name: "Marie Dupont",
    seat: null,
    checkins: [],
    require_attention: false,
    order__status: "p",
    ...overrides,
  };
}

function show() {
  const onPick = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    <AttendeeSearch pairing={pairing} listId={7} onPick={onPick} onClose={onClose} />,
  );
  // delay: null — with fake timers running, userEvent's own inter-keystroke
  // delay never elapses and every typed character hangs the test.
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime, delay: null });
  /** Type a query and let the debounce run out. */
  const search = async (query: string) => {
    await user.type(screen.getByPlaceholderText(t("search.placeholder")), query);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
  };
  return { user, search, container, onPick, onClose };
}

beforeEach(() => {
  // shouldAdvanceTime, or userEvent's own internal setTimeout(0) never fires
  // and every interaction in this file hangs until the test times out.
  vi.useFakeTimers({ shouldAdvanceTime: true });
  searchAttendees.mockResolvedValue({ results: [match()] });
});

afterEach(() => {
  vi.useRealTimers();
});

describe("searching", () => {
  it("asks the server once the operator has stopped typing", async () => {
    // One request per name, not one per letter, on a venue's uplink.
    const { search } = show();

    await search("marie");

    expect(searchAttendees).toHaveBeenCalledOnce();
    expect(searchAttendees).toHaveBeenCalledWith(
      pairing,
      expect.objectContaining({ listId: 7, query: "marie" }),
    );
  });

  it("says nothing for a query too short to mean anything", async () => {
    // One letter matches half the guest list and helps nobody.
    const { search } = show();

    await search("m");

    expect(searchAttendees).not.toHaveBeenCalled();
  });

  it("ignores the spaces around a name", async () => {
    const { search } = show();

    await search("  marie  ");

    expect(searchAttendees).toHaveBeenCalledWith(
      pairing,
      expect.objectContaining({ query: "marie" }),
    );
  });

  it("abandons a request the operator has already typed past", async () => {
    // Otherwise a slow early request lands after a later one and puts the
    // wrong list of strangers on screen.
    const { user, search } = show();
    await search("mar");
    const [, first] = searchAttendees.mock.calls[0];

    await user.type(screen.getByPlaceholderText(t("search.placeholder")), "ie");

    expect(first.signal.aborted).toBe(true);
  });

  it("shows a hit by name, with its order code", async () => {
    const { search } = show();

    await search("marie");

    expect(await screen.findByText("Marie Dupont")).toBeDefined();
    expect(screen.getByText("ABC12")).toBeDefined();
  });

  it("falls back to the order code for a ticket with no name on it", async () => {
    searchAttendees.mockResolvedValue({ results: [match({ attendee_name: null })] });
    const { search, container } = show();

    await search("abc12");

    await waitFor(() =>
      expect(container.querySelector(".search-hit-name")?.textContent).toBe("ABC12"),
    );
  });

  it("names the seat when the ticket has one", async () => {
    searchAttendees.mockResolvedValue({ results: [match({ seat: { name: "Rang 3, 12" } })] });
    const { search } = show();

    await search("marie");

    expect(await screen.findByText(/Rang 3, 12/)).toBeDefined();
  });

  it("marks a ticket that is already inside", async () => {
    const { search } = show();
    searchAttendees.mockResolvedValue({ results: [match({ checkins: [{ list: 7 }] })] });

    await search("marie");

    expect(await screen.findByText(t("search.alreadyIn"))).toBeDefined();
  });

  it("says plainly when nothing matches", async () => {
    searchAttendees.mockResolvedValue({ results: [] });
    const { search } = show();

    await search("zzz");

    expect(await screen.findByText(t("search.none"))).toBeDefined();
  });

  it("says it is the network when the search will not go through", async () => {
    searchAttendees.mockRejectedValue(new Error("boom"));
    const { search } = show();

    await search("marie");

    expect(await screen.findByText(t("error.offline"))).toBeDefined();
  });

  it("says nothing at all when the request was merely abandoned", async () => {
    searchAttendees.mockRejectedValue(new DOMException("aborted", "AbortError"));
    const { search } = show();

    await search("marie");

    expect(screen.queryByText(t("error.offline"))).toBeNull();
  });

  it("clears the results when the field is emptied", async () => {
    const { user, search } = show();
    await search("marie");
    await screen.findByText("Marie Dupont");

    await user.clear(screen.getByPlaceholderText(t("search.placeholder")));

    expect(screen.queryByText("Marie Dupont")).toBeNull();
  });
});

describe("admitting somebody", () => {
  /** Search, then tap the hit — which selects it rather than admitting it. */
  async function select(
    user: ReturnType<typeof userEvent.setup>,
    search: (q: string) => Promise<void>,
    name = "Marie Dupont",
  ) {
    await search("marie");
    await user.click(await screen.findByRole("button", { name: new RegExp(name) }));
  }

  it("takes a second, deliberate gesture, not the tap that picked the name", async () => {
    const { user, search, onPick } = show();

    await select(user, search);

    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByText(t("search.confirmTitle"))).toBeDefined();
  });

  it("shows the name at the size it has to be read from", async () => {
    const { user, search, container } = show();

    await select(user, search);

    expect(container.querySelector(".confirm-name")?.textContent).toBe("Marie Dupont");
  });

  it("refuses the admit button for the first half second", async () => {
    // The tap that opened this screen must not be able to carry through it.
    // Placing the button elsewhere protects nothing: the results scroll.
    const { user, search } = show();

    await select(user, search);

    expect(screen.getByRole("button", { name: t("search.confirmAdmit") })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("takes it once that has passed", async () => {
    const { user, search, onPick } = show();
    await select(user, search);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(500);
    });
    await user.click(screen.getByRole("button", { name: t("search.confirmAdmit") }));

    expect(onPick).toHaveBeenCalledWith(expect.objectContaining({ secret: "secret-1" }));
  });

  it("lets the operator back out at any moment", async () => {
    // The guard is on admitting by accident, never on changing your mind.
    const { user, search, onPick } = show();
    await select(user, search);

    await user.click(screen.getByRole("button", { name: t("search.confirmBack") }));

    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByPlaceholderText(t("search.placeholder"))).toBeDefined();
  });

  it("warns that this ticket has already been through the door", async () => {
    searchAttendees.mockResolvedValue({ results: [match({ checkins: [{ list: 7 }] })] });
    const { user, search } = show();

    await select(user, search);

    expect(screen.getByText(t("search.confirmAlreadyIn"))).toBeDefined();
  });

  it("warns when pretix says this one needs looking at", async () => {
    searchAttendees.mockResolvedValue({ results: [match({ require_attention: true })] });
    const { user, search } = show();

    await select(user, search);

    expect(screen.getByText(t("search.confirmAttention"))).toBeDefined();
  });

  it("says so when there is no name to check against a face", async () => {
    searchAttendees.mockResolvedValue({ results: [match({ attendee_name: null })] });
    const { user, search } = show();

    await select(user, search, "ABC12");

    expect(screen.getByText(t("search.confirmNoName"))).toBeDefined();
  });

  it("does not close the door on a tap outside the confirmation", async () => {
    // Half-confirmed and dismissed by a stray touch is the worst of both.
    const { user, search, onClose, container } = show();
    await select(user, search);

    await user.click(container.querySelector(".overlay") as HTMLElement);

    expect(onClose).not.toHaveBeenCalled();
  });
});

describe("getting back to the door", () => {
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
});
