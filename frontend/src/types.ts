/** Value that pretix may return either as a plain string or as a locale map. */
export type I18nString = string | Record<string, string>;

export interface Pairing {
  token: string;
  organizer: string;
  event: string;
  serial: string;
  deviceName: string;
}

export interface InitializeResponse {
  organizer: string;
  device_id: number;
  unique_serial: string;
  api_token: string;
  name: string;
  security_profile: string;
}

export interface CheckinListInfo {
  id: number;
  name: string;
  all_products: boolean;
  include_pending: boolean;
}

export interface PosConfig {
  /** Plugin version the server runs; absent on servers older than the field. */
  version?: string;
  event: {
    slug: string;
    organizer: string;
    name: string;
    currency: string;
    testmode: boolean;
    timezone: string;
  };
  device: { serial: string | null; name: string | null };
  checkin: {
    enabled: boolean;
    list_id: number | null;
    list_name: string | null;
    lists: CheckinListInfo[];
  };
  /** Ids of the event's admission products — the ones that let a person in. */
  admission_items: number[];
  cash_denominations: string[];
}

/** An event this till is allowed to sell for, i.e. Open POS is enabled on it. */
export interface PosEvent {
  slug: string;
  organizer: string;
  name: string;
  currency: string;
  testmode: boolean;
  date_from: string | null;
}

/** One hit of the attendee search, as pretix' check-in RPC returns it. */
export interface AttendeeMatch {
  id: number;
  order: string;
  secret: string;
  attendee_name: string | null;
  seat: { name?: string } | null;
  checkins: { list: number; type?: string }[];
  require_attention: boolean;
  order__status: string;
}

/** Response of pretix' own check-in RPC. */
export interface RedeemResult {
  status: "ok" | "error" | "incomplete" | "exchange";
  reason?: string;
  reason_explanation?: string | null;
  require_attention?: boolean;
  checkin_texts?: string[];
  position?: {
    order?: string;
    item?: number;
    attendee_name?: string | null;
    seat?: { name?: string } | null;
  };
  list?: { id: number; name: string };
}

export interface CatalogVariation {
  id: number;
  name: string;
  price: string;
  available: number | null;
}

export interface CatalogItem {
  id: number;
  name: string;
  admission: boolean;
  picture: string | null;
  price: string | null;
  available: number | null;
  variations: CatalogVariation[];
}

export interface CatalogCategory {
  id: number | null;
  name: string;
  items: CatalogItem[];
}

export interface Catalog {
  categories: CatalogCategory[];
}

/** One line of the basket. Prices are held in integer cents throughout. */
export interface CartLine {
  key: string;
  itemId: number;
  variationId: number | null;
  label: string;
  unitPrice: number;
  count: number;
  available: number | null;
}

export type PaymentType = "cash" | "card";

export interface SaleResult {
  order: { code: string; total: string; url: string | null };
  journal_seq: number;
  payment_type: PaymentType;
  cash_given: string | null;
  cash_change: string | null;
  datetime: string;
  replayed: boolean;
  checked_in: number | null;
  checkin_errors: string[];
  /** Lines an offline till charged at something other than today's tariff. */
  off_tariff?: { item_name: string; charged: string; tariff: string }[];
  /** Set by the app, not the server: this sale is queued, not recorded yet. */
  offline?: boolean;
}

/** One admission product's share of the room. */
export interface AttendanceItem {
  id: number;
  name: string;
  inside: number;
  entered: number;
  expected: number;
}

/**
 * How many people are inside, counted over admission products only.
 *
 * `entered` counts everyone let in at least once, so `inside + exited` comes
 * back to it, and `entered + not_arrived` comes back to `expected`.
 */
export interface Attendance {
  list: { id: number; name: string };
  computed_at: string;
  inside: number;
  entered: number;
  exited: number;
  expected: number;
  not_arrived: number;
  /** Scans of products that do not admit anyone, hence not in any figure above. */
  non_admission_entered: number;
  items: AttendanceItem[];
}

/** One line of a sale, as the journal froze it at the time. */
export interface JournalPosition {
  item: number;
  item_name: string;
  variation: number | null;
  variation_name: string | null;
  count: number;
  unit_price: string;
  line_total: string;
}

/**
 * One line of this till's journal: a sale, or the reversal of one.
 *
 * A cancellation is its own entry carrying a negative total and pointing at the
 * sale it reverses; the sale itself is never rewritten.
 */
export interface JournalLine {
  seq: number;
  kind: "sale" | "cancellation";
  datetime: string;
  order: string;
  total: string;
  payment_type: PaymentType;
  cashier: string;
  testmode: boolean;
  positions: JournalPosition[];
  reason: string;
  cancels_seq: number | null;
  /** This sale has since been cancelled. */
  cancelled: boolean;
  can_cancel: boolean;
}

export interface History {
  device: string | null;
  results: JournalLine[];
  /** More entries exist than the till shows: the event ran longer than the cap. */
  truncated: boolean;
}

export interface CancelResult {
  cancellation: JournalLine;
  /** The sale that was reversed, so its lines can go back in the basket. */
  sale: JournalLine | null;
  replayed: boolean;
  /** Number of the credit note pretix issued, when the order had an invoice. */
  credit_note: string | null;
  refunded: boolean;
}

/** One ticket of the guest list a till carries for a network dropout. */
export interface OfflineTicket {
  secret: string;
  item: number;
  name: string;
  /** Already admitted when the snapshot was taken. */
  used: boolean;
}

export interface OfflineSnapshot {
  list: { id: number; name: string };
  generated: string;
  tickets: OfflineTicket[];
  /** The event is larger than a till can carry; this list is partial. */
  truncated: boolean;
}

/** A sale rung up with no network, waiting to reach the server. */
export interface QueuedSale {
  kind: "sale";
  /** Its idempotency key, minted when the customer paid. */
  id: string;
  at: string;
  event: string;
  positions: { item: number; variation: number | null; count: number; price: string }[];
  chargedTotal: string;
  paymentType: PaymentType;
  cashGiven: string | null;
  cashChange: string | null;
  cashier: string;
  /** Whether the basket admits anyone, decided locally from the cached catalogue. */
  admits: boolean;
  label: string;
}

/** A ticket admitted at the door with no network, waiting to be recorded. */
export interface QueuedCheckin {
  kind: "checkin";
  /** The nonce pretix deduplicates on, minted at the moment of the scan. */
  id: string;
  at: string;
  event: string;
  list: number;
  secret: string;
  name: string;
}

export type QueueEntry = QueuedSale | QueuedCheckin;

/** An entry the server refused on replay: never dropped, always shown. */
export interface SyncFailure {
  entry: QueueEntry;
  at: string;
  message: string;
}

/** What a sync run did, for the operator to read afterwards. */
export interface SyncReport {
  sales: number;
  checkins: number;
  failed: number;
  /** Sales the server would have priced differently from what was charged. */
  offTariff: { order: string; item_name: string; charged: string; tariff: string }[];
  /** Tickets refused on replay — admitted at the door, contested afterwards. */
  contested: { name: string; secret: string; reason: string }[];
}

export interface Takings {
  count: number;
  /** Reversals recorded in the same window; their money is already netted off. */
  cancellations: number;
  cash: string;
  card: string;
  total: string;
}

export interface SummaryResponse {
  since: string;
  device: Takings | null;
  event: Takings;
}
