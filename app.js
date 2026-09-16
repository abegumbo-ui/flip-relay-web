// The database URL isn't sensitive on its own (it's visible in this page's
// own network requests to anyone who opens dev tools regardless), so unlike
// the Android app's build it's just committed directly rather than injected
// from a secret. Deliberately no database *secret* is embedded here, since
// this page is served publicly: as of this writing the Firebase Realtime
// Database is wide open to anyone with the URL regardless of any secret
// (still in "test mode" -- see the main repo's README), so the old ?auth=
// parameter wasn't adding real protection anyway.
const DATABASE_URL = "https://flip-relay-default-rtdb.firebaseio.com/";

const ROOM_KEY = "flip_relay_room";
const CACHE_KEY_PREFIX = "flip_relay_cache_";

let roomId = null;
let messages = []; // merged incoming + sent (both from Firebase) + local optimistic sends
let seenIncomingKeys = new Set();
let seenSentKeys = new Set();
let incomingStream = null;
let sentStream = null;
let incomingConnected = false;
let sentConnected = false;
let currentChatNumber = null;

const el = (id) => document.getElementById(id);

// ---------- storage helpers ----------

function cacheKey() {
  return CACHE_KEY_PREFIX + roomId;
}

function loadCache() {
  try {
    const raw = localStorage.getItem(cacheKey());
    messages = raw ? JSON.parse(raw) : [];
  } catch (e) {
    messages = [];
  }
  seenIncomingKeys = new Set(
    messages.filter((m) => m.direction === "in").map((m) => m.id)
  );
  seenSentKeys = new Set(
    messages.filter((m) => m.direction === "out" && !m.id.startsWith("local-")).map((m) => m.id)
  );
}

function saveCache() {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify(messages));
  } catch (e) {
    // storage full or unavailable -- not fatal, just means history won't persist
  }
}

function normalizeNumber(n) {
  if (!n) return "";
  return n.replace(/[^\d+]/g, "");
}

// ---------- pairing ----------

function init() {
  const savedRoom = localStorage.getItem(ROOM_KEY);
  if (savedRoom) {
    connectToRoom(savedRoom, false);
  } else {
    showScreen("pairing");
  }

  el("connect-btn").addEventListener("click", onConnectClick);
  el("code-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter") onConnectClick();
  });
  el("forget-btn").addEventListener("click", onForgetClick);
  el("back-btn").addEventListener("click", () => showScreen("conversations"));
  el("send-btn").addEventListener("click", onSendClick);
  el("compose-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSendClick();
    }
  });
}

function onConnectClick() {
  const code = el("code-input").value.trim().toUpperCase();
  if (code.length < 4) {
    el("pairing-error").textContent = "That doesn't look like a full code.";
    return;
  }
  connectToRoom(code, true);
}

