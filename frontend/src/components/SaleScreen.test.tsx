import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { t } from "../i18n";
import { formatMoney } from "../money";
import type { CartLine, Catalog } from "../types";
import SaleScreen, { pictureBackground } from "./SaleScreen";

/**
 * The screen a cashier spends the whole evening on.
 *
 * What matters here is what can and cannot be tapped: a product with no stock
 * left, a "+" that would take a basket past what the quota allows, a "take
 * payment" on an empty basket. Everything else is arithmetic that lives in
 * money.ts and is tested there.
 */

const catalog: Catalog = {
  categories: [
    {
      id: 1,
      name: "Bar",
      items: [
        {
          id: 10, name: "Bière", admission: false, picture: null,
          price: "3.00", available: null, variations: [],
        },
        {
          id: 11, name: "Vin", admission: false, picture: null,
          price: "4.00", available: 3, variations: [],
        },
      ],
    },
    {
      id: 2,
      name: "Entrées",
      items: [
        {
          id: 20, name: "Entrée", admission: true, picture: null,
          price: "10.00", available: 0, variations: [],
        },
        {
          id: 21, name: "T-shirt", admission: false, picture: null,
          price: null, available: null,
          variations: [
            { id: 100, name: "S", price: "15.00", available: 40 },
            { id: 101, name: "L", price: "18.00", available: null },
          ],
        },
      ],
    },
  ],
};

function line(overrides: Partial<CartLine> = {}): CartLine {
  return {
    key: "10:",
    itemId: 10,
    variationId: null,
    label: "Bière",
    unitPrice: 300,
    count: 2,
    available: null,
    ...overrides,
  };
}

function show(
  cart: CartLine[] = [],
  extras: Partial<Pick<Parameters<typeof SaleScreen>[0], "customSale" | "depositBack">> = {},
) {
  const handlers = {
    onAdd: vi.fn(),
    onCustomSale: vi.fn(),
    onDepositBack: vi.fn(),
    onSetCount: vi.fn(),
    onClear: vi.fn(),
    onCharge: vi.fn(),
  };
  const { container } = render(
    <SaleScreen
      catalog={catalog}
      cart={cart}
      currency="EUR"
      customSale={null}
      depositBack={null}
      {...extras}
      {...handlers}
    />,
  );
  // The same amount can appear both in the grid and in the basket, so the
  // basket's own assertions are scoped to it.
  const basket = () => within(container.querySelector(".cart") as HTMLElement);
  const firstLine = () => within(container.querySelector(".line") as HTMLElement);
  /** The product buttons, in the order a thumb meets them. */
  const tiles = () =>
    [...container.querySelectorAll(".grid .product")].map((tile) => tile.textContent ?? "");
  return { user: userEvent.setup(), basket, firstLine, tiles, container, ...handlers };
}

describe("the product grid", () => {
  it("shows one button per product", () => {
    show();

    expect(screen.getByRole("button", { name: /Bière/ })).toBeDefined();
  });

  it("gives a product with variations one button per variation", () => {
    // A cashier taps the size, not the shirt.
    show();

    expect(screen.getByRole("button", { name: /T-shirt · S/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /T-shirt · L/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /^T-shirt$/ })).toBeNull();
  });

  it("prices each variation on its own, not on the product", () => {
    show();

    const large = screen.getByRole("button", { name: /T-shirt · L/ });
    expect(within(large).getByText(formatMoney(1800, "EUR"))).toBeDefined();
  });

  it("adds the product that was tapped", async () => {
    const { user, onAdd } = show();

    await user.click(screen.getByRole("button", { name: /Bière/ }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 10, variationId: null, priceCents: 300 }),
    );
  });

  it("adds the variation that was tapped, not its product", async () => {
    const { user, onAdd } = show();

    await user.click(screen.getByRole("button", { name: /T-shirt · L/ }));

    expect(onAdd).toHaveBeenCalledWith(
      expect.objectContaining({ itemId: 21, variationId: 101, priceCents: 1800 }),
    );
  });
});

describe("what is left", () => {
  it("refuses a product with nothing left", () => {
    show();

    const button = screen.getByRole("button", { name: /Entrée/ });
    expect(button).toHaveProperty("disabled", true);
    expect(within(button).getByText(t("sale.soldOut"))).toBeDefined();
  });

  it("warns when the last few are going", () => {
    show();

    const button = screen.getByRole("button", { name: /Vin/ });
    expect(within(button).getByText(t("sale.left", { n: 3 }))).toBeDefined();
  });

  it("says nothing about a product with no quota at all", () => {
    show();

    const button = screen.getByRole("button", { name: /Bière/ });
    expect(within(button).queryByText(/left/)).toBeNull();
  });

  it("says nothing while there is plenty", () => {
    // 40 shirts is not news; 20 or fewer is.
    show();

    const button = screen.getByRole("button", { name: /T-shirt · S/ });
    expect(within(button).queryByText(/left/)).toBeNull();
  });
});

