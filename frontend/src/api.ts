import { noteServerTime } from "./clock";
import { markReachable, markUnreachable } from "./connectivity";
import type {
  Attendance, AttendeeMatch, CancelResult, Catalog, DeviceDescription, DeviceStatus,
  DrawerAnswer, DrawerState, History, InitializeResponse, OfflineSnapshot, Pairing, PosConfig,
  PosEventList, RedeemResult, SaleResult, SummaryResponse, TerminalPayment,
} from "./types";

const BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;
  /**
   * How long the server asked to be left alone, when it said: a 429's
   * ``Retry-After``, in milliseconds. Null when it did not say.
   */
  readonly retryAfterMs: number | null;

  constructor(status: number, message: string, body?: unknown, retryAfterMs: number | null = null) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
    this.retryAfterMs = retryAfterMs;
  }

  /** True when the request never reached the server. */
  get isNetwork(): boolean {
    return this.status === 0;
  }
}

/**
 * The human-readable part of a DRF error body.
 *
 * Field errors are lists of messages, and stay lists however deep they sit: a
 * refused position arrives as {"positions": [{}, {"item": ["…"]}]}, and every
 * one of those strings is something a cashier can act on. A plain string under
 * a field, on the other hand, is data rather than prose — that is how the
 * checkout's "code" and "total" travel alongside its message, and reading
 * them out produced "… price_changed 17.00" on the payment panel. Before
 * this descended into lists, the position case came out as "[object Object]".
 */
function fieldMessages(value: unknown, inList = false): string[] {
  if (typeof value === "string") return inList && value.trim() ? [value] : [];
  if (Array.isArray(value)) return value.flatMap((item) => fieldMessages(item, true));
  if (value && typeof value === "object") {
    return Object.values(value).flatMap((item) => fieldMessages(item, inList));
  }
  return [];
}

/**
 * Turn an error body into something a cashier can act on.
 *
 * Errors arrive either as {"detail": "..."} or as {"field": ["msg", ...]}; the
 * second shape is what validation failures look like, and it is the one that
 * actually matters at the till ("this product is not on sale here"). A body
 * that is not JSON is a page — a gateway or a CDN answering for pretix — and
 * markup is no message for anyone: the status stands in for it.
 */
function describe(body: unknown, fallback: string): string {
  if (typeof body === "string") {
    const text = body.trim();
    return text && !text.startsWith("<") ? text : fallback;
  }
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    const parts = fieldMessages(record);
    if (parts.length) return parts.join(" ");
  }
  return fallback;
}

/**
 * ``Retry-After``, read as the milliseconds to wait from now.
 *
 * The header comes in two spellings — a number of seconds, or a date — and
 * both are read, because what sits in front of pretix is not always pretix: a
 * proxy or a CDN rate-limiting the venue's one public address is as likely to
 * send it as the server itself. Anything else is no answer rather than a
 * guess.
 */
export function parseRetryAfter(value: string | null, now = Date.now()): number | null {
  if (!value) return null;
  const text = value.trim();
  if (/^\d+$/.test(text)) return Number(text) * 1000;
  const at = Date.parse(text);
  return Number.isFinite(at) ? Math.max(at - now, 0) : null;
}

/**
 * How long a request may hang before the till calls it a dead network.
 *
 * The failure this exists for is the venue wifi that accepts the socket and
 * then leads nowhere — a captive portal, a half-open TCP, an access point with
 * no uplink. Without a bound the browser sits on that for its own minute and
 * more, and for all that time the till believes it is online: no offline
 * queue, no keypad, a confirm button that does nothing. Bounding it turns a
 * hang into the thing the app already knows how to survive.
 *
 * Generous, because the cost of being wrong is asymmetric. Going offline a few
 * seconds early costs one replayed request; cutting off a write that the
 * server was in the middle of committing costs an operator's confidence in the
 * screen. Writes get longer still: ``terminal/start`` waits on SumUp, which
 * the server itself allows twenty seconds for.
 */
