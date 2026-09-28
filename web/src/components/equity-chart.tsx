"use client";

import { useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  LineSeries,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Point } from "@/lib/engine";
import { pct } from "@/lib/format";

const STRATEGY = "#c98300";
const BENCHMARK = "#4a8ad6";

type Readout = { t: number; strategy: number | null; benchmark: number | null };

/** Both curves as percent return from the first point, on one axis. */
function toReturns(points: Point[]) {
  const base = points[0]?.v ?? 1;
  return points.map((p) => ({ time: p.t as UTCTimestamp, value: (p.v / base - 1) * 100 }));
}

export function EquityChart({
  equity,
  benchmark,
  benchmarkLabel,
  height = 280,
}: {
  equity: Point[];
  benchmark?: Point[] | null;
  benchmarkLabel?: string;
  height?: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const strategyData = toReturns(equity);
  const benchmarkData = benchmark ? toReturns(benchmark) : [];
  const last: Readout = {
    t: equity.at(-1)?.t ?? 0,
    strategy: strategyData.at(-1)?.value ?? null,
    benchmark: benchmarkData.at(-1)?.value ?? null,
  };
  const [readout, setReadout] = useState<Readout | null>(null);

  useEffect(() => {
    if (!ref.current) return;
    const chart: IChartApi = createChart(ref.current, {
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#7d8b96",
        // Canvas text can't read CSS variables, so resolve the page's font stack.
        fontFamily: getComputedStyle(document.body).fontFamily,
        fontSize: 11,
        attributionLogo: false,
      },
      grid: { vertLines: { visible: false }, horzLines: { color: "#141b21" } },
      rightPriceScale: { borderVisible: false },
      timeScale: { borderVisible: false, fixLeftEdge: true, fixRightEdge: true },
      crosshair: {
        mode: CrosshairMode.Magnet,
        vertLine: { color: "#4c5963", labelBackgroundColor: "#121920" },
        horzLine: { color: "#4c5963", labelBackgroundColor: "#121920" },
      },
      localization: { priceFormatter: (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(0)}%` },
      handleScroll: false,
      handleScale: false,
    });
    let bench: ISeriesApi<"Line"> | null = null;
    if (benchmarkData.length) {
      bench = chart.addSeries(LineSeries, {
        color: BENCHMARK,
        lineWidth: 2,
        lineStyle: LineStyle.Solid,
        priceLineVisible: false,
        lastValueVisible: false,
      });
      bench.setData(benchmarkData);
    }
    const strat = chart.addSeries(LineSeries, {
      color: STRATEGY,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    strat.setData(strategyData);
    strat.createPriceLine({ price: 0, color: "#2a3640", lineWidth: 1, lineStyle: LineStyle.Dotted, axisLabelVisible: false });
    chart.timeScale().fitContent();

    chart.subscribeCrosshairMove((param) => {
      if (!param.time) return setReadout(null);
      const s = param.seriesData.get(strat) as { value?: number } | undefined;
      const b = bench ? (param.seriesData.get(bench) as { value?: number } | undefined) : undefined;
      setReadout({ t: param.time as number, strategy: s?.value ?? null, benchmark: b?.value ?? null });
    });
    return () => chart.remove();
    // The data arrays are rebuilt each render; the chart only needs to follow the inputs.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [equity, benchmark]);

  const shown = readout ?? last;
  return (
    <figure className="m-0">
      <figcaption className="flex flex-wrap items-center gap-x-5 gap-y-1 text-2xs text-dim mb-2">
        <span className="text-ink">{new Date(shown.t * 1000).toISOString().slice(0, 10)}</span>
        <span className="flex items-center gap-1.5">
          <i className="inline-block w-3 h-0.5" style={{ background: STRATEGY }} aria-hidden />
          strategy <span className="text-ink">{pct(shown.strategy)}</span>
        </span>
        {benchmarkData.length > 0 && (
          <span className="flex items-center gap-1.5">
            <i className="inline-block w-3 h-0.5" style={{ background: BENCHMARK }} aria-hidden />
            {benchmarkLabel ?? "benchmark"} <span className="text-ink">{pct(shown.benchmark)}</span>
          </span>
        )}
      </figcaption>
      <div
        ref={ref}
        style={{ height }}
        role="img"
        aria-label={`Cumulative return: strategy ${pct(last.strategy)}${
          benchmarkData.length ? `, ${benchmarkLabel ?? "benchmark"} ${pct(last.benchmark)}` : ""
        }`}
      />
    </figure>
  );
}
