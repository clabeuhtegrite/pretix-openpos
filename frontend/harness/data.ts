/** Fixtures for the visual harness. Not shipped: harness/ is dev-only. */

export const pairing = {
  token: "tok",
  organizer: "demo-club",
  event: "soiree-automne",
  serial: "TILL-BAR-1",
  deviceName: "Caisse bar 1",
};

export const config = (over: Record<string, unknown> = {}) => ({
  // The build's own version, so the harness does not permanently offer an
  // update: the app compares this against __APP_VERSION__ and a hard-coded
  // number goes stale at the next release.
  version: __APP_VERSION__,
  event: {
    slug: "soiree-automne",
    organizer: "demo-club",
    name: "Soirée d'automne",
    currency: "EUR",
    testmode: false,
    timezone: "Europe/Paris",
  },
  device: { serial: "TILL-BAR-1", name: "Caisse bar 1", role: "", card: "declared" },
  checkin: {
    enabled: true,
    list_id: 7,
    list_name: "Porte",
    lists: [
      { id: 7, name: "Porte", all_products: true, include_pending: false },
      { id: 8, name: "Prévente", all_products: false, include_pending: false },
    ],
  },
  admission_items: [20],
  cash_denominations: ["5.00", "10.00", "20.00", "50.00"],
  custom_sale: { enabled: true, item: 99, name: "Divers" },
  deposit: { enabled: true, item: 98, name: "Écocup", price: "1.00" },
  ...over,
});

export const catalog = {
  categories: [
    {
      id: 1,
      name: "Boissons",
      items: [
        { id: 10, name: "Bière pression 25cl", admission: false, picture: null, price: "3.00", available: null, variations: [] },
        { id: 11, name: "Bière pression 50cl", admission: false, picture: null, price: "5.50", available: null, variations: [] },
        { id: 12, name: "Bière bouteille", admission: false, picture: null, price: "4.00", available: 14, variations: [] },
        { id: 13, name: "Vin", admission: false, picture: null, price: "3.50", available: null, variations: [
          { id: 131, name: "Rouge", price: "3.50", available: null },
          { id: 132, name: "Blanc", price: "3.50", available: 6 },
        ] },
        { id: 14, name: "Soft", admission: false, picture: null, price: "2.00", available: null, variations: [] },
        { id: 15, name: "Eau", admission: false, picture: null, price: "1.00", available: null, variations: [] },
        { id: 16, name: "Café", admission: false, picture: null, price: "1.50", available: null, variations: [] },
        { id: 17, name: "Cocktail maison", admission: false, picture: null, price: "6.00", available: 3, variations: [] },
      ],
    },
    {
      id: 2,
      name: "Bouffe",
      items: [
        { id: 30, name: "Assiette végé", admission: false, picture: null, price: "7.00", available: 22, variations: [] },
        { id: 31, name: "Frites", admission: false, picture: null, price: "3.00", available: null, variations: [] },
        { id: 32, name: "Gâteau", admission: false, picture: null, price: "2.50", available: 0, variations: [] },
      ],
    },
    {
      id: 3,
      name: "Entrée",
      items: [
        { id: 20, name: "Entrée soirée", admission: true, picture: null, price: "8.00", available: null, variations: [] },
        { id: 21, name: "Entrée tarif réduit", admission: true, picture: null, price: "5.00", available: null, variations: [] },
      ],
    },
    {
      id: 4,
      name: "Soutien",
      items: [
        { id: 40, name: "Adhésion annuelle", admission: false, picture: null, price: "10.00", available: null, variations: [] },
        { id: 41, name: "T-shirt", admission: false, picture: null, price: "15.00", available: 8, variations: [
          { id: 411, name: "S", price: "15.00", available: 2 },
          { id: 412, name: "M", price: "15.00", available: 4 },
          { id: 413, name: "L", price: "15.00", available: 2 },
        ] },
      ],
    },
  ],
};

