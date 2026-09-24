import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { initialize, posEvents } = vi.hoisted(() => ({
  initialize: vi.fn(),
  posEvents: vi.fn(),
}));

vi.mock("../api", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../api")>();
  return { ...actual, api: { ...actual.api, initialize, posEvents } };
});

// The camera has its own tests; here it only needs to be something that can
// hand a decoded string back.
vi.mock("./QrScanner", () => ({
  default: ({ onDecode, onClose }: { onDecode: (text: string) => void; onClose: () => void }) => (
    <div>
      <button onClick={() => onDecode('{"token":"scanned-token"}')}>decode</button>
      <button onClick={onClose}>close scanner</button>
    </div>
  ),
}));

import { ApiError } from "../api";
import { t } from "../i18n";
import type { InitializeResponse, PosEvent, UnavailableEvent } from "../types";
import PairingScreen from "./PairingScreen";

/**
 * The five minutes before a till is a till.
 *
 * The two things that must not go wrong: pairing onto an event whose endpoints
 * will then refuse this device, and a volunteer left staring at a screen that
 * says nothing about why the code did not take.
 */

const device: InitializeResponse = {
  organizer: "demo",
  device_id: 3,
  unique_serial: "TILL1",
  api_token: "device-token",
  name: "Caisse bar",
  security_profile: "openpos",
};

const festival: PosEvent = {
  slug: "festival", organizer: "demo", name: "Festival",
  currency: "EUR", testmode: false, date_from: null,
};
const gala: PosEvent = { ...festival, slug: "gala", name: "Gala" };
const bal: UnavailableEvent = { ...festival, slug: "bal", name: "Bal", reason: "plugin_disabled" };

function show() {
  const onPaired = vi.fn();
  render(<PairingScreen onPaired={onPaired} />);
  const user = userEvent.setup();
  // Pasted rather than typed: it is what actually happens with a sixteen
  // character code, and userEvent reads a typed "{" as a key command.
  const typeCode = async (code: string) => {
    await user.click(screen.getByLabelText(t("pairing.token")));
    await user.paste(code);
    await user.click(screen.getByRole("button", { name: t("pairing.submit") }));
  };
  return { user, typeCode, onPaired };
}

beforeEach(() => {
  initialize.mockResolvedValue(device);
  posEvents.mockResolvedValue({ results: [festival] });
});

