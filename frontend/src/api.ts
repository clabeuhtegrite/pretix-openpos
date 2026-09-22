import { markReachable, markUnreachable } from "./connectivity";
import type {
  Attendance, AttendeeMatch, CancelResult, Catalog, History, InitializeResponse,
  OfflineSnapshot, Pairing, PosConfig, PosEventList, RedeemResult, SaleResult,
  SummaryResponse, TerminalPayment,
} from "./types";

const BASE = "/api/v1";

export class ApiError extends Error {
  readonly status: number;
  readonly body: unknown;

  constructor(status: number, message: string, body?: unknown) {
    super(message);
    this.name = "ApiError";
    this.status = status;
    this.body = body;
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
  } = {},
): Promise<T> {
  const { method = "GET", body, token, signal } = options;
  const timeout = withTimeout(
    signal,
    options.timeoutMs ?? (method === "GET" ? READ_TIMEOUT_MS : WRITE_TIMEOUT_MS),
  );

  try {
    return await send<T>(path, { method, body, token, signal, inner: timeout.signal });
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
  },
): Promise<T> {
  const { method, body, token, signal, inner } = options;

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
    markUnreachable();
    throw new ApiError(0, "network", e);
  }
  // An answer of any kind — even a refusal — means the server is there.
  markReachable();

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
    if (response.status >= 500) markUnreachable();
    throw new ApiError(response.status, describe(parsed, `HTTP ${response.status}`), parsed);
  }
  return parsed as T;
}

/**
 * Whether a failure means "not now" rather than "no".
 *
 * The distinction is what makes both the offline queue and a retried
 * cancellation safe. A transport failure or any fault from the server means the
 * request was not processed — or that we cannot know, which comes to the same
 * thing because every one of them carries an idempotency key — so it is worth
 * repeating verbatim. Only a 4xx is the server understanding and refusing, and
 * that is the one case where retrying forever would hide a problem instead of
 * solving it.
 *
 * Getting this wrong in the lenient direction costs a duplicate request. Getting
 * it wrong the other way takes a paid sale out of the queue and it never reaches
 * pretix at all — which is exactly what an early version of this did.
 */
export function isRetryable(error: unknown): boolean {
  return error instanceof ApiError && (error.isNetwork || error.status >= 500);
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

export const api = {
  /** Exchange a one-shot pairing code for a long-lived device token. */
  initialize(initializationToken: string): Promise<InitializeResponse> {
    return request<InitializeResponse>("/device/initialize", {
      method: "POST",
      body: {
        token: initializationToken,
        hardware_brand: "Browser",
        hardware_model: navigator.platform || "unknown",
        os_name: "Web",
        os_version: navigator.userAgent.slice(0, 100),
        software_brand: "pretix-openpos",
        software_version: __APP_VERSION__,
      },
    });
  },

  config(p: Pairing): Promise<PosConfig> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/config/`, {
      token: p.token,
    });
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
      /** Set only when replaying a sale rung up with no network. */
      offline?: { recorded_at: string; charged_total: string };
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

  summary(p: Pairing): Promise<SummaryResponse> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/summary/`, {
      token: p.token,
    });
  },

  /**
   * How many people are inside, for one check-in list.
   *
   * Read from the server rather than counted in the app: several doors scan the
   * same event at once, and tickets also get checked in as they are sold, so a
   * tally kept in this browser would only ever know about its own scans.
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
    { secret, lists, nonce, force = false, datetime }: {
      secret: string;
      lists: number[];
      nonce: string;
      force?: boolean;
      /** When the scan happened, for one replayed from an offline queue. */
      datetime?: string;
    },
  ): Promise<RedeemResult> {
    try {
      return await request<RedeemResult>(`/organizers/${p.organizer}/checkinrpc/redeem/`, {
        method: "POST",
        token: p.token,
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
};
