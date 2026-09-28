"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentEvent, ConversationStatus } from "@/agent/run";
import type { Block } from "@/lib/transcript";
import { Markdown } from "./markdown";
import { TOOL_LABELS, ToolCard } from "./tool-cards";

export function Chat({
  conversationId,
  initialBlocks,
  initialStatus,
  autoSend,
}: {
  conversationId: string;
  initialBlocks: Block[];
  initialStatus: ConversationStatus;
  /** A first message to send on arrival, from the new-strategy prompt. */
  autoSend?: string;
}) {
  const [blocks, setBlocks] = useState(initialBlocks);
  const [status, setStatus] = useState<ConversationStatus>(initialStatus);
  const [draft, setDraft] = useState("");
  const sent = useRef(false);
  const bottom = useRef<HTMLDivElement>(null);

  const apply = useCallback((e: AgentEvent) => {
    setBlocks((prev) => {
      const next = [...prev];
      const find = (id: string) => next.findIndex((b) => b.id === id);
      switch (e.type) {
        case "text":
        case "reasoning": {
          const i = find(e.itemId);
          if (i >= 0) {
            const b = next[i] as Extract<Block, { kind: "text" | "reasoning" }>;
            next[i] = { ...b, text: b.text + e.delta };
          } else {
            next.push({ kind: e.type, id: e.itemId, text: e.delta });
          }
          return next;
        }
        case "tool_start":
          if (find(e.callId) < 0) next.push({ kind: "tool", id: e.callId, name: e.name, card: null, pending: true });
          return next;
        case "tool_result": {
          const i = find(e.callId);
          const block: Block = { kind: "tool", id: e.callId, name: e.name, card: e.card, pending: false };
          if (i >= 0) next[i] = block;
          else next.push(block);
          return next;
        }
        case "error":
          next.push({ kind: "error", id: `e${Date.now()}`, text: e.message });
          return next;
        default:
          return prev;
      }
    });
    if (e.type === "status") setStatus(e.status);
  }, []);

  const send = useCallback(
    async (text: string) => {
      const message = text.trim();
      if (!message) return;
      setBlocks((prev) => [...prev, { kind: "user", id: `u${Date.now()}`, text: message }]);
      setStatus("running");
      try {
        const res = await fetch(`/api/conversations/${conversationId}/messages`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text: message }),
        });
        if (!res.ok || !res.body) {
          const body = await res.json().catch(() => ({}));
          apply({ type: "error", message: body.error ?? `request failed (${res.status})` });
          setStatus("idle");
          return;
        }
        const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
        let buffer = "";
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          buffer += value;
          let cut: number;
          while ((cut = buffer.indexOf("\n\n")) >= 0) {
            const frame = buffer.slice(0, cut);
            buffer = buffer.slice(cut + 2);
            if (frame.startsWith("data: ")) apply(JSON.parse(frame.slice(6)) as AgentEvent);
          }
        }
      } catch {
        apply({ type: "error", message: "lost the connection; the agent keeps working, so reload in a moment" });
        setStatus("idle");
      }
    },
    [apply, conversationId],
  );

  useEffect(() => {
    if (autoSend && !sent.current && initialBlocks.length === 0) {
      sent.current = true;
      window.history.replaceState(null, "", `/chat/${conversationId}`);
      void send(autoSend);
    }
  }, [autoSend, conversationId, initialBlocks.length, send]);

  useEffect(() => {
    bottom.current?.scrollIntoView({ block: "end" });
  }, [blocks]);

  const running = status === "running";
  const lastPlan = [...blocks].reverse().find((b) => b.kind === "tool" && b.name === "propose_plan");

  return (
    <div className="max-w-[860px] mx-auto pb-40">
      <ol className="space-y-4">
        {blocks.map((b) => (
          <li key={b.id}>
            <BlockView
              block={b}
              canApprove={status === "awaiting_approval" && b === lastPlan}
              onApprove={() => void send("Approved, go ahead.")}
            />
          </li>
        ))}
        {running && (
          <li className="text-xs text-dim flex items-center gap-2" aria-live="polite">
            <span className="inline-block w-2 h-3.5 bg-amber animate-pulse" aria-hidden />
            working
          </li>
        )}
      </ol>
      <div ref={bottom} />
      <form
        className="fixed bottom-0 inset-x-0 bg-gradient-to-t from-canvas via-canvas to-transparent pt-8 pb-5 px-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (running) return;
          void send(draft);
          setDraft("");
        }}
      >
        <div className="max-w-[860px] mx-auto panel flex items-start gap-3 px-3 py-2 focus-within:border-line-strong">
          <span className="text-amber pt-1" aria-hidden>
            ›
          </span>
          <textarea
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.shiftKey) {
                e.preventDefault();
                e.currentTarget.form?.requestSubmit();
              }
            }}
            rows={2}
            placeholder={
              status === "awaiting_approval" ? "Approve the plan above, or say what to change" : "Ask for a change, a new test, or a different idea"
            }
            aria-label="Message the agent"
            className="flex-1 resize-none bg-transparent outline-none text-ink placeholder:text-faint font-sans text-[0.9375rem] leading-6"
            style={{ fontStretch: "100%" }}
          />
          <button type="submit" className="btn" disabled={running || !draft.trim()}>
            Send
          </button>
        </div>
      </form>
    </div>
  );
}

export function BlockView({
  block,
  canApprove,
  onApprove,
  readOnly = false,
}: {
  block: Block;
  canApprove: boolean;
  onApprove: () => void;
  readOnly?: boolean;
}) {
  switch (block.kind) {
    case "user":
      return (
        <div className="flex gap-3 text-ink">
          <span className="text-amber" aria-hidden>
            ›
          </span>
          <span className="font-sans text-[0.9375rem] leading-6 whitespace-pre-wrap" style={{ fontStretch: "100%" }}>
            {block.text}
          </span>
        </div>
      );
    case "reasoning":
      return (
        <details className="text-xs text-dim pl-5">
          <summary className="cursor-pointer select-none hover:text-ink">
            thinking: {block.text.replace(/\*\*/g, "").split("\n")[0].slice(0, 90)}
          </summary>
          <div className="mt-2 opacity-80">
            <Markdown text={block.text} />
          </div>
        </details>
      );
    case "text":
      return (
        <div className="pl-5">
          <Markdown text={block.text} />
        </div>
      );
    case "tool":
      return (
        <div className="pl-5 space-y-2">
          <div className="text-xs flex items-center gap-2">
            <span className={block.pending ? "text-amber animate-pulse" : "text-faint"} aria-hidden>
              {block.pending ? "◆" : "◇"}
            </span>
            <span className="text-dim">{TOOL_LABELS[block.name] ?? block.name}</span>
            {block.pending && <span className="text-faint">running</span>}
          </div>
          <ToolCard name={block.name} card={block.card} canApprove={canApprove} onApprove={onApprove} readOnly={readOnly} />
        </div>
      );
    case "error":
      return <div className="pl-5 text-xs text-down">{block.text}</div>;
  }
}
