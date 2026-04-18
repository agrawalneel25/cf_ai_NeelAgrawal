interface Env {
  AI: { run(model: string, opts: object): Promise<{ response: string }> };
  MEMORY: KVNamespace;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "POST" && url.pathname === "/chat") {
      const { message, sessionId } = await request.json() as { message: string; sessionId: string };

      const stored = await env.MEMORY.get(sessionId);
      const history: Message[] = stored ? JSON.parse(stored) : [];
      history.push({ role: "user", content: message });

      const result = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
        messages: [{ role: "system", content: "You are a helpful assistant." }, ...history],
      }) as { response: string };

      history.push({ role: "assistant", content: result.response });
      await env.MEMORY.put(sessionId, JSON.stringify(history), { expirationTtl: 3600 });
      return Response.json({ reply: result.response });
    }

    return new Response("not found", { status: 404 });
  },
};
