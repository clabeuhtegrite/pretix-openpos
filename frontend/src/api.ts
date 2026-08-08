import type {
  Catalog, EventSummary, InitializeResponse, Pairing, PosConfig, SaleResult,
  SummaryResponse,
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
 * Turn a DRF error body into something a cashier can act on.
 *
 * Errors arrive either as {"detail": "..."} or as {"field": ["msg", ...]}; the
 * second shape is what validation failures look like, and it is the one that
 * actually matters at the till ("this product is not on sale here").
 */
function describe(body: unknown, fallback: string): string {
  if (typeof body === "string" && body.trim()) return body;
  if (body && typeof body === "object") {
    const record = body as Record<string, unknown>;
    if (typeof record.detail === "string") return record.detail;
    const parts: string[] = [];
    for (const value of Object.values(record)) {
      if (Array.isArray(value)) parts.push(value.map(String).join(" "));
      else if (typeof value === "string") parts.push(value);
    }
    if (parts.length) return parts.join(" ");
  }
  return fallback;
}

async function request<T>(
  path: string,
  options: { method?: string; body?: unknown; token?: string; signal?: AbortSignal } = {},
): Promise<T> {
  const { method = "GET", body, token, signal } = options;

  let response: Response;
  try {
    response = await fetch(`${BASE}${path}`, {
      method,
      signal,
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: `Device ${token}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (e) {
    if (e instanceof DOMException && e.name === "AbortError") throw e;
    throw new ApiError(0, "network", e);
  }

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
    throw new ApiError(response.status, describe(parsed, `HTTP ${response.status}`), parsed);
  }
  return parsed as T;
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

  listEvents(organizer: string, token: string): Promise<{ results: EventSummary[] }> {
    return request(`/organizers/${organizer}/events/?live=true`, { token });
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
      positions: { item: number; variation: number | null; count: number }[];
      payment_type: string;
      cash_given?: string | null;
      cashier?: string;
    },
  ): Promise<SaleResult> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/checkout/`, {
      method: "POST",
      body: payload,
      token: p.token,
    });
  },

  summary(p: Pairing): Promise<SummaryResponse> {
    return request(`/organizers/${p.organizer}/events/${p.event}/openpos/summary/`, {
      token: p.token,
    });
  },
};
