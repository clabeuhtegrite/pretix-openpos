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
  /**
   * The server's clock when it answered, in ISO 8601 UTC. Read by clock.ts to
   * tell a volunteer whose tablet is set to the wrong time; absent on a server
   * older than the field.
   */
  server_time?: string;
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
  /**
   * The cash drawer this device's cash goes into, when it has one.
   *
   * Null for a device with none, and absent from a server older than drawers:
   * both take cash the way every till always has.
   */
  drawer?: DrawerBrief | null;
}

/** A cash drawer as the config names it: enough to say whether cash can be taken. */
export interface DrawerBrief {
  id: number;
  name: string;
  /** An opening is running: a float was counted in and nobody has closed it. */
  open: boolean;
  /**
   * ...and it began on an earlier till day. Its money is not tonight's, so the
   * server refuses cash into it until it is closed and a new one opened.
   */
  stale: boolean;
}

/** One note or coin of the drawer's currency, for counting it one by one. */
export interface Denomination {
  value: string;
  kind: "note" | "coin";
}

/** One line of a drawer's ledger, as the till is shown it. */
export interface DrawerEntry {
  seq: number;
  kind: "open" | "in" | "out" | "count" | "close";
  datetime: string;
  /** Null only on a closing nobody counted. */
  amount: string | null;
  reason: string;
  cashier: string;
  /** The device it was written from; empty when it came from the back office. */
  device: string;
}

/** A count, with what the drawer should have held when it was made. */
export interface DrawerCount extends DrawerEntry {
  expected: string;
  difference: string;
  /** Nothing sold or moved since: the drawer can still be closed on this count. */
  current: boolean;
}

/** The opening that is running: from the float counted in, to the count at the end. */
export interface DrawerSession {
  id: number;
  opened_at: string;
  opened_by: string;
  opening_float: string;
  /** What the drawer should hold now: the float and every euro moved since. */
  expected: string;
  cash_sales: string;
  /** Cash handed back, cancellations and returned deposits: negative, or zero. */
  cash_returned: string;
  cash_in: string;
  cash_out: string;
  /** Opened on an earlier till day and never closed. */
  stale: boolean;
  movements: DrawerEntry[];
  /** The latest count, recounts included. */
  count: DrawerCount | null;
}

/** How the previous opening ended, for a drawer that is closed now. */
export interface DrawerClosing {
  id: number;
  opened_at: string;
  closed_at: string;
  cashier: string;
  /** Null when it was closed without a count. */
  amount: string | null;
  expected: string;
  difference: string | null;
}

/** Everything the drawer panel shows. */
export interface DrawerState {
  drawer: {
    id: number;
    name: string;
    /** What the organiser usually puts in at opening, when they said. */
    opening_float: string | null;
    currency: string;
    denominations: Denomination[];
  } | null;
  session: DrawerSession | null;
  last_closed: DrawerClosing | null;
}

