# PROMPTS.md

AI prompts used during development (Claude via Claude Code CLI).

---

## 1. Initial planning

> i have a cloudflare internship application that asks me to build an AI-powered app. here are the requirements:
>
> - LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice
> - Workflow / coordination (recommend using Workflows, Workers or Durable Objects)
> - User input via chat or voice (recommend using Pages or Realtime)
> - Memory or state
>
> repo name must be prefixed with cf_ai_, must include a README.md and a PROMPTS.md with the AI prompts used.
>
> i have a free cloudflare account. what should i build and what stack should i use? walk me through the tradeoffs - durable objects vs KV for state, pages vs worker for the frontend, what kind of app would actually be interesting vs just a boring demo

Used to decide the overall approach: single Worker serving both API and UI, Workers KV for state (free tier, single-user sessions don't need Durable Objects' consistency model), Llama 3.3 70B for inference. Decided to build a persistent multi-conversation chat app rather than a single-session demo.

---

## 2. Context window management

> my chat worker stores full conversation history in KV and passes it to llama 3.3 on every request. what happens when conversations get long? im thinking either (a) truncate oldest messages, (b) summarise them with a second ai call and store the summary, or (c) sliding window. whats the quality/latency tradeoff

Used to decide: rolling summarization — triggers at 16 messages, compresses oldest 8 into a stored summary, keeps 8 recent messages. adds one extra inference call but preserves semantic context much better than truncation.

---

## 3. streaming with KV write-back

> i want workers AI to stream tokens to the browser over SSE but also need to save the full response to KV once the stream finishes. thinking i can use a TransformStream - intercept each chunk to build up the full text, forward raw bytes to the client, then write to KV in the flush callback. does this work in the workers execution model or will the worker die before flush() completes

Used to implement: `TransformStream` with an async `flush()` callback. KV writes are awaited inside flush, which runs after the AI stream ends. Worker stays alive until flush resolves.

---

## 4. SSE parsing on the client

> reading a streaming fetch response from workers AI. chunks arent aligned to SSE message boundaries so a single read() can return a partial line or multiple lines. whats the correct buffering pattern so i dont drop tokens or crash on partial json

Used to implement: string buffer accumulation — append decoded chunks, split on `\n`, keep the last incomplete line in the buffer, parse only complete `data:` lines.

---

## 5. summarisation prompt wording

> im summarising old messages with a second llama call before they fall out of context. the summary gets injected into the system prompt. what prompt gets me something that actually preserves useful stuff like names and decisions rather than vague topic summaries

Used to write: `"Summarize this conversation in 3-4 sentences. Preserve names, facts, and decisions."` — short and concrete, stops the model from being too abstract.

---

## 6. multi-conversation data model in KV

> want to support multiple named conversations per user. no auth, users are a UUID in localStorage. need to list convos, load a specific one, update title + timestamp, delete. whats a clean KV key structure for this

Used to decide: `session:{conversationId}` for full session data, `index:{userId}` for a sorted array of conversation metadata. max 30 per user sorted by recency.

---

## 7. auto-generating conversation titles

> after the first exchange i want to generate a short title using llama and show it in the sidebar without blocking the streaming response. where do i run this

Used to decide: inside the async `flush()` callback after the main stream ends. client polls for the updated title 1.5s later via a sidebar refresh call.

---

## 8. markdown rendering without external libraries

> need to render markdown in AI responses - fenced code blocks, inline code, bold, italic, headers, lists. cant use any npm packages since the whole thing is inlined in a worker template literal. write a vanilla js renderer, make sure html is escaped inside code blocks

Used to implement: two-pass regex renderer — extract fenced code blocks first to avoid processing their contents, then handle inline formatting. raw text shown during streaming, rendered markdown replaces it when stream completes.

---

## 9. voice input

> want a mic button using the web speech api. should toggle on/off, show a pulsing red state when recording, auto-send when speech ends. handle unsupported browsers without breaking anything

Used to implement: `SpeechRecognition` with `continuous: false`. three button states: default, listening (CSS pulse animation), unsupported (dimmed). transcript auto-sends on `onresult`.

---

## 10. streaming cursor + markdown transition

> during streaming i want a blinking cursor after the last token. when stream ends it should disappear and the raw text should switch to rendered markdown. cursor in css only, no js timers. transition shouldnt look janky

Used to implement: `.streaming::after` pseudo-element with `▮` character and `@keyframes blink`. class removed and `innerHTML` set to rendered markdown in the same block after `done: true`.

---

## 11. README

> write a readme for this project. describe what it does, the top level architecture, the tech stack. produce clear setup instructions so someone can run it locally or deploy it themselves. write about some of the decisions we made when building this - the tradeoffs we considered, why we picked certain approaches over others. for the "what to do next" section talk about: adding semantic memory (storing and retrieving facts from conversations as vectors rather than a rolling summary), hooking it up to AI gateway for observability and caching, adding chatgpt-style voice output so the whole thing works as a voice conversation, and shared sessions where multiple people can be in the same conversation (and what that would require architecturally)

Used to write the README in this repo.

---

## 12. PROMPTS.md

> write a PROMPTS.md file documenting the AI prompts i used to build this project. should cover everything from initial architecture decisions through to implementation details and documentation. make it look natural - like someone who knows what theyre doing used AI to help with specific pieces, not like they just asked for the whole thing in one go

Used to write this file.
