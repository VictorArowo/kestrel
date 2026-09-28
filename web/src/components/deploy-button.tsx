"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { money } from "@/lib/format";

export function DeployButton({ strategyId }: { strategyId: string }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [cash, setCash] = useState(25_000);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function deploy() {
    setBusy(true);
    setError(null);
    const res = await fetch("/api/portfolios", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ strategyId, initialCash: cash }),
    });
    const body = await res.json();
    if (res.ok) router.push(`/portfolios/${body.id}`);
    else {
      setBusy(false);
      setError(body.error ?? "couldn't deploy");
    }
  }

  if (!open) {
    return (
      <button className="btn btn-primary" onClick={() => setOpen(true)}>
        Paper trade
      </button>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex items-center gap-2 text-xs text-dim">
        starting cash
        <input
          autoFocus
          type="number"
          min={1000}
          step={1000}
          value={cash}
          onChange={(e) => setCash(Number(e.target.value))}
          className="w-28 h-7 px-2 bg-canvas border border-line-strong rounded-[2px] text-ink"
        />
      </label>
      <button className="btn btn-primary" onClick={deploy} disabled={busy || !(cash >= 1000)}>
        {busy ? "Deploying" : `Deploy with ${money(cash)}`}
      </button>
      <button className="btn" onClick={() => setOpen(false)}>
        Cancel
      </button>
      {error && <span className="text-xs text-down">{error}</span>}
    </div>
  );
}