describe("the categories", () => {
  it("shows everything at first", () => {
    show();

    expect(screen.getByRole("button", { name: /Bière/ })).toBeDefined();
    expect(screen.getByRole("button", { name: /T-shirt · S/ })).toBeDefined();
  });

  it("heads each block when several are on screen at once", () => {
    show();

    expect(screen.getByRole("heading", { name: "Bar" })).toBeDefined();
  });

  it("narrows to one category when its tab is tapped", async () => {
    const { user } = show();

    await user.click(screen.getByRole("tab", { name: "Bar" }));

    expect(screen.getByRole("button", { name: /Bière/ })).toBeDefined();
    expect(screen.queryByRole("button", { name: /T-shirt · S/ })).toBeNull();
  });

  it("drops the heading when there is only one block to head", async () => {
    const { user } = show();

    await user.click(screen.getByRole("tab", { name: "Bar" }));

    expect(screen.queryByRole("heading", { name: "Bar" })).toBeNull();
  });

  it("goes back to everything on the first tab", async () => {
    const { user } = show();
    await user.click(screen.getByRole("tab", { name: "Bar" }));

    await user.click(screen.getByRole("tab", { name: t("sale.all") }));

    expect(screen.getByRole("button", { name: /T-shirt · S/ })).toBeDefined();
  });

  it("marks the tab that is showing", async () => {
    const { user } = show();

    await user.click(screen.getByRole("tab", { name: "Bar" }));

    expect(screen.getByRole("tab", { name: "Bar" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: t("sale.all") }).getAttribute("aria-selected")).toBe("false");
  });
});

describe("the basket", () => {
  it("says so when it is empty", () => {
    show();

    expect(screen.getByText(t("sale.empty"))).toBeDefined();
  });

  it("will not take a payment for nothing", () => {
    show();

    expect(screen.getByRole("button", { name: t("sale.charge") })).toHaveProperty(
      "disabled",
      true,
    );
  });

  it("offers no way to clear what is already empty", () => {
    show();

    expect(screen.queryByRole("button", { name: t("sale.clear") })).toBeNull();
  });

  it("shows each line with its unit price and its own total", () => {
    const { firstLine } = show([line()]);

    expect(firstLine().getByText(formatMoney(300, "EUR"))).toBeDefined();
    expect(firstLine().getByText(formatMoney(600, "EUR"))).toBeDefined();
  });

  it("adds the lines up", () => {
    const { basket } = show([line(), line({ key: "11:", label: "Vin", unitPrice: 400, count: 1 })]);

    const total = basket().getByText(t("sale.total")).parentElement as HTMLElement;
    expect(within(total).getByText(formatMoney(1000, "EUR"))).toBeDefined();
  });

  it("takes one off a line", async () => {
    const { user, onSetCount } = show([line()]);

    await user.click(screen.getByRole("button", { name: "−" }));

    expect(onSetCount).toHaveBeenCalledWith("10:", 1);
  });

  it("adds one to a line", async () => {
    const { user, onSetCount } = show([line()]);

    await user.click(screen.getByRole("button", { name: "+" }));

    expect(onSetCount).toHaveBeenCalledWith("10:", 3);
  });

  it("stops at what the quota allows", async () => {
    // The alternative is a basket that can only be refused at checkout, after
    // the customer has been told a total.
    show([line({ count: 3, available: 3 })]);

    expect(screen.getByRole("button", { name: "+" })).toHaveProperty("disabled", true);
  });

  it("empties on the clear button", async () => {
    const { user, onClear } = show([line()]);

    await user.click(screen.getByRole("button", { name: t("sale.clear") }));

    expect(onClear).toHaveBeenCalledOnce();
  });

  it("goes to payment once there is something to pay for", async () => {
    const { user, onCharge } = show([line()]);

    await user.click(screen.getByRole("button", { name: t("sale.charge") }));

    expect(onCharge).toHaveBeenCalledOnce();
  });
});