/** A device's or an evening's figures, in the shape the server answers with. */
const figures = (
  count: number, cash: string, card: string, total: string,
  { cancellations = 0, cancelled_total = "0.00", deposit_refunds = 0 } = {},
) => ({ count, cash, card, total, cancellations, cancelled_total, deposit_refunds });

const product = (
  item: number, name: string, count: number, total: string,
  variation: number | null = null, variation_name: string | null = null,
) => ({ item, variation, name, variation_name, count, total });

/**
 * What a full evening took, shaped exactly like `/openpos/summary/` answers.
 *
 * The figures add up the way the server guarantees they do — the categories
 * and the deposits to the total, the devices to the total, cash and card to
 * the total — so a screen that shows a sum that does not close is the screen's
 * fault and not the fixture's.
 *
 * ?takings=empty : nothing sold yet ; ?takings=nights : a festival over two
 * evenings ; ?takings=series : one date of a series ; ?testmode=1 adds the
 * test-mode line.
 */
export const summary = (variant: string | null, testmode = false) => {
  const evening = {
    scope: { event: "Soirée d'automne", series: false, subevent: null as null | { id: number; name: string; date_from: string } },
    since: "2026-09-26T17:02:00Z",
    computed_at: new Date().toISOString(),
    device: figures(198, "612.50", "348.00", "960.50", { cancellations: 1, cancelled_total: "-7.00", deposit_refunds: 31 }),
    event: figures(486, "1391.50", "911.50", "2303.00", { cancellations: 2, cancelled_total: "-15.00", deposit_refunds: 64 }),
    testmode: testmode ? figures(3, "23.00", "0.00", "23.00") : null,
    categories: [
      { id: 1, name: "Boissons", count: 236, total: "771.00", items: [
        product(10, "Bière pression 25cl", 96, "288.00"),
        product(11, "Bière pression 50cl", 41, "225.50"),
        product(12, "Bière bouteille", 14, "56.00"),
        product(13, "Vin", 18, "63.00", 131, "Rouge"),
        product(13, "Vin", 6, "21.00", 132, "Blanc"),
        product(14, "Soft", 37, "74.00"),
        product(15, "Eau", 12, "12.00"),
        product(16, "Café", 9, "13.50"),
        product(17, "Cocktail maison", 3, "18.00"),
      ] },
      { id: 2, name: "Bouffe", count: 81, total: "319.00", items: [
        product(30, "Assiette végé", 21, "147.00"),
        product(31, "Frites", 44, "132.00"),
        product(32, "Gâteau", 16, "40.00"),
      ] },
      { id: 3, name: "Entrée", count: 139, total: "1031.00", items: [
        product(20, "Entrée soirée", 112, "896.00"),
        product(21, "Entrée tarif réduit", 27, "135.00"),
      ] },
      { id: 4, name: "Soutien", count: 11, total: "140.00", items: [
        product(40, "Adhésion annuelle", 5, "50.00"),
        product(41, "T-shirt", 2, "30.00", 411, "S"),
        product(41, "T-shirt", 3, "45.00", 412, "M"),
        product(41, "T-shirt", 1, "15.00", 413, "L"),
      ] },
      { id: null, name: null, count: 3, total: "17.00", items: [
        product(99, "Divers", 3, "17.00"),
      ] },
    ],
    deposits: {
      taken: { count: 212, total: "212.00" },
      returned: { count: 187, total: "-187.00" },
      total: "25.00",
    },
    unallocated: null as string | null,
    devices: [
      { name: "Caisse bar 1", serial: "TILL-BAR-1", current: true, ...figures(198, "612.50", "348.00", "960.50", { cancellations: 1, cancelled_total: "-7.00", deposit_refunds: 31 }) },
      { name: "Caisse bar 2", serial: "TILL-BAR-2", current: false, ...figures(121, "318.00", "254.50", "572.50", { deposit_refunds: 33 }) },
      { name: "Porte 1", serial: "DOOR-1", current: false, ...figures(96, "276.00", "212.00", "488.00", { cancellations: 1, cancelled_total: "-8.00" }) },
      { name: "Porte 2", serial: "DOOR-2", current: false, ...figures(71, "185.00", "97.00", "282.00") },
    ],
    nights: [
      { date: "2026-09-26", ...figures(486, "1391.50", "911.50", "2303.00", { cancellations: 2, cancelled_total: "-15.00", deposit_refunds: 64 }) },
    ],
    first: "2026-09-26T17:02:00Z",
    last: "2026-09-27T01:48:00Z",
  };

  if (variant === "empty") {
    return {
      ...evening,
      device: figures(0, "0.00", "0.00", "0.00"),
      event: figures(0, "0.00", "0.00", "0.00"),
      categories: [],
      deposits: null,
      devices: [],
      nights: [],
      first: null,
      last: null,
    };
  }
  if (variant === "nights") {
    // The same total over two evenings, and a sale from the back office.
    return {
      ...evening,
      devices: [
        ...evening.devices.slice(0, 3),
        { ...evening.devices[3], ...figures(70, "185.00", "85.00", "270.00") },
        { name: null, serial: null, current: false, ...figures(1, "0.00", "12.00", "12.00") },
      ],
      nights: [
        { date: "2026-09-25", ...figures(211, "602.00", "388.50", "990.50", { cancellations: 1, cancelled_total: "-8.00", deposit_refunds: 27 }) },
        { date: "2026-09-26", ...figures(275, "789.50", "523.00", "1312.50", { cancellations: 1, cancelled_total: "-7.00", deposit_refunds: 37 }) },
      ],
    };
  }
  if (variant === "series") {
    return {
      ...evening,
      scope: {
        event: "Jeudis du collectif",
        series: true,
        subevent: { id: 12, name: "Scène ouverte", date_from: "2026-09-24T18:00:00Z" },
      },
    };
  }
  return evening;
};