const READ_TIMEOUT_MS = 15_000;
const WRITE_TIMEOUT_MS = 30_000;

/**
 * A signal that gives up after `ms`, and still obeys the caller's own.
 *
 * Hand-rolled rather than `AbortSignal.timeout` with `AbortSignal.any`: the
 * latter landed in Safari 17.4, so an older iPad would silently get no timeout
 * at all — which is exactly the failure being removed here, reintroduced on
 * the devices most likely to be on a venue's wifi.
 */
function withTimeout(signal: AbortSignal | undefined, ms: number) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  const relay = () => controller.abort();
  if (signal) {
    if (signal.aborted) relay();
    else signal.addEventListener("abort", relay);
  }
  return {
    signal: controller.signal,
    done() {
      clearTimeout(timer);
      signal?.removeEventListener("abort", relay);
    },
  };
}

async function request<T>(
  path: string,
  options: {
    method?: string;
    body?: unknown;
    token?: string;
    signal?: AbortSignal;
    timeoutMs?: number;
    /**
     * A request nobody is waiting on, whose failure says nothing the till
     * should act on: the status report. It still brings the till back online
     * when it is answered, but a failure of its own does not take it offline —
     * see ``api.deviceStatus``.
     */
    background?: boolean;
  } = {},
): Promise<T> {
  const { method = "GET", body, token, signal, background = false } = options;
  const timeout = withTimeout(
    signal,
    options.timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
  );

  try {
    return await send<T>(path, { method, body, token, signal, inner: timeout.signal, background });
  } finally {
    timeout.done();
  }
}

async function send<T>(
  path: string,
  options: {
    method: string;
    body?: unknown;
    token?: string;
    /** The caller's own signal, for telling their abort from our timeout. */
    signal?: AbortSignal;
    inner: AbortSignal;
    background: boolean;
  },
): Promise<T> {
  const { method, body, token, signal, inner, background } = options;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal: inner,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Device ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    // The caller changed its mind — a screen closed, a poll superseded. That
    // is not a verdict on the network and must not move the till offline.
    if (signal?.aborted) throw e;
    // Everything else is one fact: the request did not reach the server. Our
    // own timeout lands here too, deliberately — a request that hung for
    // fifteen seconds and one that was refused by the interface are the same
    // thing from behind the counter.
    if (!background) markUnreachable();
    throw new ApiError(0, "network", e);
  }
  // An answer of any kind — even a refusal — means the server is there. Not a
  // background request's fault, though: it would put the till online on the
  // strength of a 502, which says the opposite.
  if (!(background && response.status >= 500)) markReachable();

  const text = await response.text();
  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!response.ok) {
    // A server that faults is, from a till's point of view, a server that is not
    // there: proxies answer 502/503/504 for a backend that is down, and a 500
    // means it cannot take this sale either. The probe corrects the label within
    // seconds if it turns out only one endpoint was unwell.
    if (response.status >= 500 && !background) markUnreachable();
    throw new ApiError(
      response.status,
      describe(parsed, `HTTP ${response.status}`),
      parsed,
      parseRetryAfter(response.headers.get("Retry-After")),
    );
  }
  return parsed as T;
}

/**
 * Whether a failure leaves it unknown what the server did.
 *
 * The distinction is what makes both the offline queue and a retried
 * cancellation safe. A transport failure or any fault from the server means the
 * request was not processed — or that we cannot know, which comes to the same
 * thing because every one of them carries an idempotency key — so it is worth
 * repeating verbatim. A 4xx is the server answering, which is not the same as
 * the server refusing: see ``isRefusal`` for the one answer that is "no" for
 * good, and ``isThrottled`` for "not now".
 *
 * Getting this wrong in the lenient direction costs a duplicate request. Getting
 * it wrong the other way takes a paid sale out of the queue and it never reaches
 * pretix at all — which is exactly what an early version of this did.
 */
export function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.isNetwork || error.status >= 500);
}

