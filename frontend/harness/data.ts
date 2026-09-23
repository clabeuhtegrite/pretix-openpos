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

export const summary = {
  since: new Date(new Date().setHours(6, 0, 0, 0)).toISOString(),
  device: { count: 41, cash: "218.50", card: "96.00", total: "314.50", cancellations: 1, deposit_refunds: 7 },
  event: { count: 128, cash: "742.00", card: "410.50", total: "1152.50", cancellations: 3, deposit_refunds: 19 },
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
    // The last six o'clock in the morning: "tonight", as the server counts it.
    since: new Date(
      new Date().setHours(6, 0, 0, 0) - (new Date().getHours() < 6 ? 86_400_000 : 0),
    ).toISOString(),
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

/** The notes and coins the server lists for EUR, largest first. */
const euro = [
  ...["200", "100", "50", "20", "10", "5"].map((v) => ({ value: `${v}.00`, kind: "note" as const })),
  ...["2.00", "1.00", "0.50", "0.20", "0.10", "0.05", "0.02", "0.01"].map((value) => ({
    value,
    kind: "coin" as const,
  })),
];

export const drawerInfo = {
  id: 3,
  name: "Bar",
  opening_float: "150.00",
  currency: "EUR",
  denominations: euro,
};

/** Cash sold into the drawer tonight, as the server would add it up. */
export const drawerSales = "312.50";

const tonight = (hours: number, minutes = 0) => {
  const at = new Date();
  at.setHours(hours, minutes, 0, 0);
  // Before six in the morning it is still last night's evening.
  if (new Date().getHours() < 6 && hours >= 12) at.setDate(at.getDate() - 1);
  return at.toISOString();
};

export const drawerSession = () => ({
  id: 9,
  opened_at: tonight(18, 2),
  opened_by: "Alex",
  opening_float: "150.00",
  stale: false,
  movements: [
    { seq: 2, kind: "in", datetime: tonight(20, 15), amount: "50.00", reason: "Complément de monnaie", cashier: "Alex", device: "Caisse bar 1" },
    { seq: 3, kind: "out", datetime: tonight(22, 40), amount: "200.00", reason: "Mise au coffre", cashier: "Sam", device: "Caisse bar 2" },
  ],
  count: null as null | Record<string, unknown>,
});

export const lastClosed = () => ({
  id: 8,
  opened_at: tonight(18, 0),
  closed_at: tonight(23, 58),
  cashier: "Alex",
  amount: "311.50",
  expected: "312.50",
  difference: "-1.00",
});