describe("the code", () => {
  it("is exchanged for a device token", async () => {
    const { typeCode } = show();

    await typeCode("abcd1234");

    expect(initialize).toHaveBeenCalledWith("abcd1234");
  });

  it("can be the whole QR blob pretix shows, pasted verbatim", async () => {
    // Scanning it with the camera app and pasting is the realistic flow on an
    // iPad with no QR library in the browser.
    const { typeCode } = show();

    await typeCode('{"token":"abcd1234","version":3}');

    expect(initialize).toHaveBeenCalledWith("abcd1234");
  });

  it("is taken as typed when the blob has no token in it", async () => {
    const { typeCode } = show();

    await typeCode('{"nothing":1}');

    expect(initialize).toHaveBeenCalledWith('{"nothing":1}');
  });

  it("is taken as typed when the blob is not valid JSON", async () => {
    const { typeCode } = show();

    await typeCode("{abcd1234");

    expect(initialize).toHaveBeenCalledWith("{abcd1234");
  });

  it("loses the whitespace a paste brings with it", async () => {
    const { typeCode } = show();

    await typeCode("  abcd1234  ");

    expect(initialize).toHaveBeenCalledWith("abcd1234");
  });

  it("cannot be submitted empty", async () => {
    show();

    expect(screen.getByRole("button", { name: t("pairing.submit") })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("cannot be submitted blank either", async () => {
    const { user } = show();

    await user.click(screen.getByLabelText(t("pairing.token")));
    await user.paste("   ");

    expect(screen.getByRole("button", { name: t("pairing.submit") })).toHaveProperty(
      "disabled",
      true,
    );
  });
});

describe("choosing the event", () => {
  it("is skipped when the device may only sell for one", async () => {
    const { typeCode, onPaired } = show();

    await typeCode("abcd1234");

    await waitFor(() =>
      expect(onPaired).toHaveBeenCalledWith({
        token: "device-token",
        organizer: "demo",
        serial: "TILL1",
        deviceName: "Caisse bar",
        event: "festival",
      }),
    );
  });

  it("is asked when there are several", async () => {
    posEvents.mockResolvedValue({ results: [festival, gala] });
    const { user, typeCode, onPaired } = show();
    await typeCode("abcd1234");

    await user.click(await screen.findByRole("button", { name: /Gala/ }));

    expect(onPaired).toHaveBeenCalledWith(expect.objectContaining({ event: "gala" }));
  });

  it("only ever offers events that actually run Open POS", async () => {
    // The token grants access to events, which is not the same thing as the
    // organizer having opened a till on them: pairing onto one of those gives
    // a till whose every endpoint refuses it.
    posEvents.mockResolvedValue({ results: [festival, gala] });
    const { typeCode } = show();

    await typeCode("abcd1234");

    await waitFor(() => expect(posEvents).toHaveBeenCalledWith("demo", "device-token"));
  });

  it("says so when there is not one, and offers another go", async () => {
    posEvents.mockResolvedValue({ results: [] });
    const { user, typeCode } = show();
    await typeCode("abcd1234");

    expect(await screen.findByText(t("pairing.noEvents"))).toBeDefined();
    await user.click(screen.getByRole("button", { name: t("pairing.retry") }));

    expect(screen.getByLabelText(t("pairing.token"))).toBeDefined();
  });

  it("names the events it reaches that do not run Open POS, and where to switch it on", async () => {
    // The device was given the right event, and Open POS was never ticked on
    // it. "No event" alone would send somebody to re-create the device.
    posEvents.mockResolvedValue({ results: [], unavailable: [bal] });
    const { typeCode } = show();
    await typeCode("abcd1234");

    expect(await screen.findByText(t("pairing.noEvents"))).toBeDefined();
    expect(screen.getByText(t("events.pluginDisabled", { names: "Bal" }))).toBeDefined();
    expect(screen.queryByRole("button", { name: /Bal/ })).toBeNull();
  });

  it("names them under the ones it can pick, too", async () => {
    posEvents.mockResolvedValue({ results: [festival, gala], unavailable: [bal] });
    const { typeCode } = show();
    await typeCode("abcd1234");

    expect(await screen.findByRole("button", { name: /Gala/ })).toBeDefined();
    expect(screen.getByText(t("events.pluginDisabled", { names: "Bal" }))).toBeDefined();
  });
});

describe("when it does not take", () => {
  it("says what the server said", async () => {
    initialize.mockRejectedValue(new ApiError(401, "Unknown device token."));
    const { typeCode } = show();

    await typeCode("abcd1234");

    expect(await screen.findByText("Unknown device token.")).toBeDefined();
  });

  it("says it is the network rather than the code", async () => {
    // The difference between "type it again" and "find the wifi".
    initialize.mockRejectedValue(new ApiError(0, "network"));
    const { typeCode } = show();

    await typeCode("abcd1234");

    expect(await screen.findByText(t("error.offline"))).toBeDefined();
  });

  it("says something for a failure that is not the API's at all", async () => {
    initialize.mockRejectedValue(new TypeError("bug in the app"));
    const { typeCode } = show();

    await typeCode("abcd1234");

    expect(await screen.findByText(/bug in the app/)).toBeDefined();
  });

  it("lets the code be tried again", async () => {
    initialize.mockRejectedValueOnce(new ApiError(401, "Unknown device token."));
    const { user, typeCode, onPaired } = show();
    await typeCode("abcd1234");
    await screen.findByText("Unknown device token.");

    await user.click(screen.getByRole("button", { name: t("pairing.submit") }));

    await waitFor(() => expect(onPaired).toHaveBeenCalled());
  });
});

describe("while it is being tried", () => {
  it("says so, and takes no second press", async () => {
    // Two devices paired for one code is a device nobody can account for.
    let release: (value: InitializeResponse) => void = () => {};
    initialize.mockImplementation(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { typeCode } = show();

    await typeCode("abcd1234");

    const button = await screen.findByRole("button", { name: t("pairing.pairing") });
    expect(button).toHaveProperty("disabled", true);
    expect(button.getAttribute("aria-busy")).toBe("true");
    release(device);
  });
});

describe("pairing by camera", () => {
  it("opens the scanner", async () => {
    const { user } = show();

    await user.click(screen.getByRole("button", { name: new RegExp(t("scan.open")) }));

    expect(screen.getByRole("button", { name: "decode" })).toBeDefined();
  });

  it("pairs on what it reads, blob and all", async () => {
    const { user, onPaired } = show();
    await user.click(screen.getByRole("button", { name: new RegExp(t("scan.open")) }));

    await user.click(screen.getByRole("button", { name: "decode" }));

    await waitFor(() => expect(initialize).toHaveBeenCalledWith("scanned-token"));
    expect(onPaired).toHaveBeenCalled();
  });

  it("goes back to the form when the scanner is closed", async () => {
    const { user } = show();
    await user.click(screen.getByRole("button", { name: new RegExp(t("scan.open")) }));

    await user.click(screen.getByRole("button", { name: "close scanner" }));

    expect(screen.getByLabelText(t("pairing.token"))).toBeDefined();
  });
});
