import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { terminalReader } = vi.hoisted(() => ({ terminalReader: vi.fn() }));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, terminalReader } };
});

import { ApiError } from "../api";
import { moment } from "../drawer";
import { t } from "../i18n";
import type { Pairing, ReaderAnswer, ReaderState } from "../types";
import ReaderStatus, { LOW_BATTERY } from "./ReaderStatus";

/**
 * The card reader, as the settings of the till driving it show it: what SumUp
 * says about it, put in the till's words — and, when SumUp says nothing,
 * "unknown" rather than "offline", which would send somebody off to look for
 * a machine that may be working perfectly well.
 */

const pairing: Pairing = {
  token: "tok",
  organizer: "demo",
  event: "festival",
  serial: "TILL1",
  deviceName: "Caisse bar",
};

function state(overrides: Partial<ReaderState> = {}): ReaderAnswer {
  return {
    reader: {
      status: "ONLINE",
      state: "IDLE",
      battery: 72,
      connection: "Wi-Fi",
      firmware: "3.3.41.0",
      last_activity: "2026-10-31T20:04:12.000Z",
      ...overrides,
    },
    reason: "",
  };
}

function show() {
  render(<ReaderStatus pairing={pairing} />);
  return userEvent.setup();
}

beforeEach(() => {
  terminalReader.mockReset();
  terminalReader.mockResolvedValue(state());
});

describe("a reader SumUp answers for", () => {
  it("is ready, with its battery, its network and its firmware", async () => {
    show();

    expect(await screen.findByText(t("reader.ready"))).toBeTruthy();
    expect(screen.getByText(t("reader.battery", { n: 72 }))).toBeTruthy();
    expect(screen.getByText("Wi-Fi")).toBeTruthy();
    expect(screen.getByText(t("reader.firmware", { version: "3.3.41.0" }))).toBeTruthy();
    expect(terminalReader).toHaveBeenCalledWith(pairing, expect.any(AbortSignal));
  });

  it("calls a reader on its own SIM what people call it", async () => {
    terminalReader.mockResolvedValue(state({ connection: "lte" }));
    show();

    expect(await screen.findByText("4G")).toBeTruthy();
  });

  it("shows a network it has no name for as SumUp sends it", async () => {
    terminalReader.mockResolvedValue(state({ connection: "5g-nr" }));
    show();

    expect(await screen.findByText("5g-nr")).toBeTruthy();
  });

  it("says what to do about a reader that is offline, and when it was last heard from", async () => {
    terminalReader.mockResolvedValue(state({ status: "OFFLINE", last_activity: "2026-10-31T19:41:00.000Z" }));
    show();

    expect(await screen.findByText(t("reader.offline"))).toBeTruthy();
    const help = screen.getByText(new RegExp(t("reader.offlineHelp").slice(0, 20)));
    expect(help.textContent).toContain(t("reader.lastSeen", { time: moment("2026-10-31T19:41:00.000Z") }));
  });

  it("is offline whatever it was doing when SumUp lost it", async () => {
    terminalReader.mockResolvedValue(
      state({ status: "OFFLINE", state: "WAITING_FOR_CARD", last_activity: null }),
    );
    show();

    expect(await screen.findByText(t("reader.offline"))).toBeTruthy();
    expect(screen.queryByText(t("reader.busy"))).toBeNull();
    expect(screen.queryByText(/Last heard from/)).toBeNull();
  });

  it.each(["WAITING_FOR_CARD", "WAITING_FOR_PIN", "SELECTING_TIP", "WAITING_FOR_SIGNATURE"])(
    "is taking a payment while SumUp says %s",
    async (busy) => {
      terminalReader.mockResolvedValue(state({ state: busy }));
      show();

      expect(await screen.findByText(t("reader.busy"))).toBeTruthy();
      expect(screen.getByText(t("reader.busyHelp"))).toBeTruthy();
    },
  );

  it("says that an update stops it taking payments", async () => {
    terminalReader.mockResolvedValue(state({ state: "UPDATING_FIRMWARE" }));
    show();

    expect(await screen.findByText(t("reader.updating"))).toBeTruthy();
    expect(screen.getByText(t("reader.updatingHelp"))).toBeTruthy();
  });

  it("asks for a reader running low to be plugged in", async () => {
    terminalReader.mockResolvedValue(state({ battery: LOW_BATTERY - 1 }));
    show();

    const battery = await screen.findByText(t("reader.batteryLow", { n: LOW_BATTERY - 1 }));
    expect(battery.className).toBe("is-low");
  });

  it("does not call a reader at the threshold low", async () => {
    terminalReader.mockResolvedValue(state({ battery: LOW_BATTERY }));
    show();

    expect(await screen.findByText(t("reader.battery", { n: LOW_BATTERY }))).toBeTruthy();
  });

  it("leaves out what SumUp did not say", async () => {
    terminalReader.mockResolvedValue(
      state({ state: "", battery: null, connection: "", firmware: "", last_activity: null }),
    );
    const { container } = render(<ReaderStatus pairing={pairing} />);

    expect(await screen.findByText(t("reader.ready"))).toBeTruthy();
    expect(container.querySelector(".reader-meta")?.textContent).toBe("");
  });
});

