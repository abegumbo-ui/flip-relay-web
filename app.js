// The database URL isn't sensitive on its own (it's visible in this page's
// own network requests to anyone who opens dev tools regardless), so unlike
// the Android app's build it's just committed directly rather than injected
// from a secret. Deliberately no database *secret* is embedded here, since
// this page is served publicly: as of this writing the Firebase Realtime
// Database is wide open to anyone with the URL regardless of any secret
// (still in "test mode" -- see the main repo's README), so the old ?auth=
// parameter wasn't adding real protection anyway.
const DATABASE_URL = "https://flip-relay-default-rtdb.firebaseio.com/";
// Matches FirebaseStorageClient.java on the phone -- confirmed against the
// actual project, not the older "<project>.appspot.com" convention.
const STORAGE_BUCKET = "flip-relay.firebasestorage.app";

const ROOM_KEY = "flip_relay_room";
// Bumping this suffix invalidates every existing saved cache app-wide, so a
// fix to how a message is parsed/normalized (e.g. phone number formatting)
// actually applies retroactively instead of being stuck baked into old
// locally-cached data forever. Forces one fresh re-fetch from Firebase.
const CACHE_KEY_PREFIX = "flip_relay_cache_v2_";

let roomId = null;
let messages = []; // merged incoming + sent + scheduled (all from Firebase) + local optimistic sends
let seenIncomingKeys = new Set();
let seenSentKeys = new Set();
let seenScheduledKeys = new Set();
let incomingStream = null;
let sentStream = null;
let scheduledStream = null;
let incomingConnected = false;
let sentConnected = false;
let scheduledConnected = false;
let currentChatNumber = null;
let pendingAttachmentFile = null;
let pendingAttachmentKind = null; // "photo" | "video" | "contact" | null
let pendingAttachmentName = null; // display name, only meaningful for "contact"
let readState = {}; // number -> lastRead timestamp (localStorage-backed, mirrors the tablet app's ReadState)

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
  // Re-normalize on every load (cheap, idempotent for already-correct data)
  // so a future fix to normalizeNumber applies to already-cached messages
  // too, instead of staying wrong until someone thinks to bump the cache
  // version key.
  for (const m of messages) {
    if (m.number) m.number = normalizeNumber(m.number);
  }
  seenIncomingKeys = new Set(
    messages.filter((m) => m.direction === "in").map((m) => m.id)
  );
  seenSentKeys = new Set(
    messages.filter((m) => m.direction === "out" && !m.id.startsWith("local-")).map((m) => m.id)
  );
  seenScheduledKeys = new Set(
    messages.filter((m) => m.direction === "scheduled").map((m) => m.id)
  );
}

function saveCache() {
  try {
    localStorage.setItem(cacheKey(), JSON.stringify(messages));
  } catch (e) {
    // storage full or unavailable -- not fatal, just means history won't persist
  }
}

// Numbers show up in different formats depending on where they came from --
// the carrier delivers incoming senders as bare digits ("7322765687"), but
// the phone's own SMS log stores sent-to addresses with a country code
// ("+17322765687"). Without normalizing both to the same 10-digit form,
// the same person shows up as two separate conversations.
function normalizeNumber(n) {
  if (!n) return "";
  const digits = n.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

// ---------- read state (mirrors the tablet app's ReadState) ----------

function readStateKey() {
  return "flip_relay_web_read_" + roomId;
}

function loadReadState() {
  try {
    readState = JSON.parse(localStorage.getItem(readStateKey())) || {};
  } catch (e) {
    readState = {};
  }
}

function saveReadState() {
  try {
    localStorage.setItem(readStateKey(), JSON.stringify(readState));
  } catch (e) {
    // not fatal -- worst case unread sorting resets next load
  }
}

function markRead(number) {
  if (!number) return;
  readState[number] = Date.now();
  saveReadState();
}

function isUnread(convo) {
  return convo.last.direction === "in" && convo.last.timestamp > (readState[convo.number] || 0);
}

// ---------- notifications ----------

function requestNotificationPermission() {
  if (!("Notification" in window)) return;
  if (Notification.permission === "default") {
    Notification.requestPermission().catch(() => {});
  }
}

// Fired only for a genuinely new incoming push (not the initial bulk load
// on connect/reconnect) -- there's no server-side infrastructure for real
// closed-app Web Push here, so this is best-effort: it only fires while
// this tab is actually open.
function notifyIncoming(data) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  const number = normalizeNumber(data.sender);
  if (number && number === currentChatNumber && !document.hidden) return; // already looking at it
  const title = data.contactName || number || "New message";
  const body = data.imageUrl ? "📷 Picture" : (data.attachmentType === "video" ? "🎥 Video"
      : data.attachmentType === "vcard" ? "👤 Contact" : (data.body || ""));
  try {
    const n = new Notification(title, { body, tag: "flip-relay-" + number });
    n.onclick = () => { window.focus(); if (number) openChat(number); };
  } catch (e) {
    // Notification constructor can throw on some mobile browsers that only
    // support notifications via a service worker -- not worth failing over.
  }
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
  el("back-btn").addEventListener("click", () => {
    currentChatNumber = null;
    showScreen("conversations");
    renderConversationList();
  });
  el("send-btn").addEventListener("click", onSendClick);
  el("compose-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSendClick();
    }
  });
  el("schedule-btn").addEventListener("click", onScheduleButtonClick);
  el("schedule-confirm-btn").addEventListener("click", onScheduleConfirmClick);
  el("schedule-cancel-btn").addEventListener("click", () => {
    el("schedule-picker").classList.add("hidden");
    el("schedule-error").textContent = "";
  });

  el("attach-btn").addEventListener("click", onAttachClick);
  el("attachment-remove-btn").addEventListener("click", clearAttachment);
}

