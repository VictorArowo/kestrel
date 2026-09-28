"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export function SignInForm() {
  const router = useRouter();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const res = await fetch("/api/owner", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    if (res.ok) {
      router.push("/");
      router.refresh();
    } else {
      const body = await res.json().catch(() => ({}));
      setError(body.error ?? "Couldn't sign in.");
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="panel p-5 space-y-4">
      <label className="block">
        <span className="block text-xs text-dim mb-1.5">Owner token</span>
        <input
          type="password"
          autoFocus
          autoComplete="current-password"
          value={token}
          onChange={(e) => setToken(e.target.value)}
          className="w-full h-9 px-3 bg-canvas border border-line-strong rounded-[2px] text-ink"
        />
      </label>
      {error && <p className="text-xs text-down">{error}</p>}
      <button type="submit" className="btn btn-primary" disabled={busy || !token}>
        {busy ? "Signing in" : "Sign in"}
      </button>
    </form>
  );
}

export function SignOutButton({ className = "btn" }: { className?: string }) {
  const router = useRouter();
  return (
    <button
      className={className}
      onClick={async () => {
        await fetch("/api/owner", { method: "DELETE" });
        router.push("/");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