describe("the buttons that are not products", () => {
  it("shows neither until the organiser has set one up", () => {
    show();

    expect(screen.queryByRole("button", { name: new RegExp(t("custom.tile")) })).toBeNull();
    expect(screen.queryByRole("button", { name: new RegExp(t("deposit.tile")) })).toBeNull();
  });

  it("opens the free-amount keypad", async () => {
    const { user, onCustomSale } = show([], { customSale: { name: "Divers" } });

    await user.click(screen.getByRole("button", { name: new RegExp(t("custom.tile")) }));

    expect(onCustomSale).toHaveBeenCalledOnce();
  });

  it("shows what a deposit is worth, as money going out", async () => {
    show([], { depositBack: { name: "Consigne", priceCents: 100 } });

    expect(
      screen.getByRole("button", { name: new RegExp(`−${formatMoney(100, "EUR")}`) }),
    ).toBeDefined();
  });

  it("hands a cup back on one tap", async () => {
    const { user, onDepositBack } = show([], {
      depositBack: { name: "Consigne", priceCents: 100 },
    });

    await user.click(screen.getByRole("button", { name: new RegExp(t("deposit.tile")) }));

    expect(onDepositBack).toHaveBeenCalledOnce();
  });

  it("shows a returned deposit in the basket as a negative line", () => {
    const { firstLine } = show([
      line({ key: "refund:30", itemId: 30, label: "Consigne · rendue", unitPrice: -100, count: 3, refund: true }),
    ]);

    // The total the customer settles is the net, so the line has to read as
    // one: minus three euros, not three.
    expect(firstLine().getByText(formatMoney(-300, "EUR"))).toBeDefined();
    expect(firstLine().getByText(formatMoney(-100, "EUR"))).toBeDefined();
  });

  it("totals a mixed basket at what actually changes hands", () => {
    const { basket } = show([
      line({ count: 4 }),
      line({ key: "refund:30", itemId: 30, label: "Consigne · rendue", unitPrice: -100, count: 3, refund: true }),
    ]);

    // 4 × 3 € sold, 3 × 1 € handed back.
    expect(basket().getByText(formatMoney(900, "EUR"))).toBeDefined();
  });
});

describe("what has run out", () => {
  it("sinks a sold-out product to the end of its own category", () => {
    // "Entrée" is first in the catalogue and has nothing left; the shirts
    // behind it are what can still be sold, so they come forward.
    const { tiles } = show();

    const grid = tiles();
    expect(grid.findIndex((name) => name.includes("Entrée"))).toBe(grid.length - 1);
    expect(grid.findIndex((name) => name.includes("T-shirt · S"))).toBeLessThan(
      grid.findIndex((name) => name.includes("Entrée")),
    );
  });

  it("leaves it in its own category rather than at the very end", async () => {
    // It has to stay findable: the cashier still has to be able to see that
    // the place sells it and has run out.
    const { user, tiles } = show();

    await user.click(screen.getByRole("tab", { name: "Entrées" }));

    expect(tiles().some((name) => name.includes("Entrée"))).toBe(true);
  });
});

