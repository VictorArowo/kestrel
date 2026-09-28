import { index, integer, primaryKey, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import type { ResponseInputItem } from "openai/resources/responses/responses";
import type { BacktestSummary, Book, StrategySpec } from "@/lib/engine";

const id = () =>
  text("id")
    .primaryKey()
    .$defaultFn(() => crypto.randomUUID());

const createdAt = () =>
  integer("created_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date());

const timestamps = {
  createdAt: createdAt(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" })
    .notNull()
    .$defaultFn(() => new Date())
    .$onUpdate(() => new Date()),
};

/** An agent chat. `items` is the Responses API history, replayed on every turn. */
export const conversations = sqliteTable("conversations", {
  id: id(),
  title: text("title").notNull(),
  items: text("items", { mode: "json" }).$type<ResponseInputItem[]>().notNull().default([]),
  /** idle, running, or awaiting_approval (a plan is waiting for the user). */
  status: text("status").notNull().default("idle"),
  /** Shown to demo visitors as a replay. */
  public: integer("public", { mode: "boolean" }).notNull().default(false),
  ...timestamps,
});

/**
 * What a tool call produced, for the UI to render as a card. The model only sees a compact
 * summary; the full result (equity curves, trades) lives here.
 */
export const toolRuns = sqliteTable(
  "tool_runs",
  {
    callId: text("call_id").primaryKey(),
    conversationId: text("conversation_id")
      .notNull()
      .references(() => conversations.id, { onDelete: "cascade" }),
    name: text("name").notNull(),
    data: text("data", { mode: "json" }).notNull(),
    createdAt: createdAt(),
  },
  (t) => [index("tool_runs_conversation").on(t.conversationId)],
);

export const strategies = sqliteTable("strategies", {
  id: id(),
  conversationId: text("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  spec: text("spec", { mode: "json" }).$type<StrategySpec>().notNull(),
  description: text("description", { mode: "json" }).$type<string[]>().notNull(),
  backtest: text("backtest", { mode: "json" }).$type<BacktestSummary>().notNull(),
  public: integer("public", { mode: "boolean" }).notNull().default(true),
  ...timestamps,
});

/**
 * A paper portfolio: a virtual sub-ledger on the shared Alpaca paper account. `book` has the
 * engine's shape, so it goes straight into /v1/decide.
 */
export const portfolios = sqliteTable("portfolios", {
  id: id(),
  strategyId: text("strategy_id")
    .notNull()
    .references(() => strategies.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  /** active, paused or stopped. */
  status: text("status").notNull().default("active"),
  initialCash: real("initial_cash").notNull(),
  book: text("book", { mode: "json" }).$type<Book>().notNull(),
  /** The last bar date (unix seconds) decisions were made for. */
  lastDecidedT: integer("last_decided_t"),
  ...timestamps,
});

export const orders = sqliteTable(
  "orders",
  {
    id: id(),
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    symbol: text("symbol").notNull(),
    side: text("side").notNull(),
    /** What the engine asked for: {type: buy, dollars} / {type: sell, fraction} / {type: target, weight}. */
    intent: text("intent", { mode: "json" }).notNull(),
    reason: text("reason").notNull(),
    decidedT: integer("decided_t").notNull(),
    /** pending, submitted, filled, canceled, rejected or skipped. */
    status: text("status").notNull().default("pending"),
    alpacaOrderId: text("alpaca_order_id"),
    qty: real("qty"),
    notional: real("notional"),
    fillQty: real("fill_qty"),
    fillPrice: real("fill_price"),
    error: text("error"),
    submittedAt: integer("submitted_at", { mode: "timestamp_ms" }),
    filledAt: integer("filled_at", { mode: "timestamp_ms" }),
    createdAt: createdAt(),
  },
  (t) => [index("orders_portfolio").on(t.portfolioId), index("orders_status").on(t.status)],
);

export const equitySnapshots = sqliteTable(
  "equity_snapshots",
  {
    portfolioId: text("portfolio_id")
      .notNull()
      .references(() => portfolios.id, { onDelete: "cascade" }),
    t: integer("t").notNull(),
    equity: real("equity").notNull(),
  },
  (t) => [primaryKey({ columns: [t.portfolioId, t.t] })],
);

/** Named leases, for work that must not overlap (paper trading cycles). */
export const leases = sqliteTable("leases", {
  name: text("name").primaryKey(),
  holder: text("holder").notNull(),
  expiresAt: integer("expires_at", { mode: "timestamp_ms" }).notNull(),
});