/**
 * Whether a failure is the server refusing *this* request, for good.
 *
 * Narrower than "not retryable", and the difference is the whole of the rule
 * the offline queue lives by. A 400 carrying the server's reasons — the shape
 * every Open POS refusal takes — is about the request in hand: this sale, this
 * payment, this count, and sending it again will be refused again. Every other
 * status says something about the till or the moment instead. A 401 or a 403
 * is the device being turned away, and would turn away every sale in the
 * queue the same way; a 404 is an address that is not there; a 429 or a 408
 * is "not now". None of them is a reason to give up on a sale somebody has
 * already paid for, and treating them as one is how a revoked tablet emptied
 * its whole queue into the refusals list, with nothing left to send once it
 * was paired again.
 *
 * A 400 with no body to speak of — a page from a proxy — is not the server
 * speaking either, and is left out for the same reason.
 */
export function isRefusal(error: unknown): boolean {
  return (
    error instanceof ApiError &&
    error.status === 400 &&
    typeof error.body === "object" &&
    error.body !== null
  );
}

/**
 * The server, or something in front of it, asking for a moment's peace.
 *
 * A 429 is the rate limit; a 408 is a proxy that gave up waiting for the
 * request itself. Either way nothing was done, so the same request, under
 * the same key, is the right thing to send again — only not straight away.
 */
export function isThrottled(error: unknown): boolean {
  return error instanceof ApiError && (error.status === 429 || error.status === 408);
}

/**
 * The machine-readable half of a refusal, when the server sent one.
 *
 * Some 4xx answers are not refusals at all — ``terminal_unsure`` says "we
 * could not ask", which the till has to treat as a payment still running
 * rather than as one that failed. Reading that off a code rather than off the
 * message is the same rule the server keeps on its own side: prose is
 * translated, codes are not.
 */
export function errorCode(error: unknown): string | null {
  if (!(error instanceof ApiError)) return null;
  const body = error.body as { code?: unknown } | null | undefined;
  return typeof body?.code === "string" ? body.code : null;
}

/**
 * One basket line on its way to the server: products and quantities.
 *
 * The same payload for a checkout and for a card reader, because it is the
 * same statement — here is what the customer is buying, you price it. The one
 * price that travels is a free amount's, which is the only figure the till is
 * ever allowed to decide.
 */
export interface PositionPayload {
  item: number;
  variation: number | null;
  count: number;
  /** Only a replayed offline sale, or a free amount, carries one. */
  price?: string;
  /** What a free amount is for. Its presence is what marks it as one. */
  description?: string;
  /** A deposit handed back; the server still decides what it is worth. */
  refund?: boolean;
}

/**
 * This device as pretix is told about it, at pairing and after an update.
 *
 * One function for both calls, so that what a device reports after an update
 * can never drift from what it said when it paired.
 */
export function deviceDescription(): DeviceDescription {
  return {
    hardware_brand: "Browser",
    hardware_model: navigator.platform || "unknown",
    os_name: "Web",
    os_version: navigator.userAgent.slice(0, 100),
    software_brand: "pretix-openpos",
    software_version: __APP_VERSION__,
  };
}

/** A cash count as it travels: the total, and how it was made up when counted note by note. */
export interface CountPayload {
  idempotency_key: string;
  amount: string;
  /** `{"20.00": 3, "0.50": 4}`; left out when only the total was typed. */
  denominations?: Record<string, number>;
  cashier?: string;
}

function drawerPost(p: Pairing, action: string, body: unknown): Promise<DrawerAnswer> {
  return request(`/organizers/${p.organizer}/events/${p.event}/openpos/drawer/${action}/`, {
    method: "POST",
    body,
    token: p.token,
  });
}

