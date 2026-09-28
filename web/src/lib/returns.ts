import type { Point } from "./engine";

/** Percent change per calendar year, from each year's first to last point. */
export function yearlyReturns(points: Point[]): Map<number, number> {
  const out = new Map<number, number>();
  let prev: Point | null = null;
  let base: Point | null = null;
  let currentYear = NaN;
  for (const p of points) {
    const year = new Date(p.t * 1000).getUTCFullYear();
    if (year !== currentYear) {
      // Measure from the previous year's last close so no day falls between years.
      currentYear = year;
      base = prev ?? p;
    }
    out.set(year, (p.v / base!.v - 1) * 100);
    prev = p;
  }
  return out;
}
