import {
  bigint,
  boolean,
  doublePrecision,
  index,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uuid,
} from "drizzle-orm/pg-core";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { BacktestSummary, Book, StrategySpec } from "@/lib/engine";

const timestamps = {
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true })
    .defaultNow()
    .notNull()
    .$onUpdate(() => new Date()),
};

/** An agent chat. `items` is the Responses API history, replayed on every turn. */
export const conversations = pgTable("conversations", {
  id: uuid("id").primaryKey().defaultRandom(),
  title: text("title").notNull(),
  items: jsonb("items").$type<ResponseInputItem[]>().notNull().default([]),
  /** idle, running, or awaiting_approval (a plan is waiting for the user). */
  status: text("status").notNull().default("idle"),
  /** Shown to demo visitors as a replay. */
  public: boolean("public").notNull().default(false),
  ...timestamps,
});

/**
 * What a tool call produced, for the UI to render as a card. The model only sees a compact
 * summary; the full result (equity curves, trades) lives here.
 */
export const toolRuns = pgTable(
  "tool_runs",
  {
    callId: text("call_id").primaryKey(),
    conversationId: uuid("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    data: jsonb("data").notNull(),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("tool_runs_conversation").on(t.conversationId)],
);

export const strategies = pgTable("strategies", {
  id: uuid("id").primaryKey().defaultRandom(),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  spec: jsonb("spec").$type<StrategySpec>().notNull(),
  description: jsonb("description").$type<string[]>().notNull(),
  backtest: jsonb("backtest").$type<BacktestSummary>().notNull(),
  public: boolean("public").notNull().default(true),
  ...timestamps,
});

/**
 * A paper portfolio: a virtual sub-ledger on the shared Alpaca paper account. `book` has the
 * engine's shape, so it goes straight into /v1/decide.
 */
export const portfolios = pgTable("portfolios", {
  id: uuid("id").primaryKey().defaultRandom(),
  strategyId: uuid("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** active, paused or stopped. */
  status: text("status").notNull().default("active"),
  initialCash: doublePrecision("initial_cash").notNull(),
  book: jsonb("book").$type<Book>().notNull(),
  /** The last bar date (unix seconds) decisions were made for. */
  lastDecidedT: bigint("last_decided_t", { mode: "number" }),
  ...timestamps,
});

export const orders = pgTable(
  "orders",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    /** What the engine asked for: {type: buy, dollars} / {type: sell, fraction} / {type: target, weight}. */
    intent: jsonb("intent").notNull(),
    reason: text("reason").notNull(),
    decidedT: bigint("decided_t", { mode: "number" }).notNull(),
    /** pending, submitted, filled, canceled, rejected or skipped. */
    status: text("status").notNull().default("pending"),
    alpacaOrderId: text("alpaca_order_id"),
    qty: doublePrecision("qty"),
    notional: doublePrecision("notional"),
    fillQty: doublePrecision("fill_qty"),
    fillPrice: doublePrecision("fill_price"),
    error: text("error"),
    submittedAt: timestamp("submitted_at", { withTimezone: true }),
    filledAt: timestamp("filled_at", { withTimezone: true }),
    createdAt: timestamps.createdAt,
  },
  (t) => [index("orders_portfolio").on(t.portfolioId), index("orders_status").on(t.status)],
);

export const equitySnapshots = pgTable(
  "equity_snapshots",
  {
    portfolioId: uuid("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    t: bigint("t", { mode: "number" }).notNull(),
    equity: doublePrecision("equity").notNull(),
  },
  (t) => [primaryKey({ columns: [t.portfolioId, t.t] })],
);

/**
 * Named leases, for work that must not overlap (paper trading cycles). A row lease works
 * through connection poolers, where session advisory locks don't.
 */
export const leases = pgTable("leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
});
