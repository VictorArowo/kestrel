"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

const EXAMPLES = [
  "Buy large-cap tech when RSI drops below 30 while it's above the 200-day average; sell when RSI goes over 70",
  "Each month, hold the two strongest of SPY, QQQ, TLT and GLD by 3-month momentum",
  "Buy Bitcoin when it breaks a 50-day high and sell when it closes below the 20-day average",
  "Hold the 5 sector ETFs with the best 6-month return, but only while SPY is above its 200-day average",
];

export function NewStrategy() {
  const router = useRouter();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function start(idea: string) {
    const message = idea.trim();
    if (!message || busy) return;
    setBusy(true);
    setError(null);
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: message }),
    });
    const body = await res.json();
    if (!res.ok) {
      setBusy(false);
      setError(body.error ?? "couldn't start a conversation");
      return;
    }
    router.push(`/chat/${body.id}?q=${encodeURIComponent(message)}`);
  }

  return (
    <div>
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void start(text);
        }}
        className="panel flex items-start gap-3 px-4 py-3 focus-within:border-line-strong"
      >
        <span className="text-amber text-lg leading-7" aria-hidden>
          ›
        </span>
        <textarea
          autoFocus
          rows={3}
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              e.currentTarget.form?.requestSubmit();
            }
          }}
          placeholder="Describe a strategy in plain English"
          aria-label="Describe a strategy"
          className="flex-1 resize-none bg-transparent outline-none font-sans text-lg leading-7 text-ink placeholder:text-faint"
          style={{ fontStretch: "100%" }}
        />
        <button type="submit" className="btn btn-primary mt-0.5" disabled={busy || !text.trim()}>
          {busy ? "Starting" : "Build it"}
        </button>
      </form>
      {error && <p className="mt-2 text-xs text-down">{error}</p>}
      <ul className="mt-4 space-y-1.5">
        {EXAMPLES.map((ex) => (
          <li key={ex}>
            <button
              type="button"
              onClick={() => setText(ex)}
              className="text-left text-xs text-dim hover:text-ink font-sans"
              style={{ fontStretch: "100%" }}
            >
              <span className="text-faint mr-2 font-mono" aria-hidden>
                ›
              </span>
              {ex}
            </button>
          </li>
        ))}
      </ul>
    </div>
  );
}
