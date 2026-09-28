export function pct(n: number | null | undefined, digits = 1, signed = true): string {
  if (n == null || !Number.isFinite(n)) return "—";
  const s = n.toFixed(digits);
  return `${signed && n > 0 ? "+" : ""}${s}%`;
}

export function num(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toFixed(digits);
}

export function money(n: number | null | undefined, digits = 0): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return n.toLocaleString("en-US", { style: "currency", currency: "USD", maximumFractionDigits: digits, minimumFractionDigits: digits });
}

export function date(t: number): string {
  return new Date(t * 1000).toISOString().slice(0, 10);
}

export function ago(d: Date | string): string {
  const s = (Date.now() - new Date(d).getTime()) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}

/** Tailwind colour for a signed value. Zero and unknown stay neutral. */
export function tone(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n) || Math.abs(n) < 1e-9) return "text-ink";
  return n > 0 ? "text-up" : "text-down";
}

/** A gap between two percentages, in percentage points. */
export function pts(n: number | null | undefined, digits = 1): string {
  if (n == null || !Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(digits)} pts`;
}
