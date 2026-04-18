export default {
  async fetch(request: Request): Promise<Response> {
    return new Response("cf_ai_chat", { headers: { "Content-Type": "text/plain" } });
  },
};