describe("the product photographs", () => {
  const withPicture: Catalog = {
    categories: [
      {
        id: 1,
        name: "Bar",
        items: [
          {
            id: 10, name: "Bière", admission: false,
            picture: "https://pretix.example/media/pub/demo/f/item-10-abc.png",
            price: "3.00", available: null, variations: [],
          },
          {
            id: 11, name: "Vin", admission: false, picture: null,
            price: "4.00", available: null, variations: [],
          },
        ],
      },
    ],
  };

  function render_(catalog: Catalog) {
    const { container } = render(
      <SaleScreen
        catalog={catalog}
        cart={[]}
        currency="EUR"
        customSale={null}
        depositBack={null}
        onAdd={vi.fn()}
        onCustomSale={vi.fn()}
        onDepositBack={vi.fn()}
        onSetCount={vi.fn()}
        onClear={vi.fn()}
        onCharge={vi.fn()}
      />,
    );
    return container;
  }

  it("shows the picture the organiser uploaded", () => {
    render_(withPicture);

    const thumb = screen.getByRole("button", { name: /Bière/ }).querySelector(".thumb");
    expect(thumb?.getAttribute("style")).toContain("item-10-abc.png");
  });

  it("is not something a screen reader has to read out", () => {
    // The name is right underneath it; the picture is there to be recognised.
    render_(withPicture);

    const thumb = screen.getByRole("button", { name: /Bière/ }).querySelector(".thumb");
    expect(thumb?.getAttribute("aria-hidden")).toBe("true");
  });

  it("shows nothing at all for a product without one", () => {
    const container = render_(withPicture);

    const wine = screen.getByRole("button", { name: /Vin/ });
    expect(wine.querySelector(".thumb")).toBeNull();
    expect(container.querySelectorAll(".thumb")).toHaveLength(1);
  });

  it("gives every variation its product's picture", () => {
    // The picture belongs to the item; a size does not have one of its own.
    const container = render_({
      categories: [
        {
          id: 1,
          name: "Bar",
          items: [
            {
              id: 21, name: "T-shirt", admission: false,
              picture: "https://pretix.example/media/pub/demo/f/item-21-xyz.png",
              price: null, available: null,
              variations: [
                { id: 100, name: "S", price: "15.00", available: null },
                { id: 101, name: "L", price: "18.00", available: null },
              ],
            },
          ],
        },
      ],
    });

    expect(container.querySelectorAll(".thumb")).toHaveLength(2);
  });

  it("puts a url with a quote in it out of harm's way", () => {
    // Asserted on the value rather than through the DOM: jsdom drops a
    // declaration it dislikes altogether, which would pass this test for the
    // wrong reason.
    const value = pictureBackground('https://pretix.example/media/pub/a");evil("');

    expect(value).toBe('url("https://pretix.example/media/pub/a\\");evil(\\"")');
    // Which is to say: the only quotes left unescaped are the two that open
    // and close the string.
    expect([...value.replace(/\\"/g, "")].filter((c) => c === '"')).toHaveLength(2);
  });

  it("leaves a url that already carries an escape of its own alone", () => {
    // Percent-encoding the whole url would turn this into %2520 and ask the
    // server for a file it has never heard of.
    expect(pictureBackground("https://pretix.example/media/pub/a%20b.png")).toBe(
      'url("https://pretix.example/media/pub/a%20b.png")',
    );
  });

  it("leaves an ordinary url alone", () => {
    expect(pictureBackground("https://pretix.example/media/pub/demo/f/item-10-abc.png")).toBe(
      'url("https://pretix.example/media/pub/demo/f/item-10-abc.png")',
    );
  });
});

describe("how many", () => {
  it("asks on the count rather than counting taps", async () => {
    const { user } = show([line()]);

    await user.click(screen.getByRole("button", { name: t("sale.quantityOf", { label: "Bière", n: 2 }) }));

    expect(screen.getByRole("heading", { name: t("sale.quantity") })).toBeDefined();
  });

  it("sets the line in one tap", async () => {
    const { user, onSetCount } = show([line()]);
    await user.click(screen.getByRole("button", { name: t("sale.quantityOf", { label: "Bière", n: 2 }) }));

    await user.click(screen.getByRole("button", { name: "6" }));

    expect(onSetCount).toHaveBeenCalledWith("10:", 6);
    expect(screen.queryByRole("heading", { name: t("sale.quantity") })).toBeNull();
  });

  it("marks the count the line is already at", async () => {
    const { user } = show([line()]);

    await user.click(screen.getByRole("button", { name: t("sale.quantityOf", { label: "Bière", n: 2 }) }));

    expect(screen.getByRole("button", { name: "2" }).getAttribute("aria-pressed")).toBe("true");
    expect(screen.getByRole("button", { name: "3" }).getAttribute("aria-pressed")).toBe("false");
  });

  it("stops at what the quota allows", async () => {
    const { user } = show([line({ available: 3 })]);

    await user.click(screen.getByRole("button", { name: t("sale.quantityOf", { label: "Bière", n: 2 }) }));

    expect((screen.getByRole("button", { name: "3" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "4" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("offers every number when there is no quota at all", async () => {
    const { user } = show([line()]);

    await user.click(screen.getByRole("button", { name: t("sale.quantityOf", { label: "Bière", n: 2 }) }));

    expect((screen.getByRole("button", { name: "12" }) as HTMLButtonElement).disabled).toBe(false);
  });

  it("takes the line out of the basket", async () => {
    const { user, onSetCount } = show([line()]);
    await user.click(screen.getByRole("button", { name: t("sale.quantityOf", { label: "Bière", n: 2 }) }));

    await user.click(screen.getByRole("button", { name: t("sale.remove") }));

    expect(onSetCount).toHaveBeenCalledWith("10:", 0);
  });

  it("changes nothing when it is dismissed", async () => {
    const { user, onSetCount } = show([line()]);
    await user.click(screen.getByRole("button", { name: t("sale.quantityOf", { label: "Bière", n: 2 }) }));

    await user.click(screen.getByRole("button", { name: t("payment.back") }));

    expect(onSetCount).not.toHaveBeenCalled();
    expect(screen.queryByRole("heading", { name: t("sale.quantity") })).toBeNull();
  });

  it("asks about the line that was tapped, not the first one", async () => {
    const { user, onSetCount } = show([
      line(),
      line({ key: "11:", itemId: 11, label: "Vin", unitPrice: 400, count: 1 }),
    ]);

    await user.click(screen.getByRole("button", { name: t("sale.quantityOf", { label: "Vin", n: 1 }) }));
    await user.click(screen.getByRole("button", { name: "4" }));

    expect(onSetCount).toHaveBeenCalledWith("11:", 4);
  });
});
