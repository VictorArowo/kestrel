"use client";

import { useState } from "react";

/** The owner's switch for showing a conversation to demo visitors. */
export function VisibilityToggle({ id, initial }: { id: string; initial: boolean }) {
  const [on, setOn] = useState(initial);
  const [busy, setBusy] = useState(false);
  async function toggle() {
    setBusy(true);
    const res = await fetch(`/api/conversations/${id}/visibility`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ public: !on }),
    });
    if (res.ok) setOn(!on);
    setBusy(false);
  }
  return (
    <label className="flex items-center gap-2 text-2xs text-dim cursor-pointer select-none">
      <input type="checkbox" checked={on} disabled={busy} onChange={toggle} className="accent-[var(--color-amber)]" />
      show in the demo as a replay
    </label>
  );
}
