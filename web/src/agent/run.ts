// The agent loop: stream a response, run any tool calls, feed the results back, repeat until
// the model answers without calling a tool or a tool (propose_plan) hands the turn to the user.

import OpenAI from "openai";
import { toResponseInputItems } from "openai/lib/responses/ResponseInputItems";
import type { ParsedResponseFunctionToolCall, ResponseInputItem } from "openai/resources/responses/responses";
import { and, eq, ne } from "drizzle-orm";
import { conversations, db, toolRuns } from "@/db";
import { instructions } from "./prompt";
import { runTool, toolDefinitions } from "./tools";

export type AgentEvent =
  | { type: "text"; itemId: string; delta: string }
  | { type: "reasoning"; itemId: string; delta: string }
  | { type: "tool_start"; callId: string; name: string }
  | { type: "tool_result"; callId: string; name: string; card: unknown }
  | { type: "status"; status: ConversationStatus }
  | { type: "error"; message: string };

export type ConversationStatus = "idle" | "running" | "awaiting_approval";

const MODEL = process.env.KESTREL_AGENT_MODEL ?? "gpt-6-sol";
const MAX_STEPS = 40;

let client: OpenAI | null = null;
const openai = () => (client ??= new OpenAI());

export class BusyError extends Error {}

/** Adds the user's message and runs the agent until it's the user's turn again. */
export async function runAgent(conversationId: string, userText: string, emit: (e: AgentEvent) => void) {
  // Claim the conversation atomically, so two tabs can't run it at once.
  const [claimed] = await db
    .update(conversations)
    .set({ status: "running" })
    .where(and(eq(conversations.id, conversationId), ne(conversations.status, "running")))
    .returning({ items: conversations.items });
  if (!claimed) throw new BusyError("this conversation is already running, or doesn't exist");

  const items: ResponseInputItem[] = [...claimed.items, { role: "user", content: userText }];
  await save(conversationId, items);
  emit({ type: "status", status: "running" });

  let status: ConversationStatus = "idle";
  try {
    for (let step = 0; step < MAX_STEPS; step++) {
      const stream = openai().responses.stream({
        model: MODEL,
        instructions: instructions(new Date().toISOString().slice(0, 10)),
        input: items,
        tools: toolDefinitions,
        parallel_tool_calls: true,
        reasoning: { effort: "medium", summary: "auto" },
      });
      for await (const event of stream) {
        switch (event.type) {
          case "response.output_text.delta":
            emit({ type: "text", itemId: event.item_id, delta: event.delta });
            break;
          case "response.reasoning_summary_text.delta":
            emit({ type: "reasoning", itemId: event.item_id, delta: event.delta });
            break;
          case "response.output_item.added":
            if (event.item.type === "function_call") {
              emit({ type: "tool_start", callId: event.item.call_id, name: event.item.name });
            }
            break;
        }
      }
      const response = await stream.finalResponse();
      if (response.status === "incomplete") {
        throw new Error(`the model stopped early (${response.incomplete_details?.reason ?? "unknown reason"})`);
      }

      const calls = response.output.filter((o): o is ParsedResponseFunctionToolCall => o.type === "function_call");
      // Model output and the matching tool outputs are saved together: a function call without
      // its output would make the next request fail.
      const outputs = await Promise.all(
        calls.map(async (call) => {
          const result = await runTool(call.name, call.arguments, { conversationId }).catch((e: unknown) => ({
            output: { error: `the tool failed: ${e instanceof Error ? e.message : String(e)}` },
            card: { error: "the tool failed" },
            stop: false,
          }));
          await db
            .insert(toolRuns)
            .values({ callId: call.call_id, conversationId, name: call.name, data: result.card })
            .onConflictDoUpdate({ target: toolRuns.callId, set: { data: result.card } });
          emit({ type: "tool_result", callId: call.call_id, name: call.name, card: result.card });
          return { call, result };
        }),
      );

      items.push(...toResponseInputItems(response.output));
      for (const { call, result } of outputs) {
        items.push({ type: "function_call_output", call_id: call.call_id, output: JSON.stringify(result.output) });
      }
      await save(conversationId, items);

      if (calls.length === 0) break;
      if (outputs.some((o) => o.result.stop)) {
        status = "awaiting_approval";
        break;
      }
      if (step === MAX_STEPS - 1) emit({ type: "error", message: `stopped after ${MAX_STEPS} steps` });
    }
  } catch (e) {
    emit({ type: "error", message: describeError(e) });
  } finally {
    await db.update(conversations).set({ status }).where(eq(conversations.id, conversationId));
    emit({ type: "status", status });
  }
}

async function save(conversationId: string, items: ResponseInputItem[]) {
  await db
    .update(conversations)
    .set({ items })
    .where(eq(conversations.id, conversationId));
}

function describeError(e: unknown): string {
  if (e instanceof OpenAI.RateLimitError) return "OpenAI rate limit hit; try again in a moment";
  if (e instanceof OpenAI.AuthenticationError) return "OpenAI rejected the API key; check OPENAI_API_KEY in .env";
  if (e instanceof OpenAI.APIError) return `OpenAI error ${e.status ?? ""}: ${e.message}`;
  return e instanceof Error ? e.message : String(e);
}
