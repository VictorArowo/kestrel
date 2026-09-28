// What the chat shows, built from the stored Responses API items plus the tool cards.

import type { ResponseInputItem } from "openai/resources/responses/responses";

export type Block =
  | { kind: "user"; id: string; text: string }
  | { kind: "reasoning"; id: string; text: string }
  | { kind: "text"; id: string; text: string }
  | { kind: "tool"; id: string; name: string; card: unknown; pending: boolean }
  | { kind: "error"; id: string; text: string };

type Item = ResponseInputItem & Record<string, unknown>;

export function toBlocks(items: ResponseInputItem[], cards: Record<string, unknown>): Block[] {
  const blocks: Block[] = [];
  items.forEach((raw, i) => {
    const item = raw as Item;
    if ("role" in item && item.role === "user" && item.type !== "message") {
      blocks.push({ kind: "user", id: `u${i}`, text: typeof item.content === "string" ? item.content : "" });
    } else if (item.type === "reasoning") {
      const summary = (item.summary as { text: string }[] | undefined) ?? [];
      const text = summary.map((s) => s.text).join("\n\n");
      if (text) blocks.push({ kind: "reasoning", id: String(item.id ?? `r${i}`), text });
    } else if (item.type === "message" && item.role === "assistant") {
      const parts = (item.content as { type: string; text?: string }[]) ?? [];
      const text = parts.map((p) => p.text ?? "").join("");
      if (text) blocks.push({ kind: "text", id: String(item.id ?? `m${i}`), text });
    } else if (item.type === "message" && item.role === "user") {
      const parts = (item.content as { type: string; text?: string }[]) ?? [];
      blocks.push({ kind: "user", id: `u${i}`, text: parts.map((p) => p.text ?? "").join("") });
    } else if (item.type === "function_call") {
      const callId = String(item.call_id);
      blocks.push({ kind: "tool", id: callId, name: String(item.name), card: cards[callId] ?? null, pending: !(callId in cards) });
    }
  });
  return blocks;
}
