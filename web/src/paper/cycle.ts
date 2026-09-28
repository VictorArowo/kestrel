// One paper trading cycle: settle fills, ask the engine what each strategy wants after the latest
// close, send those orders to Alpaca, and record equity. Safe to run as often as you like: each
// portfolio decides once per bar, and a lease stops cycles overlapping.

import { randomUUID } from "node:crypto";
import { and, eq, inArray, sql } from "drizzle-orm";
import { db, equitySnapshots, leases, orders, portfolios, strategies } from "@/db";
import { type Book, type EngineOrder, engine } from "@/lib/engine";
import { AlpacaError, alpaca } from "./alpaca";

const LEASE = "paper-cycle";
const LEASE_SECONDS = 600;
const OPEN_STATUSES = ["new", "accepted", "pending_new", "partially_filled", "held", "accepted_for_bidding", "calculated"];

export type CycleReport = {
  skipped?: string;
  settled: number;
  decided: { portfolio: string; date: string; orders: number }[];
  errors: string[];
};

export async function runCycle(): Promise<CycleReport> {
  const holder = randomUUID();
  if (!(await acquire(holder))) return { skipped: "another cycle is running", settled: 0, decided: [], errors: [] };
  try {
    const report: CycleReport = { settled: 0, decided: [], errors: [] };
    report.settled = await settle(report.errors);
    await decideAll(report);
    return report;
  } finally {
    await db.delete(leases).where(and(eq(leases.name, LEASE), eq(leases.holder, holder)));
  }
}

/** Takes the lease if nobody holds it or the holder's has expired (a crashed cycle). */
async function acquire(holder: string): Promise<boolean> {
  const expiresAt = new Date(Date.now() + LEASE_SECONDS * 1000);
  const rows = await db
    .insert(leases)
    .values({ name: LEASE, holder, expiresAt })
    .onConflictDoUpdate({
      target: leases.name,
      set: { holder, expiresAt },
      setWhere: sql`${leases.expiresAt} < now()`,
    })
    .returning({ holder: leases.holder });
  return rows[0]?.holder === holder;
}

/** Applies filled orders to their portfolio's book. */
async function settle(errors: string[]): Promise<number> {
  const open = await db.select().from(orders).where(eq(orders.status, "submitted"));
  let settled = 0;
  for (const o of open) {
    try {
      const remote = await alpaca.getOrder(o.alpacaOrderId!);
      if (OPEN_STATUSES.includes(remote.status)) continue;
      const qty = Number(remote.filled_qty);
      const price = remote.filled_avg_price ? Number(remote.filled_avg_price) : null;
      await db.transaction(async (tx) => {
        if (qty > 0 && price) {
          const p = await tx.query.portfolios.findFirst({ where: eq(portfolios.id, o.portfolioId) });
          if (p) await tx.update(portfolios).set({ book: applyFill(p.book, o.symbol, o.side, qty, price, o.decidedT) }).where(eq(portfolios.id, p.id));
        }
        await tx
          .update(orders)
          .set({
            status: qty > 0 ? "filled" : remote.status,
            fillQty: qty || null,
            fillPrice: price,
            filledAt: remote.filled_at ? new Date(remote.filled_at) : null,
          })
          .where(eq(orders.id, o.id));
      });
      settled++;
    } catch (e) {
      errors.push(`settling ${o.symbol}: ${(e as Error).message}`);
    }
  }
  return settled;
}

export function applyFill(book: Book, symbol: string, side: string, qty: number, price: number, t: number): Book {
  const positions = { ...book.positions };
  const pos = positions[symbol];
  if (side === "buy") {
    const held = pos?.qty ?? 0;
    positions[symbol] = {
      qty: held + qty,
      entry_price: pos ? (held * pos.entry_price + qty * price) / (held + qty) : price,
      entry_t: pos?.entry_t ?? t,
      entry_fees: pos?.entry_fees ?? 0,
    };
    return { cash: book.cash - qty * price, positions };
  }
  const remaining = (pos?.qty ?? 0) - qty;
  if (remaining <= 1e-9) delete positions[symbol];
  else positions[symbol] = { ...pos!, qty: remaining };
  return { cash: book.cash + qty * price, positions };
}

