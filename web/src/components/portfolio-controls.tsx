"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function PortfolioControls({ id, status }: { id: string; status: string }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  async function set(next: string) {
    setBusy(true);
    await fetch(`/api/portfolios/${id}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status: next }),
    });
    setBusy(false);
    router.refresh();
  }
  if (status === "stopped") return null;
  return (
    <div className="flex gap-2">
      <button className="btn" disabled={busy} onClick={() => set(status === "active" ? "paused" : "active")}>
        {status === "active" ? "Pause" : "Resume"}
      </button>
      <button className="btn" disabled={busy} onClick={() => confirm("Stop this portfolio for good? It keeps its positions but never trades again.") && set("stopped")}>
        Stop
      </button>
    </div>
  );
}

/** Runs a paper trading cycle now instead of waiting for the loop. */
export function RunCycleButton() {
  const router = useRouter();
  const [state, setState] = useState<{ busy: boolean; message?: string }>({ busy: false });
  async function run() {
    setState({ busy: true });
    const res = await fetch("/api/paper/run", { method: "POST" });
    const r = await res.json();
    const parts = [
      r.skipped,
      r.settled ? `${r.settled} fill${r.settled === 1 ? "" : "s"} settled` : null,
      ...(r.decided ?? []).map((d: { portfolio: string; orders: number; date: string }) => `${d.portfolio}: ${d.orders} order${d.orders === 1 ? "" : "s"} for ${d.date}`),
      ...(r.errors ?? []),
    ].filter(Boolean);
    setState({ busy: false, message: parts.length ? parts.join(". ") : "Nothing to do: every portfolio is up to date." });
    router.refresh();
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <button className="btn" onClick={run} disabled={state.busy}>
        {state.busy ? "Running" : "Run paper trading now"}
      </button>
      {state.message && <span className="text-2xs text-dim">{state.message}</span>}
    </div>
  );
}
