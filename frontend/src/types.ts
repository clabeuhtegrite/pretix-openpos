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

/**
 * What a device tells pretix about itself: pretix' own field names, and what
 * its device list shows beside each device's name.
 */
export interface DeviceDescription {
  hardware_brand: string;
  hardware_model: string;
  os_name: string;
  os_version: string;
  software_brand: string;
  software_version: string;
}

/** What a paired device is for. Empty means nobody has assigned it. */
export type DeviceRole = "" | "pos" | "door";

/** Whether card payments here go through a reader this device drives. */
export type CardMode = "declared" | "terminal";

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
  device: {
    serial: string | null;
    name: string | null;
    /**
     * What this device is for, as the server was told in the back office.
     *
     * `""` means nobody has said, and the till then behaves as it always has:
     * the product grid, with the door one tap away. Absent altogether on a
     * server older than the field, which reads the same way.
     */
    role?: DeviceRole;
    /**
     * How a card payment may be taken here.
     *
     * `"declared"` is the cashier taking the card in the card provider's own
     * app and telling the till it happened. `"terminal"` means a reader is
     * assigned to this device and is the only way: the server refuses a card
     * sale the reader did not validate, so this is not the app's decision to
     * make — only the thing it shows.
     */
    card?: CardMode;
  };
  checkin: {
    enabled: boolean;
    list_id: number | null;
    list_name: string | null;
    lists: CheckinListInfo[];
  };
  /** Ids of the event's admission products — the ones that let a person in. */
  admission_items: number[];
  cash_denominations: string[];
  /**
   * The product free amounts are booked against, when the organiser named one.
   *
   * Absent on a server older than the feature, which is why every reader
   * treats a missing block as "the button is off".
   */
  custom_sale?: { enabled: boolean; item: number | null; name: string | null };
  /** The cup deposit product, and what one is worth at this till today. */
  deposit?: {
    enabled: boolean;
    item: number | null;
    name: string | null;
    price: string | null;
  };
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

/**
 * An event this device may reach but cannot sell for, and why.
 *
 * Never offered as a choice — its endpoints would refuse the device — but
 * named, because it is the event somebody is looking for when the one they
 * expected is not in the list.
 */
export interface UnavailableEvent extends PosEvent {
  /** Only `plugin_disabled` so far: Open POS is not switched on for it. */
  reason: string;
}

export interface PosEventList {
  results: PosEvent[];
  /** Absent from a server older than the field. */
  unavailable?: UnavailableEvent[];
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

/**
 * One line of the basket. Prices are held in integer cents throughout.
 *
 * ``unitPrice`` is negative on a deposit being handed back, which is what
 * makes the basket total the net of the transaction and the arithmetic
 * everywhere downstream the same arithmetic.
 */
export interface CartLine {
  key: string;
  itemId: number;
  variationId: number | null;
  label: string;
  unitPrice: number;
  count: number;
  available: number | null;
  /** Why this line costs what it costs. Set on a free amount, and only there. */
  description?: string;
  /** A deposit handed back rather than taken. */
  refund?: boolean;
}

/**
 * Money the till is holding for a customer whose order it just cancelled.
 *
 * Not a basket line: it is not something being sold, it is a figure the next
 * payment is settled against, and it names the order it came from so the
 * operator can see which correction they are in the middle of.
 */
export interface Credit {
  amountCents: number;
  order: string;
}

export type PaymentType = "cash" | "card";

/** Where a card payment put on a reader has got to. */
export type TerminalStatus = "pending" | "successful" | "failed";

/**
 * One card payment on the till's own reader, as the server sees it.
 *
 * The app never learns anything about it from the reader itself — the reader
 * is driven through SumUp's cloud and answers to the server, not to this
 * browser. So this is the whole of what the till knows, and `successful` here
 * is the only thing that lets a card sale be recorded at all.
 */
export interface TerminalPayment {
  status: TerminalStatus;
  amount: string;
  currency: string;
  /** Why it did not go through, in words a cashier can read out. */
  failure: string;
}

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
  /**
   * Deposits handed back in the same breath, as a positive amount.
   *
   * They are not part of the order — pretix has nowhere to put money going
   * out — so they travel beside it, with their own journal row.
   */
  deposit_refund?: string | null;
  deposit_refund_seq?: number | null;
  /**
   * What changed hands: the order less the deposits given back with it.
   *
   * Negative when the drawer is the one paying out. Absent from an older
   * server's answer, in which case the order's own total is the whole story.
   */
  net_total?: string;
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
  /** What the doors have scanned tonight. Absent from a server older than it. */
  scans?: DoorScans;
}

/** Scans made tonight, counted by the server from pretix' own check-ins. */
export interface ScanFigures {
  /** Let in on a product that admits somebody. */
  admitted: number;
  /** Turned away, whatever the reason. */
  refused: number;
  /** Recorded, for a product that lets nobody in. */
  other: number;
  /** Of the admitted: scanned with no network and sent afterwards. */
  offline: number;
}