export const history = {
  truncated: false,
  results: [
    { seq: 41, order: "POS4K", datetime: "2026-09-22T21:14:00Z", total: "8.50", payment_type: "cash", cashier: "Alex", reason: "", kind: "sale", cancelled: false, can_cancel: true, testmode: false, positions: [
      { item: 10, item_name: "Bière pression 25cl", variation: null, variation_name: null, count: 2, unit_price: "0.00", line_total: "6.00", description: null },
      { item: 10, item_name: "Soft", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "2.00", description: null },
      { item: 10, item_name: "Écocup", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "0.50", description: null },
    ] },
    { seq: 40, order: "POS4J", datetime: "2026-09-22T21:11:00Z", total: "-1.00", payment_type: "cash", cashier: "Alex", reason: "", kind: "deposit_refund", cancelled: false, can_cancel: false, testmode: false, positions: [
      { item: 10, item_name: "Écocup", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "-1.00", description: null },
    ] },
    { seq: 39, order: "POS4H", datetime: "2026-09-22T21:09:00Z", total: "16.00", payment_type: "card", cashier: "Lou", reason: "", kind: "sale", cancelled: false, can_cancel: true, testmode: false, positions: [
      { item: 10, item_name: "Entrée soirée", variation: null, variation_name: null, count: 2, unit_price: "0.00", line_total: "16.00", description: null },
    ] },
    { seq: 38, order: "POS4G", datetime: "2026-09-22T21:02:00Z", total: "-7.00", payment_type: "cash", cashier: "Lou", reason: "", kind: "cancellation", cancels_seq: 36, cancelled: false, can_cancel: false, testmode: false, positions: [
      { item: 10, item_name: "Assiette végé", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "-7.00", description: null },
    ] },
    { seq: 37, order: "POS4F", datetime: "2026-09-22T20:58:00Z", total: "12.00", payment_type: "card", cashier: "Alex", reason: "", kind: "sale", cancelled: false, can_cancel: true, testmode: false, positions: [
      { item: 10, item_name: "Cocktail maison", variation: null, variation_name: null, count: 2, unit_price: "0.00", line_total: "12.00", description: null },
    ] },
    { seq: 36, order: "POS4E", datetime: "2026-09-22T20:55:00Z", total: "7.00", payment_type: "cash", cashier: "Lou", reason: "", kind: "sale", cancelled: true, can_cancel: false, testmode: false, positions: [
      { item: 10, item_name: "Assiette végé", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "7.00", description: null },
    ] },
    { seq: 35, order: "POS4D", datetime: "2026-09-22T20:51:00Z", total: "5.00", payment_type: "cash", cashier: "Alex", reason: "", kind: "sale", cancelled: false, can_cancel: true, testmode: false, positions: [
      { item: 10, item_name: "Divers", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "5.00", description: "Verre cassé" },
    ] },
  ],
};

