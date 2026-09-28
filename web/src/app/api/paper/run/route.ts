import { runCycle } from "@/paper/cycle";

/** Runs a paper trading cycle now. The scheduled loop (npm run paper) calls the same function. */
export async function POST() {
  return Response.json(await runCycle());
}
