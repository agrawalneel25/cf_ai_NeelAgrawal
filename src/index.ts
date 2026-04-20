interface Env {
  AI: {
    run(model: string, options: object): Promise<{ response: string } | ReadableStream>;
  };
  MEMORY: KVNamespace;
}

interface Message {
  role: "user" | "assistant";
  content: string;
}

interface SessionData {
  messages: Message[];
  summary: string | null;
  title: string | null;
  createdAt: number;
  updatedAt: number;
}

interface ConvMeta {
  id: string;
  title: string;
  updatedAt: number;
}

const MODEL = "@cf/meta/llama-3.3-70b-instruct-fp8-fast";
const SUMMARIZE_AFTER = 16;
const KEEP_RECENT = 8;
const MAX_CONVERSATIONS = 30;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { "Access-Control-Allow-Origin": "*", "Access-Control-Allow-Methods": "GET,POST,DELETE,OPTIONS", "Access-Control-Allow-Headers": "Content-Type" } });
    }

    if (request.method === "GET" && url.pathname === "/") return new Response(HTML, { headers: { "Content-Type": "text/html; charset=utf-8" } });
    if (request.method === "POST" && url.pathname === "/chat") return handleChat(request, env);
    if (request.method === "GET" && url.pathname === "/conversations") return getConversations(request, env);
    if (request.method === "GET" && url.pathname === "/conversation") return getConversation(request, env);
    if (request.method === "POST" && url.pathname === "/conversations") return createConversation(request, env);
    if (request.method === "DELETE" && url.pathname === "/conversation") return deleteConversation(request, env);

    return new Response("Not found", { status: 404 });
  },
};

async function handleChat(request: Request, env: Env): Promise<Response> {
  let body: { message: string; sessionId: string; userId: string };
  try { body = await request.json(); }
  catch { return Response.json({ error: "Invalid JSON" }, { status: 400 }); }

  const { message, sessionId, userId } = body;
  if (!message || !sessionId || !userId) return Response.json({ error: "Missing fields" }, { status: 400 });

  const stored = await env.MEMORY.get("session:" + sessionId);
  let session: SessionData = stored
    ? JSON.parse(stored)
    : { messages: [], summary: null, title: null, createdAt: Date.now(), updatedAt: Date.now() };

  session.messages.push({ role: "user", content: message });
  session.updatedAt = Date.now();

  // Rolling summarization: compress oldest messages into a summary string
  // so the model context stays within limits without losing conversational history
  if (session.messages.length > SUMMARIZE_AFTER) {
    const toSummarize = session.messages.slice(0, session.messages.length - KEEP_RECENT);
    const recent = session.messages.slice(session.messages.length - KEEP_RECENT);
    const prior = session.summary ? "Prior summary: " + session.summary + "\n\n" : "";
    const text = toSummarize.map(m => m.role + ": " + m.content).join("\n");

    const result = await env.AI.run(MODEL, {
      messages: [
        { role: "system", content: "Summarize this conversation in 3-4 sentences. Preserve names, facts, and decisions." },
        { role: "user", content: prior + text },
      ],
    }) as { response: string };

    session.summary = result.response;
    session.messages = recent;
  }

  const systemContent = session.summary
    ? "You are a helpful assistant. Context from earlier in this conversation:\n" + session.summary
    : "You are a helpful assistant. You remember everything in this conversation.";

  const isFirstExchange = session.messages.length === 1;

  const aiStream = await env.AI.run(MODEL, {
    messages: [{ role: "system", content: systemContent }, ...session.messages],
    stream: true,
  }) as ReadableStream;

  // Pipe the AI stream through a TransformStream that:
  // 1. Forwards raw SSE bytes to the client for token-by-token display
  // 2. Accumulates the full text in memory
  // 3. In flush(): saves the completed message to KV and optionally generates a title
  let fullText = "";
  const sessionRef = session;

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
      sessionRef.messages.push({ role: "assistant", content: fullText });

      // Auto-title the conversation after the first exchange
      if (isFirstExchange && !sessionRef.title) {
        try {
          const titleResult = await env.AI.run(MODEL, {
            messages: [
              { role: "system", content: "Generate a 4-6 word title for this conversation. Only the title — no quotes, no punctuation." },
              { role: "user", content: "User: " + message + "\nAssistant: " + fullText.slice(0, 300) },
            ],
          }) as { response: string };
          sessionRef.title = titleResult.response.trim().slice(0, 60);
        } catch {}
      }

      await env.MEMORY.put("session:" + sessionId, JSON.stringify(sessionRef), { expirationTtl: 86400 });

      // Update the per-user conversation index
      try {
        const idxRaw = await env.MEMORY.get("index:" + userId);
        let index: ConvMeta[] = idxRaw ? JSON.parse(idxRaw) : [];
        const pos = index.findIndex(c => c.id === sessionId);
        const meta: ConvMeta = { id: sessionId, title: sessionRef.title || "New conversation", updatedAt: sessionRef.updatedAt };
        if (pos >= 0) index[pos] = meta; else index.unshift(meta);
        index.sort((a, b) => b.updatedAt - a.updatedAt);
        if (index.length > MAX_CONVERSATIONS) index = index.slice(0, MAX_CONVERSATIONS);
        await env.MEMORY.put("index:" + userId, JSON.stringify(index), { expirationTtl: 86400 });
      } catch {}
    },
  });

  aiStream.pipeTo(writable);
  return new Response(readable, { headers: { "Content-Type": "text/event-stream", "Cache-Control": "no-cache" } });
}