/**
 * The guest list a door carries when the network goes.
 *
 * Shaped exactly like `/openpos/offline/` answers, which is the point: the
 * harness used to invent `{ list: 7, positions: [] }` here, and `indexSnapshot`
 * read `snapshot.tickets.length` off `undefined`, so choosing the door role
 * showed a white screen and the scanner could not be looked at at all.
 */
export const offlineSnapshot = {
  list: { id: 7, name: "Porte" },
  generated: "2026-09-22T20:30:00Z",
  truncated: false,
  tickets: [
    // The first name the search offers, so a pick answered offline (?redeem=fail)
    // lands on a ticket the guest list knows.
    { secret: "aaaa1111bbbb2222", item: 20, name: "Camille Berthier", used: false },
    { secret: "cccc3333dddd4444", item: 20, name: "Dominique Ferrand", used: true },
    { secret: "eeee5555ffff6666", item: 21, name: "Sacha Lemoine", used: false },
    { secret: "gggg7777hhhh8888", item: 21, name: "", used: false },
  ],
};

export const attendance = {
  list: { id: 7, name: "Porte" },
  computed_at: "2026-09-22T21:15:00Z",
  inside: 214,
  entered: 220,
  exited: 6,
  expected: 270,
  not_arrived: 50,
  non_admission_entered: 4,
  items: [
    { id: 20, name: "Entrée soirée", inside: 168, entered: 172, expected: 200 },
    { id: 21, name: "Entrée tarif réduit", inside: 46, entered: 48, expected: 70 },
  ],
  scans: {
    device: { admitted: 64, refused: 3, other: 1, offline: 12 },
    event: { admitted: 196, refused: 7, other: 4, offline: 12 },
    devices: [
      { name: "Porte entrée 1", current: false, admitted: 92, refused: 3, other: 2, offline: 0 },
      { name: "Caisse bar 1", current: true, admitted: 64, refused: 3, other: 1, offline: 12 },
      { name: "Porte entrée 2", current: false, admitted: 39, refused: 1, other: 1, offline: 0 },
      { name: null, current: false, admitted: 1, refused: 0, other: 0, offline: 0 },
    ],
  },
};

/**
 * The same catalogue with photographs on it.
 *
 * Inline SVG rather than real files, so a screenshot run needs no network and
 * no media directory. What is being looked at is the shape of a tile carrying
 * a picture, not the picture.
 */
const swatches = ["#b45309", "#7c2d12", "#166534", "#7e22ce", "#0369a1", "#9f1239"];

function swatch(index: number, label: string): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="240" height="160">
    <rect width="240" height="160" fill="${swatches[index % swatches.length]}"/>
    <text x="120" y="92" font-family="sans-serif" font-size="28" fill="#fff"
      text-anchor="middle">${label}</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

export function withPhotos(source: typeof catalog): typeof catalog {
  let n = 0;
  return {
    categories: source.categories.map((category) => ({
      ...category,
      // Every other product, because that is how a real catalogue looks and
      // the ragged case is the one worth seeing.
      items: category.items.map((item) => ({
        ...item,
        picture: n++ % 2 === 0 ? swatch(n, item.name.slice(0, 2)) : null,
      })),
    })),
  };
}
