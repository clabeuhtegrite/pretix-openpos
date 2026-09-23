import type { SummaryResponse, Takings } from "../types";

/** One slice of the takings, in the shape the server answers with. */
export function figures(
  count: number,
  cash: string,
  card: string,
  total: string,
  extra: Partial<Takings> = {},
): Takings {
  return {
    count,
    cancellations: 0,
    cancelled_total: "0.00",
    deposit_refunds: 0,
    cash,
    card,
    total,
    ...extra,
  };
}

/** An event with nothing sold yet: what a till reads before its first sale. */
export function noTakings(over: Partial<SummaryResponse> = {}): SummaryResponse {
  return {
    scope: { event: "Festival", series: false, subevent: null },
    computed_at: "2026-08-16T23:40:00.000Z",
    device: null,
    event: figures(0, "0.00", "0.00", "0.00"),
    testmode: null,
    categories: [],
    deposits: null,
    unallocated: null,
    devices: [],
    nights: [],
    first: null,
    last: null,
    ...over,
  };
}
