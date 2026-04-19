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

    if (request.method === "GET" && url.pathname === "/") {
      return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    }

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

    if (request.method === "DELETE" && url.pathname === "/session") {
      const { sessionId } = await request.json() as { sessionId: string };
      if (sessionId) await env.MEMORY.delete(sessionId);
      return Response.json({ ok: true });
    }

    return new Response("not found", { status: 404 });
  },
};

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>cf_ai_chat</title>
<style>
*{box-sizing:border-box;margin:0;padding:0}
body{font-family:system-ui,sans-serif;background:#0d0d0d;color:#e0e0e0;height:100dvh;display:flex;flex-direction:column}
header{padding:14px 20px;border-bottom:1px solid #1e1e1e;display:flex;justify-content:space-between;font-size:13px;color:#555}
button.clear{background:none;border:1px solid #2a2a2a;color:#555;padding:4px 10px;border-radius:6px;cursor:pointer;font-size:12px}
#messages{flex:1;overflow-y:auto;padding:24px 20px;display:flex;flex-direction:column;gap:14px}
.msg{max-width:72%;padding:11px 15px;border-radius:12px;font-size:14px;line-height:1.6;white-space:pre-wrap}
.user{background:#1a3557;align-self:flex-end}
.ai{background:#1a1a1a;border:1px solid #252525;align-self:flex-start}
#bottom{padding:16px 20px;border-top:1px solid #1e1e1e;display:flex;gap:8px}
#input{flex:1;background:#161616;border:1px solid #2a2a2a;color:#e0e0e0;padding:10px 14px;border-radius:8px;font-size:14px;outline:none}
#input:focus{border-color:#404040}
#send{background:#2563eb;color:#fff;border:none;padding:10px 18px;border-radius:8px;cursor:pointer;font-size:14px}
#send:disabled{opacity:0.4;cursor:not-allowed}
</style>
</head>
<body>
<header><span>cf_ai_chat</span><button class="clear" id="clear">New chat</button></header>
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

function addMsg(role, text) {
  var d = document.createElement('div');
  d.className = 'msg ' + role;
  d.textContent = text;
  msgs.appendChild(d);
  msgs.scrollTop = msgs.scrollHeight;
  return d;
}

async function send() {
  var text = inp.value.trim();
  if (!text || btn.disabled) return;
  inp.value = '';
  btn.disabled = true;
  addMsg('user', text);
  var placeholder = addMsg('ai', '...');
  try {
    var res = await fetch('/chat', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: text, sessionId: sid })
    });
    var data = await res.json();
    placeholder.textContent = data.reply;
  } catch(e) {
    placeholder.textContent = 'Error reaching server.';
  }
  btn.disabled = false;
  inp.focus();
}

btn.addEventListener('click', send);
inp.addEventListener('keydown', function(e) { if (e.key === 'Enter') send(); });
document.getElementById('clear').addEventListener('click', async function() {
  await fetch('/session', { method: 'DELETE', headers: {'Content-Type':'application/json'}, body: JSON.stringify({ sessionId: sid }) });
  sid = crypto.randomUUID();
  localStorage.setItem('cf_sid', sid);
  msgs.innerHTML = '';
});
</script>
</body>
</html>`;