async function getConversations(request: Request, env: Env): Promise<Response> {
  const userId = new URL(request.url).searchParams.get("userId");
  if (!userId) return Response.json([]);
  const raw = await env.MEMORY.get("index:" + userId);
  return Response.json(raw ? JSON.parse(raw) : []);
}

async function getConversation(request: Request, env: Env): Promise<Response> {
  const id = new URL(request.url).searchParams.get("id");
  if (!id) return Response.json({ error: "Missing id" }, { status: 400 });
  const raw = await env.MEMORY.get("session:" + id);
  return Response.json(raw ? JSON.parse(raw) : { messages: [], summary: null, title: null });
}

async function createConversation(request: Request, env: Env): Promise<Response> {
  const { userId, sessionId } = await request.json() as { userId: string; sessionId: string };
  if (!userId || !sessionId) return Response.json({ error: "Missing fields" }, { status: 400 });

  const session: SessionData = { messages: [], summary: null, title: null, createdAt: Date.now(), updatedAt: Date.now() };
  await env.MEMORY.put("session:" + sessionId, JSON.stringify(session), { expirationTtl: 86400 });

  const idxRaw = await env.MEMORY.get("index:" + userId);
  let index: ConvMeta[] = idxRaw ? JSON.parse(idxRaw) : [];
  index.unshift({ id: sessionId, title: "New conversation", updatedAt: Date.now() });
  if (index.length > MAX_CONVERSATIONS) index = index.slice(0, MAX_CONVERSATIONS);
  await env.MEMORY.put("index:" + userId, JSON.stringify(index), { expirationTtl: 86400 });

  return Response.json({ ok: true });
}

async function deleteConversation(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  const userId = url.searchParams.get("userId");
  if (!id || !userId) return Response.json({ error: "Missing fields" }, { status: 400 });

  await env.MEMORY.delete("session:" + id);

  const idxRaw = await env.MEMORY.get("index:" + userId);
  if (idxRaw) {
    let index: ConvMeta[] = JSON.parse(idxRaw);
    index = index.filter(c => c.id !== id);
    await env.MEMORY.put("index:" + userId, JSON.stringify(index), { expirationTtl: 86400 });
  }

  return Response.json({ ok: true });
}