describe("a reader SumUp says nothing about", () => {
  it("is unknown, and the till does not call it offline", async () => {
    terminalReader.mockResolvedValue({ reader: null, reason: "no_answer" });
    show();

    expect(await screen.findByText(t("reader.unknown"))).toBeTruthy();
    expect(screen.getByText(t("reader.noAnswer"))).toBeTruthy();
    expect(screen.queryByText(t("reader.offline"))).toBeNull();
  });

  it("names the back office when SumUp is not set up there", async () => {
    terminalReader.mockResolvedValue({ reader: null, reason: "not_configured" });
    show();

    expect(await screen.findByText(t("reader.notConfigured"))).toBeTruthy();
  });
});

describe("asking", () => {
  it("shows that it is asking until the answer is in", async () => {
    let answer: (value: ReaderAnswer) => void = () => {};
    terminalReader.mockReturnValue(new Promise<ReaderAnswer>((resolve) => (answer = resolve)));
    show();

    const button = screen.getByRole("button", { name: t("reader.asking") });
    expect(button).toHaveProperty("disabled", true);
    expect(screen.getByText(t("app.loading"))).toBeTruthy();

    await act(async () => answer(state()));

    expect(screen.getByRole("button", { name: t("reader.refresh") })).toHaveProperty("disabled", false);
  });

  it("asks again when pressed, keeping the last answer on screen meanwhile", async () => {
    const user = show();
    await screen.findByText(t("reader.ready"));
    let answer: (value: ReaderAnswer) => void = () => {};
    terminalReader.mockReturnValue(new Promise<ReaderAnswer>((resolve) => (answer = resolve)));

    await user.click(screen.getByRole("button", { name: t("reader.refresh") }));

    expect(terminalReader).toHaveBeenCalledTimes(2);
    expect(screen.getByText(t("reader.ready"))).toBeTruthy();
    await act(async () => answer(state({ status: "OFFLINE" })));
    expect(screen.getByText(t("reader.offline"))).toBeTruthy();
  });

  it("says when the server could not be asked, and drops the answer it had", async () => {
    const user = show();
    await screen.findByText(t("reader.ready"));
    terminalReader.mockRejectedValue(new ApiError(0, "network"));

    await user.click(screen.getByRole("button", { name: t("reader.refresh") }));

    expect(await screen.findByText(t("reader.failed"))).toBeTruthy();
    expect(screen.queryByText(t("reader.ready"))).toBeNull();
  });

  it("recovers from a failure on the next press", async () => {
    terminalReader.mockRejectedValueOnce(new ApiError(502, "HTTP 502"));
    const user = show();
    await screen.findByText(t("reader.failed"));

    await user.click(screen.getByRole("button", { name: t("reader.refresh") }));

    expect(await screen.findByText(t("reader.ready"))).toBeTruthy();
    expect(screen.queryByText(t("reader.failed"))).toBeNull();
  });

  it("lets go of the question when the settings close", async () => {
    let answer: (value: ReaderAnswer) => void = () => {};
    terminalReader.mockReturnValue(new Promise<ReaderAnswer>((resolve) => (answer = resolve)));
    const { unmount } = render(<ReaderStatus pairing={pairing} />);
    const signal: AbortSignal = terminalReader.mock.calls[0][1];

    unmount();

    expect(signal.aborted).toBe(true);
    // An answer arriving after the panel closed is dropped, not drawn.
    await act(async () => answer(state()));
    await waitFor(() => expect(screen.queryByText(t("reader.ready"))).toBeNull());
  });

  it("drops a failure arriving after the settings closed as well", async () => {
    let fail: (reason: unknown) => void = () => {};
    terminalReader.mockReturnValue(new Promise<ReaderAnswer>((_resolve, reject) => (fail = reject)));
    const { unmount } = render(<ReaderStatus pairing={pairing} />);

    unmount();
    await act(async () => fail(new ApiError(0, "network")));

    expect(screen.queryByText(t("reader.failed"))).toBeNull();
  });
});
