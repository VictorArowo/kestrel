import { ownerOnly } from "@/lib/owner";
import { eq } from "drizzle-orm";
import { db, portfolios, strategies } from "@/db";

/** Deploys a saved strategy to a new paper portfolio. Only ever called from a user's click. */
export async function POST(request: Request) {
  const denied = await ownerOnly();
  if (denied) return denied;
  const { strategyId, initialCash } = (await request.json()) as { strategyId?: string; initialCash?: number };
  if (!strategyId || !/^[0-9a-f-]{36}$/.test(strategyId)) return Response.json({ error: "unknown strategy" }, { status: 400 });
  if (typeof initialCash !== "number" || !(initialCash >= 1000) || initialCash > 10_000_000) {
    return Response.json({ error: "starting cash must be between $1,000 and $10,000,000" }, { status: 400 });
  }
  const s = await db.query.strategies.findFirst({ where: eq(strategies.id, strategyId) });
  if (!s) return Response.json({ error: "unknown strategy" }, { status: 404 });
  const [row] = await db
    .insert(portfolios)
    .values({ strategyId, name: s.name, initialCash, book: { cash: initialCash, positions: {} } })
    .returning({ id: portfolios.id });
  return Response.json({ id: row.id });
}