/** One device's line in the evening's scans. */
export interface DoorDevice extends ScanFigures {
  /** Null for scans made from the back office, which come from no device. */
  name: string | null;
  /** The device asking. */
  current: boolean;
}

/**
 * The scanner's counter, as the server counts it.
 *
 * It used to be kept by the app, and it went back to zero whenever iOS reloaded
 * the page; pretix writes every scan down anyway, so that is where it is read.
 */
export interface DoorScans {
  /** Six this morning in the event's timezone: what "tonight" means here. */
  since: string;
  /** Null when the caller is not a device. */
  device: ScanFigures | null;
  /** Every door together. */
  event: ScanFigures;
  /** Busiest first. */
  devices: DoorDevice[];
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
  /** What a free amount was for, as the cashier typed it. */
  description?: string;
}

/**
 * One line of this till's journal: a sale, or the reversal of one.
 *
 * A cancellation is its own entry carrying a negative total and pointing at the
 * sale it reverses; the sale itself is never rewritten.
 */
export interface JournalLine {
  seq: number;
  kind: "sale" | "cancellation" | "deposit_refund";
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
  /**
   * What became of the money, when a card reader this server drives took it.
   *
   * `"none"` is every other sale — cash, or a card taken on somebody's phone —
   * and the operator gives those back the way they took them. `"done"` and
   * `"already"` mean it is on its way back to the customer's card and there is
   * nothing to hand over. `"failed"` means it is still on their card and
   * somebody has to refund it from the SumUp app, which is the one outcome
   * that must not be shown as a cancellation that looks complete.
   *
   * Absent from a server older than the card reader.
   */
  card_refund?: "none" | "done" | "already" | "failed";
}

/** One ticket of the guest list a till carries for a network dropout. */
export interface OfflineTicket {
  secret: string;
  item: number;
  name: string;
  /** Already admitted when the snapshot was taken. */
  used: boolean;
  /** Blocked in pretix, which refuses it at every door. Absent when not. */
  blocked?: boolean;
  /** Valid only from, or until, this moment. Absent when the ticket has no such limit. */
  valid_from?: string;
  valid_until?: string;
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
  positions: {
    item: number;
    variation: number | null;
    count: number;
    price: string;
    description?: string;
    refund?: boolean;
  }[];
  chargedTotal: string;
  paymentType: PaymentType;
  cashGiven: string | null;
  cashChange: string | null;
  cashier: string;
  /** Whether the basket admits anyone, decided locally from the cached catalogue. */
  admits: boolean;
  label: string;
}

/**
 * A scan answered at the door with no network, waiting to reach pretix.
 *
 * Refusals too, since online pretix writes every refused scan down itself: a
 * door that was offline used to leave no trace of the tickets it turned away,
 * which is exactly what somebody looking for lost scans afterwards needs.
 */
export interface QueuedCheckin {
  kind: "checkin";
  /** The nonce pretix deduplicates on, minted at the moment of the scan. */
  id: string;
  at: string;
  event: string;
  list: number;
  secret: string;
  name: string;
  /** Set when the door said no: pretix' reason code for the refusal. */
  refused?: string;
  /** Words to go with a refusal pretix has no code of its own for. */
  explanation?: string;
  /**
   * False for a product that lets nobody in. Absent from entries queued before
   * it was recorded, which were all counted as people let in.
   */
  admits?: boolean;
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
  /** Scans sent, the refusals among them. */
  checkins: number;
  failed: number;
  /**
   * Sales left in the queue because they belong to another event.
   *
   * Not a failure and not a refusal: this till was switched, and they will go
   * when it is switched back. Counted so the badge that keeps showing them has
   * something to say for itself. Scans are never left behind: pretix takes a
   * scan for whichever event its list belongs to.
   */
  stranded: number;
  /** Sales the server would have priced differently from what was charged. */
  offTariff: { order: string; item_name: string; charged: string; tariff: string }[];
  /** Tickets refused on replay — admitted at the door, contested afterwards. */
  contested: { name: string; secret: string; reason: string }[];
}

export interface Takings {
  count: number;
  /** Reversals recorded in the same window; their money is already netted off. */
  cancellations: number;
  /** Deposits handed back; same story, and equally not a sale. */
  deposit_refunds?: number;
  /**
   * Reversals made in this window of sales rung up on an EARLIER day.
   *
   * Their money is netted off the figures below and belongs there — the cash
   * left this drawer tonight. Named separately because a takings line quietly
   * short by thirty euros is indistinguishable from a miscount, and the
   * volunteer counting is the person least able to go and find out. Null on
   * an ordinary evening.
   */
  earlier_days?: { count: number; total: string } | null;
  cash: string;
  card: string;
  total: string;
}

export interface SummaryResponse {
  since: string;
  device: Takings | null;
  event: Takings;
}
