import { desc, eq } from "drizzle-orm";
import { db, strategies } from "@/db";
import { StrategyTable } from "@/components/strategy-table";
import { isOwner } from "@/lib/owner";

export const dynamic = "force-dynamic";
export const metadata = { title: "Strategies" };

export default async function Strategies() {
  const owner = await isOwner();
  const rows = await db
    .select()
    .from(strategies)
    .where(owner ? undefined : eq(strategies.public, true))
    .orderBy(desc(strategies.createdAt))
    .limit(200);
  return (
    <div>
      <h1 className="text-dim mb-1">Strategies</h1>
      <p className="text-2xs text-faint mb-4">Every saved strategy with its full backtest. Returns include slippage and fees.</p>
      <StrategyTable rows={rows} />
    </div>
  );
}