// Tries the room before committing to it: a plain fetch() (unlike
// EventSource) gives us a real, readable error message if something's
// wrong -- wrong code, no internet, Firebase unreachable, etc. -- instead
// of failing silently.
async function connectToRoom(code, persist) {
  roomId = code;
  clearDebugLog();
  setPairingProgress(true, "Connecting to " + code + "...");

  try {
    const [incomingRes, sentRes] = await Promise.all([
      fetch(roomUrl("messages/incoming")),
      fetch(roomUrl("messages/sent")),
    ]);
    if (!incomingRes.ok || !sentRes.ok) {
      const badStatus = !incomingRes.ok ? incomingRes.status : sentRes.status;
      throw new Error("Firebase replied with an error (HTTP " + badStatus + "). " +
          "Double check the pairing code matches exactly what's on the flip phone.");
    }
    const [incomingSnapshot, sentSnapshot] = await Promise.all([incomingRes.json(), sentRes.json()]);

    if (persist) localStorage.setItem(ROOM_KEY, code);
    loadCache();
    if (incomingSnapshot && typeof incomingSnapshot === "object") {
      for (const key of Object.keys(incomingSnapshot)) upsertIncoming(key, incomingSnapshot[key]);
    }
    if (sentSnapshot && typeof sentSnapshot === "object") {
      for (const key of Object.keys(sentSnapshot)) upsertSent(key, sentSnapshot[key]);
    }
    saveCache();

    setPairingProgress(true, "Connected!");
    await sleep(400);
    setPairingProgress(false);
    showScreen("conversations");
    renderConversationList();
    startStreams();
  } catch (e) {
    setPairingProgress(false);
    const message = e instanceof TypeError
        ? "Couldn't reach the internet (or Firebase). Check the tablet's wifi/data and try again."
        : e.message;
    el("pairing-error").textContent = message;
    logDebug(String(e && e.stack ? e.stack : e));
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function setPairingProgress(inProgress, text) {
  el("pairing-form").classList.toggle("hidden", inProgress);
  el("pairing-progress").classList.toggle("hidden", !inProgress);
  if (text) el("pairing-progress-text").textContent = text;
  el("connect-btn").disabled = inProgress;
}

function logDebug(text) {
  const box = el("debug-log");
  box.classList.remove("hidden");
  box.textContent = text;
}

function clearDebugLog() {
  const box = el("debug-log");
  box.classList.add("hidden");
  box.textContent = "";
}

function onForgetClick() {
  if (!confirm("Disconnect this tablet? You'll need the pairing code again to reconnect.")) return;
  if (incomingStream) incomingStream.close();
  if (sentStream) sentStream.close();
  incomingConnected = false;
  sentConnected = false;
  localStorage.removeItem(ROOM_KEY);
  roomId = null;
  messages = [];
  setPairingProgress(false);
  clearDebugLog();
  showScreen("pairing");
  el("code-input").value = "";
  el("pairing-error").textContent = "";
}

// ---------- screens ----------

function showScreen(name) {
  ["pairing", "conversations", "chat"].forEach((s) => {
    el("screen-" + s).classList.toggle("hidden", s !== name);
  });
}

// ---------- Firebase streaming ----------

function roomUrl(path) {
  return `${DATABASE_URL}/rooms/${roomId}/${path}.json`;
}

function startStreams() {
  incomingStream = openStream("messages/incoming", upsertIncoming, (key) => {
    const before = messages.length;
    messages = messages.filter((m) => !(m.direction === "in" && m.id === key));
    seenIncomingKeys.delete(key);
    return messages.length !== before;
  }, (connected) => { incomingConnected = connected; updateConnectionStatus(); });

  sentStream = openStream("messages/sent", upsertSent, (key) => {
    const before = messages.length;
    messages = messages.filter((m) => !(m.direction === "out" && m.id === key));
    seenSentKeys.delete(key);
    return messages.length !== before;
  }, (connected) => { sentConnected = connected; updateConnectionStatus(); });
}

function openStream(path, upsertFn, deleteFn, onConnectedChange) {
  const es = new EventSource(roomUrl(path));

  es.addEventListener("open", () => onConnectedChange(true));
  es.addEventListener("error", () => onConnectedChange(false));

  const handle = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      let changed = false;
      if (parsed.path === "/") {
        if (parsed.data && typeof parsed.data === "object") {
          for (const key of Object.keys(parsed.data)) {
            if (upsertFn(key, parsed.data[key])) changed = true;
          }
        }
      } else {
        const key = parsed.path.slice(1);
        changed = parsed.data === null ? deleteFn(key) : upsertFn(key, parsed.data);
      }
      if (changed) {
        saveCache();
        renderConversationList();
        if (currentChatNumber) renderChat(currentChatNumber);
      }
    } catch (e) {
      logDebug("Stream event error (" + path + "): " + (e && e.stack ? e.stack : e));
    }
  };
  es.addEventListener("put", handle);
  es.addEventListener("patch", handle);
  return es;
}

function updateConnectionStatus() {
  const connected = incomingConnected && sentConnected;
  const dot = el("conv-status-dot");
  if (dot) dot.classList.toggle("connected", connected);
  const statusText = el("conv-status-text");
  if (statusText) statusText.textContent = connected ? "Connected" : "Reconnecting...";
}

function upsertIncoming(key, data) {
  if (!data) return false;
  if (seenIncomingKeys.has(key)) return false;
  seenIncomingKeys.add(key);
  messages.push({
    id: key,
    direction: "in",
    number: normalizeNumber(data.sender),
    contactName: data.contactName || null,
    body: data.body || "",
    timestamp: data.timestamp || Date.now(),
  });
  return true;
}

