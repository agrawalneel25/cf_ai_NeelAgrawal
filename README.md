# cf_ai_chat

A persistent AI chat application built entirely on Cloudflare's edge network. No traditional backend server, no external database, no third-party AI provider. Llama 3.3 70B runs on Workers AI, conversation state lives in Workers KV, and everything deploys in a single command.

**Live:** https://cf-ai-chat.neelagrawal25.workers.dev

---

## What it does

- Chat with Llama 3.3 70B, responses stream token-by-token to the browser
- Conversations persist across page refreshes and browser restarts
- Multiple conversation threads, each auto-titled by the model after the first exchange
- Voice input via the Web Speech API
- Responses render as markdown — code blocks, headers, bold, lists
- Old context is summarized rather than dropped when conversations get long

---

## Architecture

```
Browser
  |
  | POST /chat { message, sessionId, userId }
  v
Cloudflare Worker
  |
  +-- KV.get("session:{id}")         Load message history + rolling summary
  |
  +-- [if history > 16 messages]
  |     Workers AI (non-streaming)   Compress oldest 8 messages into summary
  |     KV.put("session:{id}")       Store updated summary
  |
  +-- Workers AI (stream: true)      Llama 3.3 70B inference
  |
  +-- TransformStream                Forward SSE bytes to client
  |   flush() callback:
  |     Workers AI (non-streaming)   Generate 4-6 word title (first exchange only)
  |     KV.put("session:{id}")       Save completed message + title
  |     KV.put("index:{userId}")     Update conversation index
  |
  v
Browser renders token-by-token, transitions to markdown on stream end
```

---

## Stack

| Component | Cloudflare product |
|---|---|
| LLM inference | Workers AI — `@cf/meta/llama-3.3-70b-instruct-fp8-fast` |
| Session memory | Workers KV — message history, rolling summary, title |
| Conversation index | Workers KV — per-user sorted list of conversations |
| Serving UI + API | Cloudflare Worker (single deployment) |

---

## Setup

**Requirements:** Node.js 18+, Cloudflare account (free tier)

```bash
# 1. Install dependencies
npm install

# 2. Authenticate
npx wrangler login

# 3. Create KV namespace
npx wrangler kv:namespace create MEMORY
# Copy the returned id into wrangler.toml (both id and preview_id fields)

# 4. Deploy
npm run deploy
```

**Local dev**

```bash
npm run dev
# Runs at http://localhost:8787
# Workers AI calls hit the real network — wrangler login required
```

---

## Key decisions

**KV over Durable Objects.** Chat sessions are single-user and don't have concurrent writers. KV is the right fit — free tier, simpler consistency model, no coordination overhead. Durable Objects would be the right call if sessions needed real-time sync across devices or concurrent access (multiplayer, shared threads).

**Rolling summarization over truncation.** Dropping old messages is simple but loses context that matters in long conversations — earlier decisions, names, things the user mentioned once. When history exceeds 16 messages, the oldest 8 get compressed into a stored summary via a second AI call. The summary is injected into the system prompt on future turns. The cost is one extra inference call when summarization triggers; the benefit is that the model stays coherent over long sessions.

**Streaming via TransformStream.** Workers AI returns a `ReadableStream` of SSE events when `stream: true` is set. Piping through a `TransformStream` lets us intercept each chunk to accumulate full response text while forwarding raw bytes to the client immediately. The KV write happens in the async `flush()` callback after the stream ends — users see tokens as they generate, not after the full response is ready.

**Single Worker for API and UI.** The HTML is inlined in the Worker so there is one deployment artifact and one command. Pages would give static asset caching at the CDN edge, which matters at scale, but for a project this size the deployment simplicity is worth more.

**Background title generation.** The model generates a short conversation title after the first exchange, inside the `flush()` callback. It runs after the main response stream ends so it never blocks what the user is waiting for. The client polls for the updated title 1.5 seconds later.

---

## What I'd do next

**Vectorize for semantic memory.** The current rolling summary is a blunt instrument — it compresses everything into 3-4 sentences and loses specifics. A better approach is to embed key facts from each turn using `@cf/baai/bge-base-en-v1.5` and store them in Vectorize. On each new message, retrieve the most semantically relevant past context rather than always injecting the full summary. Cloudflare's Agent Memory (announced Agents Week 2026) is essentially this pattern as a managed service.

**AI Gateway for observability.** Routing Workers AI calls through AI Gateway would give per-request logging, cache hits on repeated prompts, and rate limiting — with no changes to the Worker code beyond the binding. Once you want to understand inference costs and latency distribution, that's the obvious next step.

**Realtime for voice output.** Voice input works via the browser's Web Speech API, but voice output (streaming TTS) needs a lower-latency path than the current HTTP streaming model. Workers Realtime (WebSocket-based) would be the right primitive for a full voice conversation loop.

**Durable Objects for shared sessions.** If two people needed to be in the same conversation simultaneously — customer support, pair programming — KV's eventual consistency model breaks down. A Durable Object per session would give the coordination primitives needed: a single authoritative state, WebSocket connections from multiple clients, guaranteed ordering.