function clearAttachment() {
  pendingAttachmentFile = null;
  pendingAttachmentKind = null;
  pendingAttachmentName = null;
  el("attachment-preview").classList.add("hidden");
  el("attachment-thumb").classList.add("hidden");
  el("attachment-label").classList.add("hidden");
}

// ---------- action sheet (attach-type / live-vs-gallery pickers) ----------

function showActionSheet(title, options) {
  return new Promise((resolve) => {
    const overlay = el("action-sheet-overlay");
    el("action-sheet-title").textContent = title;
    const optsEl = el("action-sheet-options");
    optsEl.innerHTML = "";
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      overlay.classList.add("hidden");
      overlay.onclick = null;
      resolve(value);
    };
    for (const opt of options) {
      const btn = document.createElement("button");
      btn.className = "action-sheet-option";
      btn.textContent = opt.label;
      btn.addEventListener("click", () => finish(opt.value));
      optsEl.appendChild(btn);
    }
    el("action-sheet-cancel").onclick = () => finish(null);
    overlay.onclick = (e) => { if (e.target === overlay) finish(null); };
    overlay.classList.remove("hidden");
  });
}

// Creates a throwaway <input type=file>, with "capture" set for the live
// camera/camcorder path or left off for a plain gallery/file pick, and
// resolves with whatever the user chose (or null if they backed out).
function pickFile({ accept, capture }) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    if (capture) input.capture = capture;
    let resolved = false;
    input.addEventListener("change", () => {
      resolved = true;
      resolve(input.files[0] || null);
    }, { once: true });
    // No reliable "cancel" event for <input type=file> -- if the picker
    // closes without a change event, treat it as a cancel after it's had
    // a chance to fire.
    window.addEventListener("focus", function onFocus() {
      window.removeEventListener("focus", onFocus);
      setTimeout(() => { if (!resolved) resolve(null); }, 300);
    }, { once: true });
    input.click();
  });
}

async function onAttachClick() {
  const type = await showActionSheet("Attach", [
    { label: "📷 Photo", value: "photo" },
    { label: "🎥 Video", value: "video" },
    { label: "👤 Contact", value: "contact" },
  ]);
  if (!type) return;

  if (type === "contact") {
    await attachContact();
    return;
  }

  const mode = await showActionSheet(type === "photo" ? "Photo" : "Video", [
    { label: type === "photo" ? "Take Photo" : "Take Video", value: "live" },
    { label: "Choose From Gallery", value: "gallery" },
  ]);
  if (!mode) return;

  const file = await pickFile({
    accept: type === "photo" ? "image/*" : "video/*",
    capture: mode === "live" ? "environment" : null,
  });
  if (!file) return;
  if (file.size > 15 * 1024 * 1024) {
    alert("That file is too large to send (over 15MB).");
    return;
  }
  setPendingAttachment(file, type, null);
}

