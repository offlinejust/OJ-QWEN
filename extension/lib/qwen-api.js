var OjQwenApi = (() => {
  const BASE = 'https://chat.qwen.ai';

  function authHeaders() {
    const headers = { Accept: 'application/json' };
    try {
      const token = globalThis.localStorage?.getItem('token');
      if (token) headers.Authorization = 'Bearer ' + token;
    } catch {}
    return headers;
  }

  async function apiGet(path, { fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
    const controller = typeof AbortController === 'function' ? new AbortController() : null;
    const timer = controller && timeoutMs > 0
      ? setTimeout(() => controller.abort(), timeoutMs)
      : null;
    try {
      const opts = {
        method: 'GET',
        credentials: 'include',
        headers: authHeaders(),
      };
      if (controller) opts.signal = controller.signal;
      const res = await fetchImpl(BASE + path, opts);
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch {}
      if (!res.ok) {
        throw new Error(`HTTP ${res.status} on ${path}`);
      }
      return { status: res.status, json };
    } catch (err) {
      if (err?.name === 'AbortError') {
        throw new Error(`Таймаут запроса к Qwen API (${path})`);
      }
      throw err;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  function extractArray(payload, preferredKeys = ['list', 'items', 'data', 'projects', 'chats']) {
    if (Array.isArray(payload)) return payload;
    if (!payload || typeof payload !== 'object') return [];
    const data = payload.data;
    if (Array.isArray(data)) return data;
    if (data && typeof data === 'object') {
      for (const k of preferredKeys) {
        if (Array.isArray(data[k])) return data[k];
      }
    }
    for (const k of preferredKeys) {
      if (Array.isArray(payload[k])) return payload[k];
    }
    return [];
  }

  function parseProjectsPayload(payload) {
    const rows = extractArray(payload, ['projects', 'list', 'items', 'data']);
    const seen = new Set();
    const out = [];
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || item.project_id || '').trim();
      const name = String(item.name || item.title || '').trim();
      if (!id || !name || seen.has(id)) continue;
      seen.add(id);
      out.push({ id, name, updatedAt: Number(item.updated_at || item.update_time || 0) });
    }
    return out;
  }

  function parseChatsPayload(payload) {
    const rows = extractArray(payload, ['chats', 'list', 'items', 'data']);
    const out = [];
    for (const item of rows) {
      if (!item || typeof item !== 'object') continue;
      const id = String(item.id || item.chat_id || '').trim();
      if (!id) continue;
      const title = String(item.title || item.name || 'Без названия').trim();
      out.push({
        id,
        key: 'c:' + id,
        title,
        url: BASE + '/c/' + id,
        updatedAt: Number(item.updated_at || item.update_time || item.created_at || 0),
      });
    }
    return out;
  }

  // Extract visible answer text & thinking text separately from a Qwen message object
  function extractMessageText(msg) {
    if (!msg || typeof msg !== 'object') return { answer: '', thinking: '', raw: '' };
    const list = msg.content_list || msg.contents || (Array.isArray(msg.content) ? msg.content : null);
    if (Array.isArray(list) && list.length) {
      const answerParts = [];
      const thinkParts = [];
      for (const part of list) {
        if (!part) continue;
        if (typeof part === 'string') {
          answerParts.push(part);
          continue;
        }
        const txt = typeof part.content === 'string'
          ? part.content
          : typeof part.text === 'string'
            ? part.text
            : '';
        if (!txt) continue;
        const phase = String(part.phase || part.type || '').toLowerCase();
        if (phase === 'think' || phase === 'thinking' || phase === 'reasoning') {
          thinkParts.push(txt);
        } else {
          answerParts.push(txt);
        }
      }
      const answer = answerParts.join('\n').trim();
      const thinking = thinkParts.join('\n').trim();
      return { answer, thinking, raw: [thinking, answer].filter(Boolean).join('\n') };
    }
    const str = typeof msg.content === 'string' ? msg.content : '';
    return { answer: str.trim(), thinking: '', raw: str.trim() };
  }

  // Parse chat detail payload into ordered raw messages (supports history.messages tree & flat arrays)
  function parseChatDetailPayload(payload) {
    const root = payload?.data || payload || {};
    const chatObj = root.chat || root;
    let ordered = [];

    const history = chatObj?.history;
    if (history?.messages && typeof history.messages === 'object' && !Array.isArray(history.messages)) {
      const map = history.messages;
      let curId = history.currentId || chatObj.currentId;
      if (!curId) {
        // Fallback: pick leaf message with latest timestamp
        const all = Object.values(map);
        const leaf = all
          .filter(m => !m?.childrenIds?.length)
          .sort((a, b) => (Number(b?.timestamp || 0) - Number(a?.timestamp || 0)))[0];
        curId = leaf?.id;
      }
      const visited = new Set();
      while (curId && map[curId] && !visited.has(curId)) {
        visited.add(curId);
        ordered.push(map[curId]);
        curId = map[curId].parentId;
      }
      ordered.reverse();
    } else if (Array.isArray(chatObj?.messages)) {
      ordered = chatObj.messages;
    } else if (Array.isArray(root?.messages)) {
      ordered = root.messages;
    } else if (Array.isArray(history?.messages)) {
      ordered = history.messages;
    }

    const rawMessages = [];
    for (const m of ordered) {
      if (!m || typeof m !== 'object') continue;
      const roleRaw = String(m.role || '').toLowerCase();
      if (roleRaw !== 'user' && roleRaw !== 'assistant') continue;
      const extracted = extractMessageText(m);
      rawMessages.push({
        id: String(m.id || ''),
        role: roleRaw === 'user' ? 'user' : 'qwen',
        answer: extracted.answer,
        thinking: extracted.thinking,
        raw: extracted.raw,
        done: m.done !== false,
      });
    }

    return {
      id: String(root.id || chatObj.id || ''),
      title: String(root.title || chatObj.title || ''),
      rawMessages,
    };
  }

  // Convert raw API chat messages into clean UI transcript + exact context token count + protocol msg count
  function buildTranscriptFromDetail(detail, protocolImpl = globalThis.OjProtocol) {
    const transcript = [];
    let totalRawText = '';
    let protocolMessages = 0;

    for (const m of detail.rawMessages || []) {
      totalRawText += (m.raw || '') + '\n';
      const text = m.answer || '';
      if (!text) continue;

      if (m.role === 'user') {
        const isBridge = protocolImpl?.isOutgoingBridgePacket
          ? protocolImpl.isOutgoingBridgePacket(text)
          : /^\s*OJ_FILES_BRIDGE\s+(?:TASK|RESULTS)\b/.test(text);
        if (isBridge && /^\s*OJ_FILES_BRIDGE\s+TASK\b/.test(text)) {
          protocolMessages++;
          const decoded = protocolImpl?.decodeTaskPacket(text);
          if (decoded?.task) {
            transcript.push({ role: 'user', text: decoded.task, unformatted: false, turn: decoded.turn || null });
          }
          continue;
        }
        if (isBridge && /^\s*OJ_FILES_BRIDGE\s+RESULTS\b/.test(text)) {
          protocolMessages++;
          continue;
        }
        transcript.push({ role: 'user', text, unformatted: false, turn: null });
      } else {
        if (text.includes('OJ_FILES_REPLY') && text.includes('OJ_FILES_END')) {
          const parsed = protocolImpl?.parse(text);
          if (parsed?.type === 'final') {
            transcript.push({ role: 'qwen', text: parsed.summary, unformatted: false, turn: parsed.turn || null });
            continue;
          }
          if (parsed?.type === 'batch') {
            // Skip intermediate batch replies in main conversation feed (they appear as step cards)
            continue;
          }
        }
        transcript.push({ role: 'qwen', text, unformatted: false, turn: null });
      }
    }

    const limit = protocolImpl?.CONTEXT_LIMIT_TOKENS || 1_000_000;
    const used = protocolImpl ? protocolImpl.estimateTokens(totalRawText) : Math.ceil(totalRawText.length / 3);
    return {
      transcript,
      protocolMessages,
      contextWindow: {
        used,
        limit,
        remaining: Math.max(0, limit - used),
        percent: Math.min(100, (used / limit) * 100),
      },
    };
  }

  async function listProjects(opts) {
    const { json } = await apiGet('/api/v2/projects/', opts);
    return parseProjectsPayload(json);
  }

  async function listProjectChats(projectId, { maxPages = 25, fetchImpl = globalThis.fetch } = {}) {
    if (!projectId) return [];
    const seen = new Set();
    const all = [];
    let firstPageSize = 0;

    for (let page = 1; page <= maxPages; page++) {
      const url = `/api/v2/chats/?project_id=${encodeURIComponent(projectId)}&page=${page}`;
      const { json } = await apiGet(url, { fetchImpl });
      const batch = parseChatsPayload(json);
      if (!batch.length) break;
      if (page === 1) firstPageSize = batch.length;

      let added = 0;
      for (const chat of batch) {
        if (!seen.has(chat.id)) {
          seen.add(chat.id);
          all.push(chat);
          added++;
        }
      }
      if (added === 0) break;
      // Stop if API explicitly signals no more pages or returned fewer items than a full page
      const hasMore = json?.data?.has_more ?? json?.has_more;
      if (hasMore === false) break;
      if (page > 1 && batch.length < firstPageSize) break;
    }

    return all;
  }

  async function getChat(chatId, opts) {
    if (!chatId) return null;
    const { json } = await apiGet(`/api/v2/chats/${encodeURIComponent(chatId)}`, opts);
    return parseChatDetailPayload(json);
  }

  // Safe schema-only probe (no user texts, titles, or tokens)
  async function probeSchema(projectId, chatId) {
    const shape = obj => {
      if (Array.isArray(obj)) return { kind: 'array', len: obj.length, firstKeys: obj[0] && typeof obj[0] === 'object' ? Object.keys(obj[0]).slice(0, 12) : [] };
      if (!obj || typeof obj !== 'object') return typeof obj;
      const out = { keys: Object.keys(obj).slice(0, 12) };
      if (obj.data !== undefined) out.data = shape(obj.data);
      return out;
    };
    const report = {};
    try {
      const p = await apiGet('/api/v2/projects/');
      report.projects = { status: p.status, count: parseProjectsPayload(p.json).length, shape: shape(p.json) };
    } catch (e) {
      report.projects = { error: e.message };
    }
    if (projectId) {
      try {
        const c = await apiGet(`/api/v2/chats/?project_id=${encodeURIComponent(projectId)}&page=1`);
        report.projectChats = { status: c.status, count: parseChatsPayload(c.json).length, shape: shape(c.json) };
      } catch (e) {
        report.projectChats = { error: e.message };
      }
    }
    if (chatId) {
      try {
        const d = await apiGet(`/api/v2/chats/${encodeURIComponent(chatId)}`);
        const parsed = parseChatDetailPayload(d.json);
        report.chatDetail = { status: d.status, messageCount: parsed.rawMessages.length, shape: shape(d.json) };
      } catch (e) {
        report.chatDetail = { error: e.message };
      }
    }
    return report;
  }

  return {
    listProjects,
    listProjectChats,
    getChat,
    probeSchema,
    parseProjectsPayload,
    parseChatsPayload,
    parseChatDetailPayload,
    buildTranscriptFromDetail,
  };
})();

if (typeof module !== 'undefined' && module.exports) {
  module.exports = OjQwenApi;
}
