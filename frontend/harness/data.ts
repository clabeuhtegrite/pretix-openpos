/** Fixtures for the visual harness. Not shipped: harness/ is dev-only. */

export const pairing = {
  token: "tok",
  organizer: "collectif-ano",
  event: "soiree-19-09",
  serial: "TILL-BAR-1",
  deviceName: "Caisse bar 1",
};

export const config = (over: Record<string, unknown> = {}) => ({
  version: "0.11.0",
  event: {
    slug: "soiree-19-09",
    organizer: "collectif-ano",
    name: "Soirée du 19 septembre",
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
  device: { count: 41, cash: "218.50", card: "96.00", total: "314.50", cancellations: 1, deposit_refunds: 7 },
  event: { count: 128, cash: "742.00", card: "410.50", total: "1152.50", cancellations: 3, deposit_refunds: 19 },
};

export const history = {
  truncated: false,
  results: [
    { seq: 41, order: "POS4K", datetime: "2026-09-22T21:14:00Z", total: "8.50", payment_type: "cash", cashier: "Ad", reason: "", kind: "sale", cancelled: false, can_cancel: true, testmode: false, positions: [
      { item: 10, item_name: "Bière pression 25cl", variation: null, variation_name: null, count: 2, unit_price: "0.00", line_total: "6.00", description: null },
      { item: 10, item_name: "Soft", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "2.00", description: null },
      { item: 10, item_name: "Écocup", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "0.50", description: null },
    ] },
    { seq: 40, order: "POS4J", datetime: "2026-09-22T21:11:00Z", total: "-1.00", payment_type: "cash", cashier: "Ad", reason: "", kind: "deposit_refund", cancelled: false, can_cancel: false, testmode: false, positions: [
      { item: 10, item_name: "Écocup", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "-1.00", description: null },
    ] },
    { seq: 39, order: "POS4H", datetime: "2026-09-22T21:09:00Z", total: "16.00", payment_type: "card", cashier: "Lou", reason: "", kind: "sale", cancelled: false, can_cancel: true, testmode: false, positions: [
      { item: 10, item_name: "Entrée soirée", variation: null, variation_name: null, count: 2, unit_price: "0.00", line_total: "16.00", description: null },
    ] },
    { seq: 38, order: "POS4G", datetime: "2026-09-22T21:02:00Z", total: "-7.00", payment_type: "cash", cashier: "Lou", reason: "", kind: "cancellation", cancels_seq: 36, cancelled: false, can_cancel: false, testmode: false, positions: [
      { item: 10, item_name: "Assiette végé", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "-7.00", description: null },
    ] },
    { seq: 37, order: "POS4F", datetime: "2026-09-22T20:58:00Z", total: "12.00", payment_type: "card", cashier: "Ad", reason: "", kind: "sale", cancelled: false, can_cancel: true, testmode: false, positions: [
      { item: 10, item_name: "Cocktail maison", variation: null, variation_name: null, count: 2, unit_price: "0.00", line_total: "12.00", description: null },
    ] },
    { seq: 36, order: "POS4E", datetime: "2026-09-22T20:55:00Z", total: "7.00", payment_type: "cash", cashier: "Lou", reason: "", kind: "sale", cancelled: true, can_cancel: false, testmode: false, positions: [
      { item: 10, item_name: "Assiette végé", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "7.00", description: null },
    ] },
    { seq: 35, order: "POS4D", datetime: "2026-09-22T20:51:00Z", total: "5.00", payment_type: "cash", cashier: "Ad", reason: "", kind: "sale", cancelled: false, can_cancel: true, testmode: false, positions: [
      { item: 10, item_name: "Divers", variation: null, variation_name: null, count: 1, unit_price: "0.00", line_total: "5.00", description: "Verre cassé" },
    ] },
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
};