async function decideAll(report: CycleReport) {
  const active = await db
    .select({ p: portfolios, spec: strategies.spec })
    .from(portfolios)
    .innerJoin(strategies, eq(portfolios.strategyId, strategies.id))
    .where(eq(portfolios.status, "active"));

  for (const { p, spec } of active) {
    try {
      // Decide on a settled book only.
      const inFlight = await db
        .select({ id: orders.id })
        .from(orders)
        .where(and(eq(orders.portfolioId, p.id), inArray(orders.status, ["pending", "submitted"])));
      if (inFlight.length) continue;

      const d = await engine.decide(spec, p.book);
      await db
        .insert(equitySnapshots)
        .values({ portfolioId: p.id, t: d.t, equity: d.equity })
        .onConflictDoUpdate({ target: [equitySnapshots.portfolioId, equitySnapshots.t], set: { equity: d.equity } });
      if (p.lastDecidedT != null && d.t <= p.lastDecidedT) continue;

      const planned = plan(d.orders, p.book, d.equity, d.prices);
      for (const o of planned) {
        const [row] = await db
          .insert(orders)
          .values({
            portfolioId: p.id,
            symbol: o.symbol,
            side: o.side,
            intent: o.intent,
            reason: o.reason,
            decidedT: d.t,
            qty: o.qty ?? null,
            notional: o.notional ?? null,
          })
          .returning({ id: orders.id });
        try {
          const sent = await alpaca.submit({ clientOrderId: row.id, symbol: o.symbol, side: o.side, qty: o.qty, notional: o.notional });
          await db.update(orders).set({ status: "submitted", alpacaOrderId: sent.id, submittedAt: new Date() }).where(eq(orders.id, row.id));
        } catch (e) {
          const message = e instanceof AlpacaError ? e.message : String(e);
          await db.update(orders).set({ status: "rejected", error: message }).where(eq(orders.id, row.id));
          report.errors.push(`${p.name} ${o.side} ${o.symbol}: ${message}`);
        }
      }
      await db.update(portfolios).set({ lastDecidedT: d.t }).where(eq(portfolios.id, p.id));
      report.decided.push({ portfolio: p.name, date: d.date, orders: planned.length });
    } catch (e) {
      report.errors.push(`${p.name}: ${(e as Error).message}`);
    }
  }
}

type PlannedOrder = {
  symbol: string;
  side: "buy" | "sell";
  qty?: number;
  notional?: number;
  intent: EngineOrder;
  reason: string;
};

/**
 * Turns the engine's intents into Alpaca orders. Sells go first; buys are capped by the cash the
 * book will have once they fill, estimated at the last close.
 */
export function plan(intents: EngineOrder[], book: Book, equity: number, prices: Record<string, number | null>): PlannedOrder[] {
  const sells: PlannedOrder[] = [];
  const buys: PlannedOrder[] = [];
  for (const o of intents) {
    const price = prices[o.symbol] ?? null;
    const held = book.positions[o.symbol]?.qty ?? 0;
    if (o.type === "sell" && held > 0) {
      sells.push({ symbol: o.symbol, side: "sell", qty: o.fraction >= 0.9999 ? held : held * o.fraction, intent: o, reason: o.reason });
    } else if (o.type === "buy" && held === 0) {
      buys.push({ symbol: o.symbol, side: "buy", notional: o.dollars, intent: o, reason: o.reason });
    } else if (o.type === "target" && price) {
      const diff = o.weight * equity - held * price;
      if (Math.abs(diff) < Math.max(1, equity * 0.005)) continue;
      if (diff > 0) buys.push({ symbol: o.symbol, side: "buy", notional: diff, intent: o, reason: o.reason });
      else sells.push({ symbol: o.symbol, side: "sell", qty: Math.min(held, -diff / price), intent: o, reason: o.reason });
    }
  }
  let cash = book.cash + sells.reduce((sum, s) => sum + (s.qty ?? 0) * (prices[s.symbol] ?? 0), 0);
  const funded: PlannedOrder[] = [];
  for (const b of buys) {
    // Leave a little room for the open to gap up from the last close.
    const notional = Math.min(b.notional!, cash * 0.995);
    if (notional < 1) continue;
    cash -= notional;
    funded.push({ ...b, notional: Math.floor(notional * 100) / 100 });
  }
  return [...sells, ...funded];
}