const HTML = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8"/>
<meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>cf_ai_chat</title>
<style>
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{--bg:#0d0d0d;--sb:#111111;--border:#1e1e1e;--text:#e0e0e0;--dim:#555;--user:#1a3557;--ai:#181818;--accent:#2563eb;--danger:#991b1b}
body{font-family:system-ui,-apple-system,sans-serif;background:var(--bg);color:var(--text);height:100dvh;display:flex;overflow:hidden;font-size:14px}
#sidebar{width:240px;min-width:240px;background:var(--sb);border-right:1px solid var(--border);display:flex;flex-direction:column;transition:transform 0.2s}
#sb-top{padding:14px 12px 10px;display:flex;align-items:center;justify-content:space-between;border-bottom:1px solid var(--border)}
#sb-top span{font-size:12px;color:var(--dim);font-weight:600;letter-spacing:0.05em;text-transform:uppercase}
#new-btn{background:var(--accent);color:#fff;border:none;border-radius:6px;padding:5px 10px;cursor:pointer;font-size:12px}
#new-btn:hover{background:#1d4ed8}
#conv-list{flex:1;overflow-y:auto;padding:6px}
.conv-item{display:flex;align-items:center;padding:9px 10px;border-radius:7px;cursor:pointer;gap:8px;transition:background 0.1s;position:relative}
.conv-item:hover{background:#1a1a1a}
.conv-item.active{background:#1e2e45}
.conv-title{flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;font-size:13px;color:var(--text)}
.conv-del{opacity:0;background:none;border:none;color:var(--dim);cursor:pointer;font-size:14px;padding:2px 4px;border-radius:4px;flex-shrink:0}
.conv-item:hover .conv-del{opacity:1}
.conv-del:hover{color:#f87171}
#main{flex:1;display:flex;flex-direction:column;overflow:hidden}
#top-bar{padding:12px 20px;border-bottom:1px solid var(--border);display:flex;align-items:center;gap:10px}
#menu-btn{display:none;background:none;border:none;color:var(--dim);cursor:pointer;font-size:18px;padding:2px 6px}
#conv-name{font-size:14px;color:#aaa;flex:1;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
#model-tag{font-size:11px;color:var(--dim);background:#1a1a1a;border:1px solid var(--border);padding:3px 8px;border-radius:12px}
#messages{flex:1;overflow-y:auto;padding:24px 20px;display:flex;flex-direction:column;gap:16px}
.msg{max-width:74%;padding:12px 15px;border-radius:13px;line-height:1.65;word-break:break-word}
.msg.user{background:var(--user);align-self:flex-end;border-radius:13px 13px 3px 13px;white-space:pre-wrap}
.msg.ai{background:var(--ai);align-self:flex-start;border:1px solid #252525;border-radius:13px 13px 13px 3px}
.msg.ai p{margin-bottom:10px}
.msg.ai p:last-child{margin-bottom:0}
.msg.ai h2,.msg.ai h3,.msg.ai h4{margin:12px 0 6px;font-size:15px}
.msg.ai ul,.msg.ai ol{padding-left:18px;margin-bottom:10px}
.msg.ai li{margin-bottom:4px}
.msg.ai pre{background:#0f0f0f;border:1px solid #2a2a2a;border-radius:8px;padding:12px;overflow-x:auto;margin:10px 0}
.msg.ai code{font-family:'Fira Code',Consolas,monospace;font-size:13px}
.msg.ai p code{background:#0f0f0f;padding:2px 5px;border-radius:4px;font-size:12px}
.msg.ai strong{font-weight:600}
.msg.ai em{font-style:italic;color:#c0c0c0}
.msg.ai.streaming::after{content:'\\25ae';display:inline-block;animation:blink 0.75s step-end infinite;margin-left:3px;color:var(--dim)}
@keyframes blink{50%{opacity:0}}
.msg-actions{margin-top:8px;display:flex;gap:6px}
.copy-btn{background:none;border:1px solid #2a2a2a;color:var(--dim);padding:3px 9px;border-radius:5px;cursor:pointer;font-size:11px}
.copy-btn:hover{color:var(--text);border-color:#444}
.empty{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:center;color:#2a2a2a;gap:10px;text-align:center}
.empty-title{font-size:20px;font-weight:600;color:#333}
.empty-sub{font-size:13px;color:#2a2a2a}
#bottom{padding:14px 20px;border-top:1px solid var(--border);display:flex;gap:8px;align-items:flex-end}
#voice-btn{background:none;border:1px solid var(--border);color:var(--dim);width:38px;height:38px;border-radius:8px;cursor:pointer;font-size:16px;flex-shrink:0;transition:all 0.15s}
#voice-btn:hover{border-color:#444;color:var(--text)}
#voice-btn.listening{border-color:#ef4444;color:#ef4444;animation:pulse 1s ease-in-out infinite}
#voice-btn.unsupported{opacity:0.3;cursor:not-allowed}
@keyframes pulse{0%,100%{box-shadow:0 0 0 0 rgba(239,68,68,0.4)}50%{box-shadow:0 0 0 6px rgba(239,68,68,0)}}
#input{flex:1;background:#161616;border:1px solid #2a2a2a;color:var(--text);padding:9px 13px;border-radius:8px;font-size:14px;outline:none;resize:none;font-family:inherit;line-height:1.5;max-height:160px}
#input:focus{border-color:#404040}
#send{background:var(--accent);color:#fff;border:none;padding:9px 18px;border-radius:8px;cursor:pointer;font-size:14px;flex-shrink:0}
#send:disabled{opacity:0.35;cursor:not-allowed}
#send:hover:not(:disabled){background:#1d4ed8}
@media(max-width:640px){
  #sidebar{position:fixed;top:0;left:0;height:100%;z-index:50;transform:translateX(-100%)}
  #sidebar.open{transform:translateX(0)}
  #menu-btn{display:block}
}
</style>
</head>
<body>
<aside id="sidebar">
  <div id="sb-top">
    <span>Conversations</span>
    <button id="new-btn">+ New</button>
  </div>
  <div id="conv-list" id="conv-list"></div>
</aside>
<main id="main">
  <div id="top-bar">
    <button id="menu-btn">&#9776;</button>
    <span id="conv-name">New conversation</span>
    <span id="model-tag">Llama 3.3 70B &middot; Workers AI</span>
  </div>
  <div id="messages">
    <div class="empty">
      <div class="empty-title">cf_ai_chat</div>
      <div class="empty-sub">Persistent memory &middot; Voice input &middot; Llama 3.3</div>
    </div>
  </div>
  <div id="bottom">
    <button id="voice-btn" title="Voice input">&#127908;</button>
    <textarea id="input" rows="1" placeholder="Message... (Enter to send, Shift+Enter for newline)"></textarea>
    <button id="send">Send</button>
  </div>
</main>

<script>
(function() {
  var userId = localStorage.getItem('cf_uid') || crypto.randomUUID();
  localStorage.setItem('cf_uid', userId);
  var currentId = localStorage.getItem('cf_conv') || null;

  var messagesEl = document.getElementById('messages');
  var inputEl = document.getElementById('input');
  var sendBtn = document.getElementById('send');
  var convList = document.getElementById('conv-list');
  var convName = document.getElementById('conv-name');
  var newBtn = document.getElementById('new-btn');
  var voiceBtn = document.getElementById('voice-btn');
  var menuBtn = document.getElementById('menu-btn');
  var sidebar = document.getElementById('sidebar');

  // --- Markdown renderer ---
  function escHtml(s) {
    return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }

  function renderMarkdown(text) {
    var parts = [];
    var codeBlockRe = /\`\`\`(\\w*)\\n([\\s\\S]*?)\`\`\`/g;
    var last = 0;
    var m;
    while ((m = codeBlockRe.exec(text)) !== null) {
      if (m.index > last) parts.push(renderInline(text.slice(last, m.index)));
      parts.push('<pre><code>' + escHtml(m[2].trimEnd()) + '</code></pre>');
      last = m.index + m[0].length;
    }
    if (last < text.length) parts.push(renderInline(text.slice(last)));
    return parts.join('');
  }

  function renderInline(text) {
    var blocks = text.split('\\n\\n');
    return blocks.map(function(block) {
      block = block.trim();
      if (!block) return '';
      if (block.startsWith('<pre')) return block;
      // headers
      block = block.replace(/^### (.+)$/gm, '<h4>$1</h4>');
      block = block.replace(/^## (.+)$/gm, '<h3>$1</h3>');
      block = block.replace(/^# (.+)$/gm, '<h2>$1</h2>');
      // lists
      var listLines = block.split('\\n');
      var inList = false;
      var out = [];
      for (var i = 0; i < listLines.length; i++) {
        var line = listLines[i];
        var listMatch = line.match(/^[-*] (.+)/);
        var numMatch = line.match(/^\\d+\\. (.+)/);
        if (listMatch || numMatch) {
          if (!inList) { out.push('<ul>'); inList = true; }
          out.push('<li>' + inlineFormat(listMatch ? listMatch[1] : numMatch[1]) + '</li>');
        } else {
          if (inList) { out.push('</ul>'); inList = false; }
          out.push(line);
        }
      }
      if (inList) out.push('</ul>');
      block = out.join('\\n');
      if (!block.match(/^<(h[2-4]|ul)/)) {
        block = '<p>' + inlineFormat(block).replace(/\\n/g, '<br>') + '</p>';
      }
      return block;
    }).join('');
  }

  function inlineFormat(text) {
    text = text.replace(/\`([^\`]+)\`/g, function(_, c) { return '<code>' + escHtml(c) + '</code>'; });
    text = text.replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>');
    text = text.replace(/\\*([^*]+)\\*/g, '<em>$1</em>');
    return text;
  }

  // --- Conversation list ---
  function renderConvList(convs) {
    convList.innerHTML = '';
    if (!convs.length) {
      convList.innerHTML = '<div style="padding:12px;color:#333;font-size:12px">No conversations yet</div>';
      return;
    }
    convs.forEach(function(c) {
      var item = document.createElement('div');
      item.className = 'conv-item' + (c.id === currentId ? ' active' : '');
      item.dataset.id = c.id;
      var title = document.createElement('span');
      title.className = 'conv-title';
      title.textContent = c.title || 'New conversation';
      var del = document.createElement('button');
      del.className = 'conv-del';
      del.textContent = '\\u2715';
      del.title = 'Delete';
      del.addEventListener('click', function(e) {
        e.stopPropagation();
        deleteConv(c.id);
      });
      item.appendChild(title);
      item.appendChild(del);
      item.addEventListener('click', function() { switchConv(c.id, c.title); });
      convList.appendChild(item);
    });
  }

  async function loadConvList() {
    try {
      var res = await fetch('/conversations?userId=' + userId);
      var convs = await res.json();
      renderConvList(convs);
      if (!currentId && convs.length) {
        switchConv(convs[0].id, convs[0].title);
      } else if (!currentId) {
        await newConversation();
      }
    } catch(e) {
      if (!currentId) await newConversation();
    }
  }

  async function newConversation() {
    var id = crypto.randomUUID();
    try {
      await fetch('/conversations', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ userId: userId, sessionId: id })
      });
    } catch(e) {}
    currentId = id;
    localStorage.setItem('cf_conv', id);
    convName.textContent = 'New conversation';
    clearMessages();
    await loadConvList();
  }

  async function switchConv(id, title) {
    currentId = id;
    localStorage.setItem('cf_conv', id);
    convName.textContent = title || 'New conversation';
    clearMessages();
    document.querySelectorAll('.conv-item').forEach(function(el) {
      el.classList.toggle('active', el.dataset.id === id);
    });
    try {
      var res = await fetch('/conversation?id=' + id);
      var data = await res.json();
      if (data.messages && data.messages.length) {
        data.messages.forEach(function(msg) {
          var el = addMessage(msg.role, false);
          if (msg.role === 'ai' || msg.role === 'assistant') {
            el.innerHTML = renderMarkdown(msg.content);
            addCopyButton(el, msg.content);
          } else {
            el.textContent = msg.content;
          }
        });
      }
    } catch(e) {}
    if (sidebar.classList.contains('open')) sidebar.classList.remove('open');
  }

  async function deleteConv(id) {
    await fetch('/conversation?id=' + id + '&userId=' + userId, { method: 'DELETE' });
    if (currentId === id) {
      currentId = null;
      localStorage.removeItem('cf_conv');
    }
    await loadConvList();
    if (!currentId) await newConversation();
  }

  // --- Messages ---
  function clearMessages() {
    messagesEl.innerHTML = '<div class="empty"><div class="empty-title">cf_ai_chat</div><div class="empty-sub">Persistent memory &middot; Voice input &middot; Llama 3.3</div></div>';
  }

  function removeEmpty() {
    var e = messagesEl.querySelector('.empty');
    if (e) e.remove();
  }

  function addMessage(role, streaming) {
    removeEmpty();
    var div = document.createElement('div');
    div.className = 'msg ' + (role === 'user' ? 'user' : 'ai') + (streaming ? ' streaming' : '');
    messagesEl.appendChild(div);
    messagesEl.scrollTop = messagesEl.scrollHeight;
    return div;
  }

  function addCopyButton(msgEl, text) {
    var actions = document.createElement('div');
    actions.className = 'msg-actions';
    var btn = document.createElement('button');
    btn.className = 'copy-btn';
    btn.textContent = 'Copy';
    btn.addEventListener('click', function() {
      navigator.clipboard.writeText(text).then(function() {
        btn.textContent = 'Copied';
        setTimeout(function() { btn.textContent = 'Copy'; }, 1500);
      });
    });
    actions.appendChild(btn);
    msgEl.appendChild(actions);
  }

  // --- Send message ---
  async function send() {
    var text = inputEl.value.trim();
    if (!text || sendBtn.disabled || !currentId) return;

    inputEl.value = '';
    inputEl.style.height = 'auto';
    sendBtn.disabled = true;

    var userEl = addMessage('user', false);
    userEl.textContent = text;

    var aiEl = addMessage('ai', true);

    try {
      var res = await fetch('/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message: text, sessionId: currentId, userId: userId })
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
              if (data.response) {
                fullText += data.response;
                aiEl.textContent = fullText;
                messagesEl.scrollTop = messagesEl.scrollHeight;
              }
            } catch(e) {}
          }
        }
      }

      // Render markdown after stream completes
      aiEl.classList.remove('streaming');
      aiEl.innerHTML = renderMarkdown(fullText);
      addCopyButton(aiEl, fullText);
      messagesEl.scrollTop = messagesEl.scrollHeight;

      // Update sidebar title if it changed (title generated after first message)
      setTimeout(refreshTitles, 1500);

    } catch(e) {
      aiEl.classList.remove('streaming');
      aiEl.textContent = 'Could not reach the server.';
    }

    sendBtn.disabled = false;
    inputEl.focus();
  }

  async function refreshTitles() {
    try {
      var res = await fetch('/conversations?userId=' + userId);
      var convs = await res.json();
      renderConvList(convs);
      var cur = convs.find(function(c) { return c.id === currentId; });
      if (cur && cur.title && cur.title !== 'New conversation') {
        convName.textContent = cur.title;
      }
    } catch(e) {}
  }

  // --- Voice input ---
  var recognition = null;
  var listening = false;

  function initVoice() {
    var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
    if (!SR) { voiceBtn.classList.add('unsupported'); voiceBtn.title = 'Voice not supported in this browser'; return false; }
    recognition = new SR();
    recognition.continuous = false;
    recognition.interimResults = false;
    recognition.lang = 'en-US';
    recognition.onresult = function(e) {
      inputEl.value = e.results[0][0].transcript;
      stopListening();
      send();
    };
    recognition.onerror = stopListening;
    recognition.onend = stopListening;
    return true;
  }

  function stopListening() {
    listening = false;
    voiceBtn.classList.remove('listening');
  }

  voiceBtn.addEventListener('click', function() {
    if (voiceBtn.classList.contains('unsupported')) return;
    if (!recognition && !initVoice()) return;
    if (listening) { recognition.stop(); return; }
    listening = true;
    voiceBtn.classList.add('listening');
    try { recognition.start(); } catch(e) { stopListening(); }
  });

  // --- Input auto-resize ---
  inputEl.addEventListener('input', function() {
    inputEl.style.height = 'auto';
    inputEl.style.height = Math.min(inputEl.scrollHeight, 160) + 'px';
  });
  inputEl.addEventListener('keydown', function(e) {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  sendBtn.addEventListener('click', send);
  newBtn.addEventListener('click', newConversation);
  menuBtn.addEventListener('click', function() { sidebar.classList.toggle('open'); });

  // --- Init ---
  loadConvList();
})();
</script>
</body>
</html>`;

