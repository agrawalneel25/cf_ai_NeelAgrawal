interface Env {
  AI: { run(model: string, opts: object): Promise<{ response: string } | ReadableStream> };
  MEMORY: KVNamespace;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

    if (request.method === "POST" && url.pathname === "/chat") {
      return handleChat(request, env);
    }

    if (request.method === "DELETE" && url.pathname === "/session") {
      const { sessionId } = await request.json() as { sessionId: string };
      if (sessionId) await env.MEMORY.delete(sessionId);
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  const { message, sessionId } = await request.json() as { message: string; sessionId: string };

  const stored = await env.MEMORY.get(sessionId);
  let history: Message[] = stored ? JSON.parse(stored) : [];
  history.push({ role: "user", content: message });

  if (history.length > 20) history = history.slice(history.length - 20);

  const aiStream = await env.AI.run("@cf/meta/llama-3.3-70b-instruct-fp8-fast", {
    messages: [{ role: "system", content: "You are a helpful assistant." }, ...history],
    stream: true,
  }) as ReadableStream;

  let fullText = "";
  const historyRef = history;

  const { readable, writable } = new TransformStream({
    transform(chunk: Uint8Array, controller) {
      const lines = new TextDecoder().decode(chunk).split("\n");
      for (const line of lines) {
        if (line.startsWith("data: ") && !line.includes("[DONE]")) {
          try {
            const data = JSON.parse(line.slice(6));
            if (data.response) fullText += data.response;
          } catch {}
        }
      }
      controller.enqueue(chunk);
    },
    async flush() {
      historyRef.push({ role: "assistant", content: fullText });
      await env.MEMORY.put(sessionId, JSON.stringify(historyRef), { expirationTtl: 7200 });
    },
  });

  aiStream.pipeTo(writable);
  return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>cf_ai_chat</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#e0e0e0;height:100dvh;display:flex;flex-direction:column}
header{padding:14px 20px;border-bottom:1px solid #1e1e1e;font-size:13px;color:#555}
#messages{flex:1;overflow-y:auto;padding:24px 20px;display:flex;flex-direction:column;gap:14px}
.msg{max-width:72%;padding:11px 15px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap}
.user{background:#1a3557;align-self:flex-end}
.ai{background:#1a1a1a;border:1px solid #252525;align-self:flex-start}
.ai.streaming::after{content:'\\25ae';animation:blink 0.8s step-end infinite;margin-left:3px;color:#555}
@keyframes blink{50%{opacity:0}}
#bottom{padding:16px 20px;border-top:1px solid #1e1e1e;display:flex;gap:8px}
#input{flex:1;background:#161616;border:1px solid #2a2a2a;color:#e0e0e0;padding:10px 14px;border-radius:8px;font-size:14px;outline:none}
#send{background:#2563eb;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:14px}
#send:disabled{opacity:0.4;cursor:not-allowed}
</style>
</head>
<body>
<header>cf_ai_chat &mdash; Llama 3.3 70B (streaming)</header>
<div id="messages"></div>
<div id="bottom">
  <input id="input" placeholder="Message..." />
  <button id="send">Send</button>
</div>
<script>
var sid = localStorage.getItem('cf_sid') || crypto.randomUUID();
localStorage.setItem('cf_sid', sid);
var msgs = document.getElementById('messages');
var inp = document.getElementById('input');
var btn = document.getElementById('send');

function addMsg(role, streaming) {
  var d = document.createElement('div');
  d.className = 'msg ' + role + (streaming ? ' streaming' : '');
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}

async function send() {
  var text = inp.value.trim();
  if (!text || btn.disabled) return;
  inp.value = '';
  btn.disabled = true;
  addMsg('user', false).textContent = text;
  var aiEl = addMsg('ai', true);

  try {
    var res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId: sid })
    });
    var reader = res.body.getReader();
    var decoder = new TextDecoder();
    var buffer = '';
    var fullText = '';
    while (true) {
      var chunk = await reader.read();
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      var lines = buffer.split('\\n');
      buffer = lines.pop() || '';
      for (var i = 0; i < lines.length; i++) {
        var line = lines[i];
        if (line.startsWith('data: ') && line.indexOf('[DONE]') === -1) {
          try {
            var data = JSON.parse(line.slice(6));
            if (data.response) { fullText += data.response; aiEl.textContent = fullText; msgs.scrollTop = msgs.scrollHeight; }
          } catch(e) {}
        }
      }
    }
    aiEl.classList.remove('streaming');
  } catch(e) {
    aiEl.classList.remove('streaming');
    aiEl.textContent = 'Error reaching server.';
  }
  btn.disabled = false;
  inp.focus();
}

btn.addEventListener('click', send);
inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') send(); });
</script>
</body>
</html>`;
