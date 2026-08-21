import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import type { Attendance } from "../types";
import AttendancePanel from "./AttendancePanel";

/**
 * How many people are in the room, and how they got there.
 *
 * The number an operator wants at a door is a single one. Everything else on
 * this panel exists to make that number trustworthy by showing what it came
 * from — so the tests are about the shape the panel takes for the data it is
 * given, and above all about the dimension it drops when nobody has been
 * scanned back out.
 */

function attendance(overrides: Partial<Attendance> = {}): Attendance {
  return {
    list: { id: 7, name: "Porte" },
    computed_at: "2026-08-16T22:30:00.000Z",
    inside: 120,
    entered: 120,
    exited: 0,
    expected: 200,
    not_arrived: 80,
    non_admission_entered: 0,
    items: [
      { id: 10, name: "Entrée", inside: 100, entered: 100, expected: 150 },
      { id: 11, name: "Entrée réduite", inside: 20, entered: 20, expected: 50 },
    ],
    ...overrides,
  };
}

function show(props: Partial<Parameters<typeof AttendancePanel>[0]> = {}) {
  const onRefresh = vi.fn();
  const onClose = vi.fn();
  const { container } = render(
    <AttendancePanel
      data={attendance()}
      busy={false}
      error={null}
      onRefresh={onRefresh}
      onClose={onClose}
      {...props}
    />,
  );
  return { user: userEvent.setup(), container, onRefresh, onClose };
}

describe("the number", () => {
  it("is the count inside, large and on its own", () => {
    const { container } = show();

    expect(container.querySelector(".attendance-count")?.textContent).toBe("120");
    expect(screen.getByText(t("attendance.inside"))).toBeDefined();
  });

  it("is not there before the server has answered", () => {
    const { container } = show({ data: null, busy: true });

    expect(container.querySelector(".attendance-count")).toBeNull();
    // Said both in place of the number and on the refresh button.
    expect(screen.getAllByText(t("attendance.loading")).length).toBeGreaterThan(0);
  });

  it("is a dash rather than a nought when there is nothing to show", () => {
    // A zero would read as "the room is empty", which is not what is known.
    show({ data: null, busy: false });

    expect(screen.getByText("—")).toBeDefined();
  });
});

describe("the diagram", () => {
  it("describes itself for a reader who cannot see it", () => {
    show();

    expect(
      screen.getByRole("img", {
        name: t("attendance.diagram", {
          expected: 200, entered: 120, inside: 120, exited: 0,
        }),
      }),
    ).toBeDefined();
  });

  it("says 'on site' at the second level when nobody has left", () => {
    // Everyone who came in is still in; a third level saying "0 left" would be
    // structure for the sake of structure.
    const { container } = show();

    const svg = within(container.querySelector("svg") as unknown as HTMLElement);
    expect(svg.getByText(t("attendance.onSite"))).toBeDefined();
    expect(svg.queryByText(t("attendance.entered"))).toBeNull();
  });

  it("splits into entered, on site and left as soon as one exit is scanned", () => {
    const { container } = show({ data: attendance({ inside: 90, entered: 120, exited: 30 }) });

    const svg = within(container.querySelector("svg") as unknown as HTMLElement);
    expect(svg.getByText(t("attendance.entered"))).toBeDefined();
    expect(svg.getByText(t("attendance.onSite"))).toBeDefined();
    expect(svg.getByText(t("attendance.exited"))).toBeDefined();
  });

  it("is left out for an event nobody has a ticket for yet", () => {
    show({ data: attendance({ expected: 0, not_arrived: 0, inside: 0, entered: 0, items: [] }) });

    expect(screen.queryByRole("img")).toBeNull();
    expect(screen.getByText(t("attendance.empty"))).toBeDefined();
  });
});

describe("how full the room is", () => {
  it("is given as a count and a share of what was sold", () => {
    show();

    expect(
      screen.getByText(t("attendance.fill", { entered: 120, expected: 200, percent: 60 })),
    ).toBeDefined();
  });

  it("rounds rather than showing a fraction of a person", () => {
    show({ data: attendance({ entered: 1, expected: 3, inside: 1, not_arrived: 2 }) });

    expect(screen.getByText(new RegExp(String(33)))).toBeDefined();
  });
});

describe("the breakdown per product", () => {
  it("is shown when there is more than one to break down", () => {
    show();

    expect(screen.getByText(t("attendance.byProduct"))).toBeDefined();
    expect(screen.getByRole("cell", { name: "Entrée réduite" })).toBeDefined();
  });

  it("is left out when the event sells one kind of ticket", () => {
    // A table of one row restates the headline and nothing else.
    show({ data: attendance({ items: [{ id: 10, name: "Entrée", inside: 120, entered: 120, expected: 200 }] }) });

    expect(screen.queryByText(t("attendance.byProduct"))).toBeNull();
  });

  it("drops the 'entered' column too when nobody has left", () => {
    show();

    expect(screen.queryByRole("columnheader", { name: t("attendance.entered") })).toBeNull();
  });

  it("shows it once somebody has", () => {
    show({ data: attendance({ inside: 90, entered: 120, exited: 30 }) });

    expect(screen.getByRole("columnheader", { name: t("attendance.entered") })).toBeDefined();
  });
});

describe("what the count leaves out", () => {
  it("always says what it is counting", () => {
    show();

    expect(screen.getByText(new RegExp(t("attendance.explain")))).toBeDefined();
  });

  it("names scans of things that admit nobody, so the gap is not a mystery", () => {
    // A beer scanned at the door is a scan that will never appear in a head
    // count, and somebody comparing two numbers deserves to know why.
    show({ data: attendance({ non_admission_entered: 4 }) });

    expect(screen.getByText(new RegExp(t("attendance.nonAdmission", { n: 4 })))).toBeDefined();
  });

  it("keeps quiet when there were none", () => {
    show();

    expect(screen.queryByText(new RegExp(t("attendance.nonAdmission", { n: 4 })))).toBeNull();
  });

  it("names the list and when it was counted", () => {
    // Several doors scan the same event; which list this is matters.
    show();

    expect(screen.getByText(/Porte/)).toBeDefined();
  });
});

describe("keeping it current", () => {
  it("re-reads on demand", async () => {
    const { user, onRefresh } = show();

    await user.click(screen.getByRole("button", { name: t("attendance.refresh") }));

    expect(onRefresh).toHaveBeenCalledOnce();
  });

  it("takes no second press while it is already reading", () => {
    const { container } = show({ busy: true });

    const refresh = within(container.querySelector(".panel") as HTMLElement).getByRole("button", {
      name: t("attendance.loading"),
    });
    expect(refresh).toHaveProperty("disabled", true);
  });

  it("says why when the count could not be read", () => {
    show({ error: t("error.offline") });

    expect(screen.getByText(t("error.offline"))).toBeDefined();
  });

  it("keeps the last count on screen behind the error", () => {
    // A stale number with a warning beats no number at a door.
    const { container } = show({ error: t("error.offline") });

    expect(container.querySelector(".attendance-count")?.textContent).toBe("120");
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

  it("stays open on a tap inside it", async () => {
    const { user, onClose } = show();

    await user.click(screen.getByText(t("attendance.title")));

    expect(onClose).not.toHaveBeenCalled();
  });
});
