"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { Block } from "@/lib/transcript";
import { BlockView } from "./chat";

/** How long each step of a recorded session takes to play back, in milliseconds. */
const PAUSE = { user: 700, reasoning: 500, toolRunning: 900, afterCard: 700 };
const CHARS_PER_TICK = 6;
const TICK_MS = 16;

type Step = { block: number; chars?: number; pending?: boolean };

/** Expands a transcript into playback steps: text types out, tool calls show "running" first. */
function steps(blocks: Block[]): { step: Step; wait: number }[] {
  const out: { step: Step; wait: number }[] = [];
  blocks.forEach((b, i) => {
    if (b.kind === "text") {
      for (let c = CHARS_PER_TICK; c < b.text.length; c += CHARS_PER_TICK) out.push({ step: { block: i, chars: c }, wait: TICK_MS });
      out.push({ step: { block: i }, wait: PAUSE.afterCard });
    } else if (b.kind === "tool") {
      out.push({ step: { block: i, pending: true }, wait: PAUSE.toolRunning });
      out.push({ step: { block: i }, wait: PAUSE.afterCard });
    } else {
      out.push({ step: { block: i }, wait: b.kind === "user" ? PAUSE.user : PAUSE.reasoning });
    }
  });
  return out;
}

/** Plays back a recorded agent session for demo visitors. */
export function Replay({ blocks }: { blocks: Block[] }) {
  const plan = useMemo(() => steps(blocks), [blocks]);
  const [at, setAt] = useState(0);
  const done = at >= plan.length;

  useEffect(() => {
    if (done) return;
    const id = setTimeout(() => setAt((n) => n + 1), plan[at].wait);
    return () => clearTimeout(id);
  }, [at, done, plan]);

  const current = plan[Math.min(at, plan.length - 1)]?.step;
  const bottom = useRef<HTMLDivElement>(null);
  const following = useRef(true);

  // Follow the playback, unless the visitor has scrolled up to read something.
  useEffect(() => {
    const onScroll = () => {
      following.current = window.innerHeight + window.scrollY >= document.body.scrollHeight - 160;
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    return () => window.removeEventListener("scroll", onScroll);
  }, []);
  useEffect(() => {
    if (following.current && !done) bottom.current?.scrollIntoView({ block: "end" });
  }, [at, done]);
  const visible: Block[] = done
    ? blocks
    : blocks.slice(0, (current?.block ?? 0) + 1).map((b, i) => {
        if (i !== current.block) return b;
        if (b.kind === "text" && current.chars != null) return { ...b, text: b.text.slice(0, current.chars) };
        if (b.kind === "tool" && current.pending) return { ...b, card: null, pending: true };
        return b;
      });

  return (
    <div className="max-w-[860px] mx-auto pb-32">
      <ol className="space-y-4">
        {visible.map((b) => (
          <li key={b.id}>
            <BlockView block={b} canApprove={false} onApprove={() => {}} readOnly />
          </li>
        ))}
      </ol>
      <div ref={bottom} />
      <div className="fixed bottom-0 inset-x-0 bg-gradient-to-t from-canvas via-canvas to-transparent pt-8 pb-5 px-4">
        <div className="max-w-[860px] mx-auto panel flex flex-wrap items-center gap-3 px-4 py-2.5 text-xs">
          <span className="text-dim">
            A recording of a real session with the agent. Live runs are turned off in the demo.
          </span>
          <span className="ml-auto flex gap-2">
            {done ? (
              <button
                className="btn"
                onClick={() => {
                  following.current = true;
                  window.scrollTo({ top: 0 });
                  setAt(0);
                }}
              >
                Replay
              </button>
            ) : (
              <button className="btn" onClick={() => setAt(plan.length)}>
                Skip to the end
              </button>
            )}
          </span>
        </div>
      </div>
    </div>
  );
}