// Uses the Contact Picker API where it's available (Android Chrome, this
// tablet's actual browser) and falls back to a couple of plain prompts on
// browsers that don't support it at all, so attaching a contact never just
// silently does nothing.
async function attachContact() {
  if (navigator.contacts && navigator.contacts.select) {
    try {
      const supported = await navigator.contacts.getProperties();
      const props = ["name", "tel"].filter((p) => supported.includes(p));
      const [contact] = await navigator.contacts.select(
        props.length ? props : ["name", "tel"], { multiple: false });
      if (!contact) return;
      const name = (contact.name && contact.name[0]) || "Contact";
      const tel = (contact.tel && contact.tel[0]) || "";
      buildAndAttachVcard(name, tel);
    } catch (e) {
      // User cancelled the picker, or it's not actually usable here --
      // either way, nothing to attach.
      logDebug("Contact picker unavailable/cancelled: " + e);
    }
    return;
  }
  const name = prompt("Contact name?");
  if (!name) return;
  const tel = prompt("Phone number?");
  if (!tel) return;
  buildAndAttachVcard(name, tel);
}

function buildAndAttachVcard(name, tel) {
  const vcard = "BEGIN:VCARD\nVERSION:3.0\nN:" + name + "\nFN:" + name
      + (tel ? "\nTEL:" + tel : "") + "\nEND:VCARD\n";
  const file = new File([vcard], name + ".vcf", { type: "text/x-vcard" });
  setPendingAttachment(file, "contact", name);
}

function setPendingAttachment(file, kind, name) {
  pendingAttachmentFile = file;
  pendingAttachmentKind = kind;
  pendingAttachmentName = name;
  if (kind === "photo") {
    el("attachment-thumb").src = URL.createObjectURL(file);
    el("attachment-thumb").classList.remove("hidden");
    el("attachment-label").classList.add("hidden");
  } else {
    el("attachment-thumb").classList.add("hidden");
    el("attachment-label").textContent = kind === "video"
        ? "🎥 Video attached"
        : "👤 " + (name || "Contact");
    el("attachment-label").classList.remove("hidden");
  }
  el("attachment-preview").classList.remove("hidden");
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
    const [incomingRes, sentRes, scheduledRes] = await Promise.all([
      fetch(roomUrl("messages/incoming")),
      fetch(roomUrl("messages/sent")),
      fetch(roomUrl("messages/scheduled")),
    ]);
    if (!incomingRes.ok || !sentRes.ok || !scheduledRes.ok) {
      const badStatus = !incomingRes.ok ? incomingRes.status : (!sentRes.ok ? sentRes.status : scheduledRes.status);
      throw new Error("Firebase replied with an error (HTTP " + badStatus + "). " +
          "Double check the pairing code matches exactly what's on the flip phone.");
    }
    const [incomingSnapshot, sentSnapshot, scheduledSnapshot] =
        await Promise.all([incomingRes.json(), sentRes.json(), scheduledRes.json()]);

    if (persist) localStorage.setItem(ROOM_KEY, code);
    loadCache();
    loadReadState();
    if (incomingSnapshot && typeof incomingSnapshot === "object") {
      for (const key of Object.keys(incomingSnapshot)) upsertIncoming(key, incomingSnapshot[key]);
    }
    if (sentSnapshot && typeof sentSnapshot === "object") {
      for (const key of Object.keys(sentSnapshot)) upsertSent(key, sentSnapshot[key]);
    }
    if (scheduledSnapshot && typeof scheduledSnapshot === "object") {
      for (const key of Object.keys(scheduledSnapshot)) upsertScheduled(key, scheduledSnapshot[key]);
    }
    saveCache();

    setPairingProgress(true, "Connected!");
    await sleep(400);
    setPairingProgress(false);
    showScreen("conversations");
    renderConversationList();
    startStreams();
    requestNotificationPermission();
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
  if (scheduledStream) scheduledStream.close();
  incomingConnected = false;
  sentConnected = false;
  scheduledConnected = false;
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
  }, (connected) => { incomingConnected = connected; updateConnectionStatus(); }, notifyIncoming);

  sentStream = openStream("messages/sent", upsertSent, (key) => {
    const before = messages.length;
    messages = messages.filter((m) => !(m.direction === "out" && m.id === key));
    seenSentKeys.delete(key);
    return messages.length !== before;
  }, (connected) => { sentConnected = connected; updateConnectionStatus(); });

  scheduledStream = openStream("messages/scheduled", upsertScheduled, (key) => {
    const before = messages.length;
    messages = messages.filter((m) => !(m.direction === "scheduled" && m.id === key));
    seenScheduledKeys.delete(key);
    return messages.length !== before;
  }, (connected) => { scheduledConnected = connected; updateConnectionStatus(); });
}

