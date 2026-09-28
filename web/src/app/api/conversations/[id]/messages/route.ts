import { BusyError, runAgent, type AgentEvent } from "@/agent/run";

/** Sends a message and streams the agent's work back as server-sent events. */
export async function POST(request: Request, ctx: RouteContext<"/api/conversations/[id]/messages">) {
  const { id } = await ctx.params;
  const { text } = (await request.json()) as { text?: string };
  if (!text?.trim()) return Response.json({ error: "empty message" }, { status: 400 });

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      let open = true;
      // Keep running if the browser goes away: progress is saved as it happens.
      const emit = (e: AgentEvent) => {
        if (!open) return;
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(e)}\n\n`));
        } catch {
          open = false;
        }
      };
      try {
        await runAgent(id, text.trim(), emit);
      } catch (e) {
        emit({ type: "error", message: e instanceof BusyError ? e.message : "something went wrong" });
        if (!(e instanceof BusyError)) console.error(e);
      } finally {
        if (open) controller.close();
      }
    },
  });
  return new Response(stream, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-cache, no-transform" },
  });
}