export const api = {
  /** Exchange a one-shot pairing code for a long-lived device token. */
  initialize(initializationToken: string): Promise<InitializeResponse> {
    return request<InitializeResponse>("/device/initialize", {
      method: "POST",
      body: { token: initializationToken, ...deviceDescription() },
    });
  },

  /**
   * Tell pretix what this device runs now.
   *
   * pretix' native endpoint, the one its documentation asks every client to
   * call after an update. `useDeviceReport` decides when.
   */
  updateDevice(token: string, description: DeviceDescription): Promise<unknown> {
    return request("/device/update", { method: "POST", body: description, token });
  },

  /**
   * End this device in pretix: its token stops working, for good.
   *
   * pretix' native endpoint, the one its documentation asks any app that lets
   * a device be removed to call. `useDeviceRevoke` decides when.
   */
  revokeDevice(token: string): Promise<unknown> {
    return request("/device/revoke", { method: "POST", token });
  },

  /**
   * What this till sells and how, for its event.
   *
   * The answer carries the server's clock, and the moment of asking is
   * noted on the way through — see clock.ts — so a tablet whose clock has
   * drifted finds out at the first launch of the evening, not from a refused
   * replay at the end of it.
   */
  async config(p: Pairing): Promise<PosConfig> {
    const sentAt = Date.now();
    const config = await request<PosConfig>(
      `/organizers/${p.organizer}/events/${p.event}/openpos/config/`,
      { token: p.token },
    );
    noteServerTime(config?.server_time, sentAt, Date.now());
    return config;
  },

  catalog(p: Pairing, signal?: AbortSignal): Promise<Catalog> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/catalog/`, {
      token: p.token,
      signal,
    });
  },

  checkout(
    p: Pairing,
    payload: {
      idempotency_key: string;
      positions: PositionPayload[];
      payment_type: string;
      cash_given?: string | null;
      cashier?: string;
      expected_total?: string;
      /**
       * Set only when replaying a sale rung up with no network. ``sent_at`` is
       * this device's clock at the moment of sending, which is what lets the
       * server correct ``recorded_at`` for a tablet whose clock is wrong.
       */
      offline?: { recorded_at: string; charged_total: string; sent_at?: string };
    },
  ): Promise<SaleResult> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/checkout/`, {
      method: "POST",
      body: payload,
      token: p.token,
    });
  },

  /**
   * The guest list for one check-in list, to be carried while offline.
   *
   * Fetched while the connection is good so a dropout is survivable: without it
   * a door with no network can only guess, and guessing at a door means either
   * turning away valid tickets or admitting anything presented.
   */
  offlineSnapshot(p: Pairing, listId: number, signal?: AbortSignal): Promise<OfflineSnapshot> {
    const params = new URLSearchParams({ list: String(listId) });
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/offline/?${params}`, {
      token: p.token,
      signal,
    });
  },

  /** What this till has recorded today. Never another till's takings. */
  history(p: Pairing, signal?: AbortSignal): Promise<History> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/history/`, {
      token: p.token,
      signal,
    });
  },

  /**
   * Reverse one sale of this till.
   *
   * Carries an idempotency key like a sale does: a timeout that in fact went
   * through must not cancel a second time, nor report a failure for a
   * cancellation the server has already committed.
   */
  cancelSale(
    p: Pairing,
    payload: { seq: number; idempotency_key: string; cashier?: string; reason?: string },
  ): Promise<CancelResult> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/cancel/`, {
      method: "POST",
      body: payload,
      token: p.token,
    });
  },

  /**
   * Put the basket on this till's card reader.
   *
   * Only ever called by a till that has one. The server prices the basket,
   * keeps what it priced, and charges the card that figure — so the card and
   * the order cannot end up disagreeing. It answers as soon as SumUp has taken
   * the request, which is long before the customer has touched anything:
   * `terminalStatus` is what says how it ended.
   *
   * Carries the sale's own idempotency key, because SumUp's reader checkout
   * has none. A second call under the same key finds the payment already
   * running instead of charging the card twice.
   */
  terminalStart(
    p: Pairing,
    payload: { idempotency_key: string; positions: PositionPayload[] },
  ): Promise<TerminalPayment> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/terminal/start/`, {
      method: "POST",
      body: payload,
      token: p.token,
    });
  },

  /** How the card payment for this basket ended, or that it has not yet. */
  terminalStatus(p: Pairing, idempotencyKey: string, signal?: AbortSignal): Promise<TerminalPayment> {
    const params = new URLSearchParams({ idempotency_key: idempotencyKey });
    return request(
      `/organizers/${p.organizer}/events/${p.event}/openpos/terminal/status/?${params}`,
      { token: p.token, signal },
    );
  },

  /**
   * Take the amount back off the reader.
   *
   * Best-effort, and the answer says what actually happened rather than what
   * was asked for: a card tapped in the same second is a payment, and the till
   * is told so instead of a cancellation that did not take place.
   */
  terminalCancel(p: Pairing, idempotencyKey: string): Promise<TerminalPayment> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/terminal/cancel/`, {
      method: "POST",
      body: { idempotency_key: idempotencyKey },
      token: p.token,
    });
  },

  /**
   * This till's cash drawer: whether it is open, and what happened to it tonight.
   *
   * Never what it should hold: that figure only comes back from a count, once
   * the count is written down.
   */
  drawer(p: Pairing, signal?: AbortSignal): Promise<DrawerState> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/drawer/`, {
      token: p.token,
      signal,
    });
  },

  /** Open the drawer on the float just counted into it. */
  drawerOpen(p: Pairing, payload: CountPayload): Promise<DrawerAnswer> {
    return drawerPost(p, "open", payload);
  },

  /** Money put into the open drawer, or taken out of it, other than by a sale. */
  drawerMovement(
    p: Pairing,
    payload: {
      idempotency_key: string;
      kind: "in" | "out";
      amount: string;
      reason: string;
      cashier?: string;
    },
  ): Promise<DrawerAnswer> {
    return drawerPost(p, "movement", payload);
  },

  /** A blind count. The answer carries what the drawer should have held. */
  drawerCount(p: Pairing, payload: CountPayload): Promise<DrawerAnswer> {
    return drawerPost(p, "count", payload);
  },

  /**
   * End the evening on the count just made — or on none, which the server only
   * accepts for a drawer left open since an earlier day.
   */
  drawerClose(
    p: Pairing,
    payload: {
      idempotency_key: string;
      count_seq?: number | null;
      uncounted?: boolean;
      reason?: string;
      cashier?: string;
    },
  ): Promise<DrawerAnswer> {
    return drawerPost(p, "close", payload);
  },

  /**
   * Tell the back office what this device is holding.
   *
   * Sales rung up with no network are money pretix has not heard of yet, and
   * without this the only place anybody could see them was this screen. The
   * answer is the server's clock, which feeds the same check as the config.
   *
   * A background request: `useDeviceStatus` sends it on its own schedule and
   * nobody waits on it, so a failure is silent — and does not take the till
   * offline either, which would stop sales over a report nobody asked for.
   */
  async deviceStatus(p: Pairing, status: DeviceStatus): Promise<{ server_time?: string } | null> {
    const sentAt = Date.now();
    const answer = await request<{ server_time?: string } | null>(
      `/organizers/${p.organizer}/openpos/status/`,
      { method: "POST", body: status, token: p.token, background: true },
    );
    noteServerTime(answer?.server_time, sentAt, Date.now());
    return answer;
  },

  summary(p: Pairing): Promise<SummaryResponse> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/summary/`, {
      token: p.token,
    });
  },

  /**
   * How many people are inside, for one check-in list, and what the doors have
   * scanned tonight.
   *
   * Read from the server rather than counted in the app: several doors scan the
   * same event at once, and tickets also get checked in as they are sold, so a
   * tally kept in this browser would only ever know about its own scans — and
   * would lose even those every time iOS reloads the page.
   */
  attendance(p: Pairing, listId: number, signal?: AbortSignal): Promise<Attendance> {
    const params = new URLSearchParams({ list: String(listId) });
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/attendance/?${params}`, {
      token: p.token,
      signal,
    });
  },

  /**
   * Every event this device may reach: the ones it can sell for, and the ones
   * it cannot, with the reason.
   */
  posEvents(organizer: string, token: string): Promise<PosEventList> {
    return request(`/organizers/${organizer}/openpos/`, { token });
  },

  /**
   * Look a ticket up by name, e-mail or order code.
   *
   * The way through when a code will not scan — a crumpled printout, a dead
   * phone screen, a ticket left at home. pretix' own search backs it, so a
   * partial name, an e-mail or an order code all work through one field.
   */
  searchAttendees(
    p: Pairing,
    { listId, query, signal }: { listId: number; query: string; signal?: AbortSignal },
  ): Promise<{ results: AttendeeMatch[] }> {
    const params = new URLSearchParams({ list: String(listId), search: query });
    return request(`/organizers/${p.organizer}/checkinrpc/search/?${params}`, {
      token: p.token,
      signal,
    });
  },

  /**
   * Check a ticket in through pretix' own RPC.
   *
   * Deliberately not wrapped in a POS-specific endpoint: this is the same call
   * pretixSCAN makes, so the rules engine, revoked and blocked secrets, and the
   * exact refusal reasons all come from pretix rather than from a reimplementation
   * that would drift.
   *
   * Resolves for a refusal too — a refused ticket is an answer, not a failure —
   * and only rejects on transport or authentication problems.
   */
  async redeem(
    p: Pairing,
    { secret, lists, nonce, force = false, datetime, timeoutMs }: {
      secret: string;
      lists: number[];
      nonce: string;
      /**
       * Set on a scan replayed from the offline queue: pretix' own way of
       * saying "this was scanned with no network". It records the entry
       * whatever it would say now — the person walked in on the answer the
       * door gave at the time — and marks it as an offline scan, with the time
       * it arrived, in its check-in history and its export.
       */
      force?: boolean;
      /** When the scan happened, for one replayed from an offline queue. */
      datetime?: string;
      /** A door cannot wait as long as a sale can; see CheckinScreen. */
      timeoutMs?: number;
    },
  ): Promise<RedeemResult> {
    try {
      return await request<RedeemResult>(`/organizers/${p.organizer}/checkinrpc/redeem/`, {
        method: "POST",
        token: p.token,
        timeoutMs,
        body: {
          lists,
          secret,
          source_type: "barcode",
          type: "entry",
          force,
          // The till has no UI for check-in questions; pretix then refuses with
          // an explicit reason instead of returning an "incomplete" we could not act on.
          questions_supported: false,
          nonce,
          ...(datetime ? { datetime } : {}),
        },
      });
    } catch (e) {
      // 400/404 carry the verdict in the body; anything else is a real error.
      if (e instanceof ApiError && (e.status === 400 || e.status === 404)) {
        const body = e.body as RedeemResult | undefined;
        if (body && typeof body === "object" && "status" in body) return body;
      }
      throw e;
    }
  },

  /**
   * Tell pretix about a ticket the door turned away with no network.
   *
   * Online, pretix writes every refused scan down itself. Offline, nothing
   * did: a ticket bought after the last copy of the guest list was refused as
   * unknown and left no trace anywhere — precisely what somebody trying to
   * find out whether scans went missing needs to see. This is pretix' own
   * endpoint for it, the one pretixSCAN uses: the refusal lands in the
   * check-in history marked as made offline, against the ticket when the code
   * names one. The event is the scan's own, which is where the list lives.
   */
  reportRefusal(
    p: Pairing,
    { event, list, secret, reason, explanation, datetime, nonce }: {
      event: string;
      list: number;
      secret: string;
      reason: string;
      explanation?: string;
      datetime: string;
      nonce: string;
    },
  ): Promise<unknown> {
    return request(
      `/organizers/${p.organizer}/events/${event}/checkinlists/${list}/failed_checkins/`,
      {
        method: "POST",
        token: p.token,
        body: {
          raw_barcode: secret,
          raw_source_type: "barcode",
          error_reason: reason,
          ...(explanation ? { error_explanation: explanation } : {}),
          datetime,
          type: "entry",
          // pretix skips a refusal it already holds under this nonce, so a
          // reply lost on the way back costs a repeated request, not a row.
          nonce,
        },
      },
    );
  },
};