function openStream(path, upsertFn, deleteFn, onConnectedChange, onSingleItemUpserted) {
  const es = new EventSource(roomUrl(path));

  es.addEventListener("open", () => onConnectedChange(true));
  es.addEventListener("error", () => onConnectedChange(false));

  const handle = (event) => {
    try {
      const parsed = JSON.parse(event.data);
      let changed = false;
      if (parsed.path === "/") {
        // Bulk snapshot (sent on first connect/reconnect) -- never treated
        // as "new" for notification purposes, only individual pushes are.
        if (parsed.data && typeof parsed.data === "object") {
          for (const key of Object.keys(parsed.data)) {
            if (upsertFn(key, parsed.data[key])) changed = true;
          }
        }
      } else {
        const key = parsed.path.slice(1);
        if (parsed.data === null) {
          changed = deleteFn(key);
        } else {
          changed = upsertFn(key, parsed.data);
          if (changed && onSingleItemUpserted) onSingleItemUpserted(parsed.data);
        }
      }
      if (changed) {
        saveCache();
        if (currentChatNumber) markRead(currentChatNumber);
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
  const connected = incomingConnected && sentConnected && scheduledConnected;
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
    imageUrl: data.imageUrl || null,
    attachmentUrl: data.attachmentUrl || null,
    attachmentKind: data.attachmentType || null,
    attachmentName: data.attachmentName || null,
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

  messages.push({
    id: key,
    direction: "out",
    number,
    contactName: null,
    body,
    imageUrl: data.imageUrl || null,
    attachmentUrl: data.attachmentUrl || null,
    attachmentKind: data.attachmentType || null,
    attachmentName: data.attachmentName || null,
    timestamp,
  });
  return true;
}

function upsertScheduled(key, data) {
  if (!data) return false;
  if (seenScheduledKeys.has(key)) return false;
  seenScheduledKeys.add(key);
  messages.push({
    id: key,
    direction: "scheduled",
    number: normalizeNumber(data.to),
    contactName: null,
    body: data.body || "",
    timestamp: data.sendAt || Date.now(), // sorts/previews by when it WILL send
    sendAt: data.sendAt || Date.now(),
  });
  return true;
}

// ---------- sending ----------

// Uploads straight from the browser to Firebase Storage, same REST API the
// phone's FirebaseStorageClient uses -- no server-side code needed.
async function uploadToStorage(file, path) {
  const encodedPath = encodeURIComponent(path);
  const res = await fetch(
    `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o?uploadType=media&name=${encodedPath}`,
    { method: "POST", headers: { "Content-Type": file.type || "image/jpeg" }, body: file }
  );
  if (!res.ok) throw new Error("Storage upload failed: HTTP " + res.status);
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodedPath}?alt=media`;
}

async function onSendClick() {
  const input = el("compose-input");
  const rawBody = input.value.trim();
  const file = pendingAttachmentFile;
  const kind = pendingAttachmentKind; // "photo" | "video" | "contact" | null
  const attachmentName = pendingAttachmentName;
  if (!rawBody && !file) return;
  if (!currentChatNumber) return;

  const timestamp = Date.now();
  // Same marker convention the tablet app's ChatActivity uses for its own
  // local echo, so upsertSent()'s dedup match (which compares body text)
  // lines up with what the phone actually confirms back as "sent".
  const label = kind === "video" ? "🎥 Video" : kind === "contact" ? "👤 " + (attachmentName || "Contact") : null;
  const body = label ? (label + (rawBody ? ": " + rawBody : "")) : rawBody;

  // Shown immediately from the local file, before the upload even starts --
  // gets replaced with the real Firebase-hosted copy once the "sent"
  // confirmation comes back through upsertSent().
  const localImageUrl = kind === "photo" ? URL.createObjectURL(file) : null;

  const msg = {
    id: "local-" + timestamp + "-" + Math.random().toString(36).slice(2, 8),
    direction: "out",
    number: currentChatNumber,
    contactName: null,
    body,
    imageUrl: localImageUrl,
    attachmentUrl: null,
    attachmentKind: kind === "photo" ? null : kind,
    attachmentName,
    timestamp,
  };
  messages.push(msg);
  saveCache();
  input.value = "";
  clearAttachment();
  renderChat(currentChatNumber);
  renderConversationList();

  try {
    let imageUrl = null;
    let imagePath = null;
    let attachmentType = null;
    let attachmentUrl = null;
    if (kind === "photo") {
      imagePath = `attachments/${roomId}/${timestamp}.jpg`;
      imageUrl = await uploadToStorage(file, imagePath);
    } else if (kind === "video" || kind === "contact") {
      if (file.size > 15 * 1024 * 1024) throw new Error("Attachment too large");
      attachmentType = kind === "video" ? "video" : "vcard";
      const ext = kind === "video" ? (file.name.split(".").pop() || "mp4") : "vcf";
      const path = `attachments/${roomId}/${timestamp}.${ext}`;
      attachmentUrl = await uploadToStorage(file, path);
    }
    await fetch(roomUrl("messages/outgoing"), {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        to: currentChatNumber, body: rawBody, imageUrl, imagePath,
        attachmentType, attachmentUrl, attachmentName, timestamp,
      }),
    });
  } catch (e) {
    console.error("send failed", e);
  }
}

function onScheduleButtonClick() {
  const picker = el("schedule-picker");
  const opening = picker.classList.contains("hidden");
  picker.classList.toggle("hidden");
  if (opening) {
    el("schedule-error").textContent = "";
    const soon = new Date(Date.now() + 5 * 60000); // default: 5 min from now
    soon.setSeconds(0, 0);
    el("schedule-time").value = new Date(soon.getTime() - soon.getTimezoneOffset() * 60000)
        .toISOString().slice(0, 16);
  }
}

function onScheduleConfirmClick() {
  const body = el("compose-input").value.trim();
  const timeVal = el("schedule-time").value;
  const errorEl = el("schedule-error");
  if (!body) {
    errorEl.textContent = "Type a message first.";
    return;
  }
  if (!timeVal) {
    errorEl.textContent = "Pick a time.";
    return;
  }

  const sendAt = new Date(timeVal).getTime();
  if (isNaN(sendAt) || sendAt <= Date.now()) {
    errorEl.textContent = "Pick a time in the future.";
    return;
  }
  errorEl.textContent = "";

  fetch(roomUrl("messages/scheduled"), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ to: currentChatNumber, body, sendAt }),
  }).catch((e) => logDebug("Schedule failed: " + (e && e.stack ? e.stack : e)));

  el("compose-input").value = "";
  el("schedule-picker").classList.add("hidden");
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
    .map((c) => ({ ...c, unread: isUnread(c) }))
    .sort((a, b) => a.unread !== b.unread ? (a.unread ? -1 : 1) : b.last.timestamp - a.last.timestamp);
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

  for (const { number, last, unread } of convos) {
    const item = document.createElement("div");
    item.className = "conversation-item" + (unread ? " unread" : "");
    const prefix = last.direction === "out" ? "You: " : last.direction === "scheduled" ? "Scheduled: " : "";
    const preview = last.imageUrl ? "📷 Picture" + (last.body ? ": " + last.body : "") : last.body;
    item.innerHTML = `
      <div class="name">${unread ? '<span class="unread-dot">●</span>' : ""}${escapeHtml(displayName(number))}</div>
      <div class="preview">${prefix}${escapeHtml(preview)}</div>
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
  markRead(number);
  renderConversationList();
}

function renderChat(number) {
  const list = el("message-list");
  list.innerHTML = "";
  const thread = messages
    .filter((m) => m.number === number)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const m of thread) {
    const row = document.createElement("div");
    const isScheduled = m.direction === "scheduled";
    row.className = "bubble-row " + (isScheduled ? "out" : m.direction);
    const meta = isScheduled
        ? "⏰ Scheduled for " + formatTime(m.sendAt)
        : formatTime(m.timestamp);
    const imageHtml = m.imageUrl
        ? `<img class="bubble-image" src="${escapeHtml(m.imageUrl)}" alt="Picture" />`
        : "";
    // A video plays inline with the browser's own controls, same as a
    // picture renders inline -- a contact card has no in-page "player"
    // equivalent, so that one stays a plain link to open/import it.
    const attachmentHtml = (!m.imageUrl && m.attachmentUrl && m.attachmentKind)
        ? (m.attachmentKind === "video"
            ? `<video class="bubble-video" src="${escapeHtml(m.attachmentUrl)}" controls preload="metadata"></video>`
            : `<a class="bubble-attachment" href="${escapeHtml(m.attachmentUrl)}" target="_blank" rel="noopener">👤 ${escapeHtml(m.attachmentName || "Open contact")}</a>`)
        : "";
    const bodyHtml = m.body ? escapeHtml(m.body) : "";
    row.innerHTML = `<div class="bubble${isScheduled ? " scheduled" : ""}">${imageHtml}${attachmentHtml}${bodyHtml}<span class="meta">${meta}</span></div>`;
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
