// Runs paper trading cycles on a loop: `npm run paper`. Each portfolio decides once per bar, so
// running this more often than daily just settles fills sooner and catches up after downtime.

import { config } from "dotenv";
config({ path: "../.env", quiet: true });

const EVERY_MINUTES = Number(process.env.KESTREL_PAPER_EVERY_MINUTES ?? 15);

async function main() {
  const { runCycle } = await import("@/paper/cycle");
  for (;;) {
    const started = new Date();
    try {
      const report = await runCycle();
      console.log(started.toISOString(), JSON.stringify(report));
    } catch (e) {
      console.error(started.toISOString(), "cycle failed:", e);
    }
    if (process.argv.includes("--once")) process.exit(0);
    await new Promise((r) => setTimeout(r, EVERY_MINUTES * 60_000));
  }
}

void main();
