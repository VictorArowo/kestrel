// A small client for Alpaca's paper trading API. Kestrel only ever talks to the paper endpoint.

const PAPER_URL = "https://paper-api.alpaca.markets";

export type AlpacaOrder = {
  id: string;
  client_order_id: string;
  symbol: string;
  side: "buy" | "sell";
  status: string;
  qty: string | null;
  notional: string | null;
  filled_qty: string;
  filled_avg_price: string | null;
  filled_at: string | null;
};

export class AlpacaError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

async function call<T>(path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const key = process.env.APCA_API_KEY_ID;
  const secret = process.env.APCA_API_SECRET_KEY;
  if (!key || !secret) throw new AlpacaError("paper trading needs APCA_API_KEY_ID and APCA_API_SECRET_KEY in .env", 401);
  const res = await fetch(`${PAPER_URL}${path}`, {
    method: init?.method ?? "GET",
    headers: {
      "APCA-API-KEY-ID": key,
      "APCA-API-SECRET-KEY": secret,
      ...(init?.body ? { "content-type": "application/json" } : {}),
    },
    body: init?.body ? JSON.stringify(init.body) : undefined,
    cache: "no-store",
  });
  const text = await res.text();
  const body = text ? JSON.parse(text) : {};
  if (!res.ok) throw new AlpacaError(body.message ?? `Alpaca returned ${res.status}`, res.status);
  return body as T;
}

export const alpaca = {
  account: () => call<{ status: string; cash: string; buying_power: string; equity: string }>("/v2/account"),
  getOrder: (id: string) => call<AlpacaOrder>(`/v2/orders/${id}`),
  /**
   * A market order. Stocks use `day`, which Alpaca queues for the next regular open when the
   * market is closed; crypto trades around the clock and uses `gtc`.
   */
  submit: (o: { clientOrderId: string; symbol: string; side: "buy" | "sell"; qty?: number; notional?: number }) =>
    call<AlpacaOrder>("/v2/orders", {
      method: "POST",
      body: {
        symbol: o.symbol,
        side: o.side,
        type: "market",
        time_in_force: o.symbol.includes("/") ? "gtc" : "day",
        client_order_id: o.clientOrderId,
        ...(o.notional != null ? { notional: o.notional.toFixed(2) } : { qty: o.qty!.toFixed(9).replace(/\.?0+$/, "") }),
      },
    }),
};