/** The answer to anything done to a drawer: its state now, and the line just written. */
export interface DrawerAnswer extends DrawerState {
  entry: DrawerEntry & { expected?: string | null; difference?: string | null };
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
  order: { code: string; total: string };
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
 * The scanner's counter, as the server counts it: every scan of the event,
 * whatever day it was made (in a series, of one date: the list's, or tonight's).
 *
 * It used to be kept by the app, and it went back to zero whenever iOS reloaded
 * the page; pretix writes every scan down anyway, so that is where it is read.
 */
export interface DoorScans {
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
  /**
   * The reversing line in this till's journal. Always there for a
   * cancellation made by this request; typed as optional because the app also
   * shows answers handed back for one made before — perhaps in the back
   * office, which leaves no line on any till — and it reads the sale in its
   * place rather than trusting every server to invent one.
   */
  cancellation: JournalLine | null;
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
   * nothing to hand over. `"pending"` means SumUp would not take the refund
   * yet — it refuses one asked for right after the payment — and the server
   * asks again on its own until it does: nothing to hand over either, the card
   * gets the money a little later. `"failed"` means it is still on their card
   * and somebody has to refund it from the SumUp app, which is the one outcome
   * that must not be shown as a cancellation that looks complete.
   *
   * Absent from a server older than the card reader; `"pending"` from one
   * older than 0.24.0.
   */
  card_refund?: "none" | "done" | "already" | "pending" | "failed";
  /**
   * The sale had been cancelled before this request, and this is that earlier
   * cancellation handed back — sent by a server that answers a repeated
   * cancellation with what it did rather than with a refusal. Absent from an
   * older one, which answers 400.
   */
  already_cancelled?: boolean;
  /**
   * ...and it was pretix' back office that cancelled it, not a till. Its
   * journal line is on no till, nothing left this one's drawer for it, and
   * the refund is pretix' business.
   */
  by_back_office?: boolean;
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
  /**
   * What the lines add up to, when that is not what was charged.
   *
   * Set on a card sale the reader took, and only there. The server priced
   * that basket when it put it on the reader, and records the order from what
   * it pinned then; the lines here carry this till's own prices, which can be
   * a catalogue refresh behind. The replay's checksum is the sum of the lines
   * it sends, so it is sent this figure — while the screens go on showing
   * ``chargedTotal``, which is what the card actually paid.
   */
  linesTotal?: string;
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

/**
 * Why a sync run stopped with entries still to send.
 *
 * Only a refusal of one entry moves it out of the queue; anything else stops
 * the run and keeps everything where it was, and this says which of those it
 * was so the operator is told something they can act on.
 */
export interface SyncHalt {
  /**
   * `unreachable`: no network, or the server faulting. `device`: the server
   * turned this device away (401, 403) — revoked, or its event closed to it.
   * `wait`: rate-limited (429, 408). `other`: an answer that is neither.
   */
  kind: "unreachable" | "device" | "wait" | "other";
  /** The server's words, through describeError. */
  message: string;
  /** Epoch milliseconds before which an automatic run should not try again. */
  retryAt: number | null;
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
  /** Set when the run stopped short; absent when it sent all it could. */
  halted?: SyncHalt | null;
}

/**
 * A payment on its way, written down before the request that makes it leaves.
 *
 * The till can be killed at any moment — iOS reclaims a PWA in the
 * background, a battery dies, somebody pulls down to refresh — and the one
 * moment that must survive it is the one between "the request went out" and
 * "the answer came back". The key is the part that matters: sent again under
 * it, the server finds what it already did instead of doing it twice.
 */
export interface PendingPayment {
  /** The event the sale belongs to. */
  event: string;
  /** The idempotency key the request travels under — for a reader payment, the reader's. */
  key: string;
  /**
   * `reader`: the basket is on the card reader, or on its way there, and
   * nothing is recorded yet. `sale`: the sale itself has been sent.
   */
  stage: "reader" | "sale";
  paymentType: PaymentType;
  cashGiven: string | null;
  /** What the card reader took, once it has. */
  charged: string | null;
  cart: CartLine[];
  credit: Credit | null;
  cashier: string;
  /** Whether the basket lets anybody in, decided from the catalogue of the moment. */
  admits: boolean;
  /** The event's currency, for saying the amount of a payment picked up later. */
  currency: string;
  /** When the customer paid — or, for a reader payment, when it was started. */
  at: string;
}

/**
 * A reader payment this till walked away from without knowing how it ended.
 *
 * The only way it happens is the way out of a wait the server stopped
 * answering: the cashier took the sale in cash while the reader might still
 * have been asking for the card. Kept so the till can ask again once it can —
 * take it off the reader if it is still there, and say so loudly if the card
 * went through after all, because that customer has then paid twice.
 */
export interface OrphanPayment {
  event: string;
  key: string;
  /** When it was put on the reader, by this device's clock. */
  at: string;
  /** The reader's figure, when the server said; the basket's otherwise. */
  amount: string;
  currency: string;
  /** Asked to come off the reader already: it is not asked twice. */
  cancelAsked?: boolean;
  /** The card went through. Kept until somebody has read that. */
  paid?: boolean;
}

/** Money put into the drawer or taken out of it, sent and not yet answered. */
export interface PendingMovement {
  /** The device and event it was made on: a drawer answers to both. */
  serial: string;
  event: string;
  kind: "in" | "out";
  amount: string;
  reason: string;
  /** Kept until the server answers for it, whatever is retyped meanwhile. */
  key: string;
  at: string;
}

/** What this device tells the back office it is holding. */
export interface DeviceStatus {
  /** Sales rung up here and not yet taken by the server, every event together. */
  pending_sales: number;
  /** When the oldest of them was rung up. */
  oldest_pending_at: string | null;
  /** The last time a sync run sent everything it could. */
  last_sync_at: string | null;
  version: string;
}

export interface Takings {
  /** Sales, not journal rows: a cancellation or a returned cup is not a customer served. */
  count: number;
  /** Sales reversed; their money is already netted off. */
  cancellations: number;
  /** What those reversals gave back, negative, already in `cash` and `card`. */
  cancelled_total: string;
  /** Returns of cups over the counter; same story, and equally not a sale. */
  deposit_refunds: number;
  cash: string;
  card: string;
  total: string;
}

/** One product sold, net of what was reversed. */
export interface TakingsProduct {
  /** Null only on a line written by hand, never by the till. */
  item: number | null;
  variation: number | null;
  name: string;
  variation_name: string | null;
  count: number;
  total: string;
}

/** The products of one category, in the shop's order. */
export interface TakingsCategory {
  /** Null, and nameless, for the products that have no category. */
  id: number | null;
  name: string | null;
  count: number;
  total: string;
  items: TakingsProduct[];
}

export interface TakingsDevice extends Takings {
  /** Null for what was written from the back office, which is no device. */
  name: string | null;
  serial: string | null;
  /** The device asking. */
  current: boolean;
}

export interface TakingsNight extends Takings {
  /** The evening, as YYYY-MM-DD: it runs from six in the morning to six the next. */
  date: string;
}

/**
 * The cup deposits, kept out of the products.
 *
 * A deposit is money held for whoever brings the cup back, not something the
 * evening sold; `total` is what is still held.
 */
export interface TakingsDeposits {
  taken: { count: number; total: string };
  returned: { count: number; total: string };
  total: string;
}

/**
 * What the event has taken, as the server reads it from the journal.
 *
 * The event and not the day: for a plain event, everything it ever sold at a
 * till; for a series, the date being sold. Every section adds up to
 * `event.total` — the categories, the deposits and `unallocated` between them.
 */
export interface SummaryResponse {
  scope: {
    event: string;
    series: boolean;
    /** The date of the series these figures are for; null for a plain event. */
    subevent: { id: number; name: string; date_from: string } | null;
  };
  computed_at: string;
  device: Takings | null;
  event: Takings;
  testmode: Takings | null;
  categories: TakingsCategory[];
  deposits: TakingsDeposits | null;
  /** Money on journal entries that list no product; null on any journal a till wrote. */
  unallocated: string | null;
  /** Every device that sold, the biggest first, and the back office last. */
  devices: TakingsDevice[];
  /** One line per evening; only worth showing when there are several. */
  nights: TakingsNight[];
  /** The first and last sale, by the clock. */
  first: string | null;
  last: string | null;
}
