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

export interface Takings {
  count: number;
  cash: string;
  card: string;
  total: string;
}

export interface SummaryResponse {
  since: string;
  device: Takings | null;
  event: Takings;
}