// A "sent" item confirms a message really went out -- whether it was
// composed here (replace the optimistic local echo with the real one, so
// it isn't shown twice) or sent directly from the flip phone's own texting
// app (a message this tablet never knew about until now).
function upsertSent(key, data) {
  if (!data) return false;
  if (seenSentKeys.has(key)) return false;
  seenSentKeys.add(key);

  const number = normalizeNumber(data.to);
  const body = data.body || "";
  const timestamp = data.timestamp || Date.now();

  const localIdx = messages.findIndex((m) =>
    m.direction === "out" && m.id.startsWith("local-") &&
    m.number === number && m.body === body &&
    Math.abs(m.timestamp - timestamp) < 120000
  );
  if (localIdx !== -1) messages.splice(localIdx, 1);

  messages.push({ id: key, direction: "out", number, contactName: null, body, timestamp });
  return true;
}

// ---------- sending ----------

function onSendClick() {
  const input = el("compose-input");
  const body = input.value.trim();
  if (!body || !currentChatNumber) return;

  const msg = {
    id: "local-" + Date.now() + "-" + Math.random().toString(36).slice(2, 8),
    direction: "out",
    number: currentChatNumber,
    contactName: null,
    body,
    timestamp: Date.now(),
  };
  messages.push(msg);
  saveCache();
  input.value = "";
  renderChat(currentChatNumber);
  renderConversationList();

  fetch(roomUrl("messages/outgoing"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: currentChatNumber, body, timestamp: msg.timestamp }),
  }).catch((e) => console.error("send failed", e));
}

// ---------- rendering ----------

function conversationsByNumber() {
  const byNumber = new Map();
  for (const m of messages) {
    if (!m.number) continue;
    const existing = byNumber.get(m.number);
    if (!existing || m.timestamp > existing.timestamp) {
      byNumber.set(m.number, m);
    }
    if (m.direction === "in" && m.contactName) {
      const entry = byNumber.get(m.number);
      if (entry) entry.contactName = entry.contactName || m.contactName;
    }
  }
  return [...byNumber.entries()]
    .map(([number, last]) => ({ number, last }))
    .sort((a, b) => b.last.timestamp - a.last.timestamp);
}

function displayName(number) {
  const withName = messages.find((m) => m.number === number && m.contactName);
  return (withName && withName.contactName) || number;
}

function renderConversationList() {
  const list = el("conversation-list");
  const convos = conversationsByNumber();
  list.innerHTML = "";
  el("empty-state").classList.toggle("hidden", convos.length > 0);

  for (const { number, last } of convos) {
    const item = document.createElement("div");
    item.className = "conversation-item";
    item.innerHTML = `
      <div class="name">${escapeHtml(displayName(number))}</div>
      <div class="preview">${last.direction === "out" ? "You: " : ""}${escapeHtml(last.body)}</div>
      <div class="time">${formatTime(last.timestamp)}</div>
    `;
    item.addEventListener("click", () => openChat(number));
    list.appendChild(item);
  }
}

function openChat(number) {
  currentChatNumber = number;
  el("chat-title").textContent = displayName(number);
  el("chat-subtitle").textContent = number;
  showScreen("chat");
  renderChat(number);
}

function renderChat(number) {
  const list = el("message-list");
  list.innerHTML = "";
  const thread = messages
    .filter((m) => m.number === number)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const m of thread) {
    const row = document.createElement("div");
    row.className = "bubble-row " + m.direction;
    row.innerHTML = `<div class="bubble">${escapeHtml(m.body)}<span class="meta">${formatTime(m.timestamp)}</span></div>`;
    list.appendChild(row);
  }
  list.scrollTop = list.scrollHeight;
}

function formatTime(ts) {
  const d = new Date(ts);
  const now = new Date();
  const sameDay = d.toDateString() === now.toDateString();
  return sameDay
    ? d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })
    : d.toLocaleDateString([], { month: "short", day: "numeric" });
}

function escapeHtml(s) {
  const div = document.createElement("div");
  div.textContent = s == null ? "" : String(s);
  return div.innerHTML;
}

// ---------- boot ----------

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("sw.js").catch(() => {});
  });
}

init();
