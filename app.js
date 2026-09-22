// Filled in at CI build time from the FIREBASE_DATABASE_URL /
// FIREBASE_DATABASE_SECRET GitHub Actions secrets -- these placeholders are
// what actually lives in source control (see .github/workflows/build.yml).
const DATABASE_URL = "https://flip-relay-default-rtdb.firebaseio.com/";
const DATABASE_SECRET = "Dqu4Jm70Y9uPBfEQT2Phush1kDBg5mIdqBL9wDyw";
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
let pinnedState = {}; // number -> true (localStorage-backed, mirrors the tablet app's pin/unpin)

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

// ---------- pinned conversations (mirrors the tablet app's pin/unpin) ----------

function pinnedStateKey() {
  return "flip_relay_web_pinned_" + roomId;
}

function loadPinnedState() {
  try {
    pinnedState = JSON.parse(localStorage.getItem(pinnedStateKey())) || {};
  } catch (e) {
    pinnedState = {};
  }
}

function savePinnedState() {
  try {
    localStorage.setItem(pinnedStateKey(), JSON.stringify(pinnedState));
  } catch (e) {
    // not fatal -- worst case pin order resets next load
  }
}

function isPinned(number) {
  return !!pinnedState[number];
}

function togglePinned(number) {
  if (pinnedState[number]) delete pinnedState[number];
  else pinnedState[number] = true;
  savePinnedState();
  renderConversationList();
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
  el("settings-btn").addEventListener("click", onSettingsClick);
  el("settings-back-btn").addEventListener("click", () => showScreen("conversations"));
  el("disconnect-btn").addEventListener("click", onForgetClick);
  el("sync-log-btn").addEventListener("click", onSyncLogClick);
  el("deleted-thread-back-btn").addEventListener("click", () => showScreen("settings"));
  el("deleted-thread-restore-btn").addEventListener("click", restoreSelectedInThread);
  el("deleted-thread-delete-forever-btn").addEventListener("click", deleteForeverSelectedInThread);
  el("conv-selection-cancel-btn").addEventListener("click", exitConversationSelectionMode);
  el("conv-selection-delete-btn").addEventListener("click", confirmDeleteSelectedConversations);
  el("forward-cancel-btn").addEventListener("click", cancelForward);
  el("back-btn").addEventListener("click", () => {
    if (selectionMode) { exitSelectionMode(); return; }
    currentChatNumber = null;
    showScreen("conversations");
    renderConversationList();
  });
  el("selection-cancel-btn").addEventListener("click", exitSelectionMode);
  el("selection-delete-btn").addEventListener("click", confirmBulkDelete);
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

  el("search-toggle-btn").addEventListener("click", toggleSearch);
  el("conv-search-input").addEventListener("input", (e) => {
    conversationSearchQuery = e.target.value;
    renderConversationList();
  });
  el("new-message-btn").addEventListener("click", onNewMessageClick);
  setupPullToRefresh();
  setupImageViewer();
}

// ---------- full-screen picture viewer ----------

const VIEWER_DOUBLE_TAP_MS = 300;
const VIEWER_DOUBLE_TAP_DIST = 30;
const VIEWER_MIN_SCALE = 1;
const VIEWER_MAX_SCALE = 5;
const VIEWER_DOUBLE_TAP_SCALE = 2.5;

let viewerScale = 1;
let viewerTranslateX = 0;
let viewerTranslateY = 0;
let viewerPinchStartDist = null;
let viewerPinchStartScale = 1;
let viewerPanStart = null;
let viewerGestureMoved = false;
let viewerLastTapAt = 0;
let viewerLastTapX = 0;
let viewerLastTapY = 0;
let viewerPendingSingleTapTimer = null;

function openImageViewer(src) {
  resetViewerTransform();
  el("image-viewer-img").src = src;
  el("image-viewer-overlay").classList.remove("hidden");
}

function closeImageViewer() {
  el("image-viewer-overlay").classList.add("hidden");
  el("image-viewer-img").src = "";
}

function resetViewerTransform() {
  viewerScale = 1;
  viewerTranslateX = 0;
  viewerTranslateY = 0;
  applyViewerTransform();
}

function applyViewerTransform() {
  el("image-viewer-img").style.transform =
      `translate(${viewerTranslateX}px, ${viewerTranslateY}px) scale(${viewerScale})`;
}

function viewerTouchDistance(touches) {
  const dx = touches[0].clientX - touches[1].clientX;
  const dy = touches[0].clientY - touches[1].clientY;
  return Math.hypot(dx, dy);
}

function toggleViewerZoom() {
  if (viewerScale > VIEWER_MIN_SCALE) {
    viewerScale = VIEWER_MIN_SCALE;
    viewerTranslateX = 0;
    viewerTranslateY = 0;
  } else {
    viewerScale = VIEWER_DOUBLE_TAP_SCALE;
  }
  applyViewerTransform();
}

// Handles pinch-to-zoom, single-finger pan while zoomed in, double-tap to
// zoom, and a plain tap to close -- all via raw touch events rather than
// native click/dblclick, since a tap that's actually the first half of a
// double-tap needs to be held briefly (same reasoning, and same
// DOUBLE_TAP_MS window, as the flip phone's double-press-to-zoom).
function setupImageViewer() {
  const overlay = el("image-viewer-overlay");

  overlay.addEventListener("touchstart", (e) => {
    viewerGestureMoved = false;
    if (e.touches.length === 2) {
      if (viewerPendingSingleTapTimer) {
        clearTimeout(viewerPendingSingleTapTimer);
        viewerPendingSingleTapTimer = null;
      }
      viewerPinchStartDist = viewerTouchDistance(e.touches);
      viewerPinchStartScale = viewerScale;
    } else if (e.touches.length === 1 && viewerScale > VIEWER_MIN_SCALE) {
      viewerPanStart = {
        x: e.touches[0].clientX, y: e.touches[0].clientY,
        tx: viewerTranslateX, ty: viewerTranslateY,
      };
    }
  }, { passive: true });

  overlay.addEventListener("touchmove", (e) => {
    if (e.touches.length === 2 && viewerPinchStartDist) {
      viewerGestureMoved = true;
      const dist = viewerTouchDistance(e.touches);
      viewerScale = Math.max(VIEWER_MIN_SCALE, Math.min(VIEWER_MAX_SCALE,
          viewerPinchStartScale * (dist / viewerPinchStartDist)));
      applyViewerTransform();
    } else if (e.touches.length === 1 && viewerPanStart) {
      viewerGestureMoved = true;
      const t = e.touches[0];
      viewerTranslateX = viewerPanStart.tx + (t.clientX - viewerPanStart.x);
      viewerTranslateY = viewerPanStart.ty + (t.clientY - viewerPanStart.y);
      applyViewerTransform();
    }
  }, { passive: true });

  overlay.addEventListener("touchend", (e) => {
    // Stops the browser from also firing a synthetic click/dblclick right
    // after this -- the desktop-mouse fallback below would otherwise race
    // with the touch handling already done here on an actual touchscreen.
    e.preventDefault();
    if (e.touches.length > 0) return; // more fingers still down -- not done yet
    viewerPinchStartDist = null;
    viewerPanStart = null;
    if (viewerGestureMoved) {
      viewerGestureMoved = false;
      return; // was a pinch or pan, not a tap
    }

    const t = e.changedTouches[0];
    const now = Date.now();
    const dx = t.clientX - viewerLastTapX;
    const dy = t.clientY - viewerLastTapY;
    if (viewerPendingSingleTapTimer && now - viewerLastTapAt < VIEWER_DOUBLE_TAP_MS
        && Math.hypot(dx, dy) < VIEWER_DOUBLE_TAP_DIST) {
      clearTimeout(viewerPendingSingleTapTimer);
      viewerPendingSingleTapTimer = null;
      toggleViewerZoom();
      return;
    }
    viewerLastTapAt = now;
    viewerLastTapX = t.clientX;
    viewerLastTapY = t.clientY;
    viewerPendingSingleTapTimer = setTimeout(() => {
      viewerPendingSingleTapTimer = null;
      closeImageViewer();
    }, VIEWER_DOUBLE_TAP_MS);
  });

  // Desktop/mouse fallback (Chrome DevTools, or a laptop trackpad) --
  // double-click zooms, a single click closes. Same held-briefly trick as
  // the touch path above: a real browser fires a plain "click" on the
  // *first* click of a double-click too (its `detail` is always 1 at that
  // point -- only the second click's own event has detail 2), so acting
  // on it immediately would close the viewer before "dblclick" ever gets
  // a chance to fire.
  let pendingMouseCloseTimer = null;
  overlay.addEventListener("click", (e) => {
    if (e.detail !== 1) return;
    if (pendingMouseCloseTimer) clearTimeout(pendingMouseCloseTimer);
    pendingMouseCloseTimer = setTimeout(() => {
      pendingMouseCloseTimer = null;
      closeImageViewer();
    }, VIEWER_DOUBLE_TAP_MS);
  });
  overlay.addEventListener("dblclick", () => {
    if (pendingMouseCloseTimer) {
      clearTimeout(pendingMouseCloseTimer);
      pendingMouseCloseTimer = null;
    }
    toggleViewerZoom();
  });
}

function toggleSearch() {
  const input = el("conv-search-input");
  const showing = !input.classList.contains("hidden");
  if (showing) {
    input.value = "";
    conversationSearchQuery = "";
    input.classList.add("hidden");
    renderConversationList();
  } else {
    input.classList.remove("hidden");
    input.focus();
  }
}

// Starts a fresh conversation with a typed number -- openChat() already
// handles a number with no existing messages fine (an empty thread is
// exactly what a brand-new conversation looks like), so no changes were
// needed there.
async function onNewMessageClick() {
  if (navigator.contacts && navigator.contacts.select) {
    const choice = await showActionSheet("New Message", [
      { label: "⌨️ Type a number", value: "type" },
      { label: "👤 Choose from Contacts", value: "contacts" },
    ]);
    if (choice === "contacts") {
      try {
        const supported = await navigator.contacts.getProperties();
        const props = ["name", "tel"].filter((p) => supported.includes(p));
        const [contact] = await navigator.contacts.select(
          props.length ? props : ["name", "tel"], { multiple: false });
        if (!contact) return;
        const tel = (contact.tel && contact.tel[0]) || "";
        const normalized = normalizeNumber(tel);
        if (!normalized) return;
        openChat(normalized);
      } catch (e) {
        logDebug("Contact picker unavailable/cancelled: " + e);
      }
      return;
    }
    if (choice !== "type") return; // cancelled
  }
  const number = prompt("Phone number?");
  if (!number) return;
  const normalized = normalizeNumber(number);
  if (!normalized) return;
  openChat(normalized);
}

// Pull-to-refresh on the conversation list: re-fetches the room's current
// incoming/sent/scheduled state from Firebase directly (the same one-shot
// GETs connectToRoom() already does on first load), instead of just
// trusting the live EventSource connections. Mostly a manual "force
// resync" fallback and a way to visibly confirm the page is actually
// talking to Firebase, since the streams here already update the list on
// their own in normal operation.
function setupPullToRefresh() {
  const list = el("conversation-list");
  const indicator = el("pull-refresh-indicator");
  let startY = null;
  let pulling = false;

  list.addEventListener("touchstart", (e) => {
    if (list.scrollTop <= 0) startY = e.touches[0].clientY;
  }, { passive: true });

  list.addEventListener("touchmove", (e) => {
    if (startY == null) return;
    const delta = e.touches[0].clientY - startY;
    pulling = delta > 60 && list.scrollTop <= 0;
    indicator.classList.toggle("hidden", !pulling);
  }, { passive: true });

  list.addEventListener("touchend", () => {
    if (pulling) refreshFromFirebase();
    startY = null;
    pulling = false;
    indicator.classList.add("hidden");
  });
}

async function refreshFromFirebase() {
  if (!roomId) return;
  try {
    const [incomingRes, sentRes, scheduledRes] = await Promise.all([
      fetch(roomUrl("messages/incoming")),
      fetch(roomUrl("messages/sent")),
      fetch(roomUrl("messages/scheduled")),
    ]);
    const [incomingSnapshot, sentSnapshot, scheduledSnapshot] =
        await Promise.all([incomingRes.json(), sentRes.json(), scheduledRes.json()]);
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
    renderConversationList();
    if (currentChatNumber) renderChat(currentChatNumber);
  } catch (e) {
    logDebug("Manual refresh failed: " + (e && e.stack ? e.stack : e));
  }
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
  // 60MB, matching the tablet's own cap -- the phone re-encodes video down
  // to a small size once it receives it (VideoTranscoder), so this only
  // needs to protect against picking something absurd, not the actual MMS
  // limit.
  if (file.size > 60 * 1024 * 1024) {
    alert("That file is too large to send (over 60MB).");
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
    loadPinnedState();
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
  if (phoneHeartbeatTimer) clearInterval(phoneHeartbeatTimer);
  phoneHeartbeatTimer = null;
  // Reset the heartbeat baseline too -- otherwise pairing a *different*
  // room right after forgetting this one would see that new room's first
  // heartbeat value differ from the old room's leftover value and wrongly
  // count that as "just changed", the same false-positive this was just
  // fixed to avoid.
  lastHeartbeatValue = null;
  lastHeartbeatSeenAt = 0;
  hasPolledHeartbeatOnce = false;
  try { localStorage.removeItem(heartbeatStateKey()); } catch (e) {}
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
  ["pairing", "conversations", "chat", "settings", "deleted-thread"].forEach((s) => {
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

  startPhoneHeartbeatPoll();
}

// How long the heartbeat value can go unchanged before it's treated as
// stale -- comfortable margin above the phone's own ~30s write interval
// so one slow/dropped beat, or this poll landing right before the phone's
// next write, doesn't flicker the status.
const PHONE_HEARTBEAT_STALE_MS = 120 * 1000;
let phoneHeartbeatTimer = null;
let lastHeartbeatValue = null;
let lastHeartbeatSeenAt = 0;
let hasPolledHeartbeatOnce = false;

/**
 * Polled with a plain fetch() every 30s rather than a fourth EventSource
 * -- this is just a status indicator, not something needing sub-second
 * delivery, and phoneHeartbeat is a single value the phone overwrites in
 * place, not a path full of individually-pushed child items the way
 * messages/incoming etc. are, so it doesn't fit the existing stream
 * handling here anyway.
 *
 * Deliberately never compares the phone's embedded timestamp against this
 * browser's own clock -- confirmed the wrong way to do this: doing that
 * made a genuinely-online phone show as unreachable simply because its
 * clock was off from this device's, which is a real, plausible situation
 * on a phone this old. Instead, this only cares whether the value the
 * phone is writing keeps *changing*, measured entirely against this
 * browser's own clock -- self-consistent, and immune to the phone's clock
 * being wrong in either direction.
 *
 * The very first poll after a page load can't tell whether the value it
 * sees was just written or is hours/days old -- confirmed as a real bug
 * live: a phone with wifi off and no SIM (so genuinely offline, its last
 * real heartbeat over 18 hours stale) still showed "Phone is connected to
 * Firebase" on a fresh page load, because `null !== <anything>` made that
 * first observation look like a change. Only a value seen to *change*
 * between two separate polls proves the phone wrote something while this
 * was actually watching, so the first poll only records a baseline and
 * never counts as evidence of a change by itself.
 */
// A page refresh destroys this whole script's state, unlike the tablet's
// background service, which keeps running (and keeps this same baseline)
// across the app's screen being closed and reopened -- confirmed as the
// reason a tablet reopen "knows right away" while a PWA refresh has to
// re-earn a full "have I seen the value change yet" cycle from scratch.
// Persisting the same three fields the tablet keeps in memory closes that
// gap: a refresh restores exactly where the last tab left off instead of
// resetting the wait every time.
function heartbeatStateKey() {
  return "flip_relay_heartbeat_" + roomId;
}

function loadHeartbeatState() {
  try {
    const raw = localStorage.getItem(heartbeatStateKey());
    if (!raw) return;
    const parsed = JSON.parse(raw);
    lastHeartbeatValue = typeof parsed.lastHeartbeatValue === "number" ? parsed.lastHeartbeatValue : null;
    lastHeartbeatSeenAt = typeof parsed.lastHeartbeatSeenAt === "number" ? parsed.lastHeartbeatSeenAt : 0;
    hasPolledHeartbeatOnce = !!parsed.hasPolledHeartbeatOnce;
  } catch (e) {
    // corrupt/unavailable storage -- just start fresh, same as before this existed
  }
}

function saveHeartbeatState() {
  try {
    localStorage.setItem(heartbeatStateKey(), JSON.stringify({
      lastHeartbeatValue, lastHeartbeatSeenAt, hasPolledHeartbeatOnce,
    }));
  } catch (e) {
    // storage full/unavailable -- not fatal, just means a refresh resets the wait
  }
}

function startPhoneHeartbeatPoll() {
  if (phoneHeartbeatTimer) clearInterval(phoneHeartbeatTimer);
  loadHeartbeatState();
  // Reflect the restored state immediately instead of waiting for the
  // first poll to complete, same reasoning as the tablet reading
  // UpdateBus's last-known status on resume.
  updatePhoneStatus(lastHeartbeatSeenAt > 0 && (Date.now() - lastHeartbeatSeenAt) < PHONE_HEARTBEAT_STALE_MS, null);
  const poll = async () => {
    try {
      const res = await fetch(roomUrl("phoneHeartbeat"));
      const data = res.ok ? await res.json() : null;
      const value = data && typeof data.timestamp === "number" ? data.timestamp : null;
      // -1 (the phone's own sentinel for "couldn't read battery") means
      // the same as no value at all -- don't show a bogus "-1%".
      const batteryPercent = data && typeof data.batteryPercent === "number" && data.batteryPercent >= 0
          ? data.batteryPercent : null;
      const now = Date.now();
      if (value != null) {
        if (hasPolledHeartbeatOnce && value !== lastHeartbeatValue) {
          lastHeartbeatSeenAt = now;
        }
        lastHeartbeatValue = value;
      }
      hasPolledHeartbeatOnce = true;
      saveHeartbeatState();
      const connected = lastHeartbeatSeenAt > 0 && (now - lastHeartbeatSeenAt) < PHONE_HEARTBEAT_STALE_MS;
      updatePhoneStatus(connected, connected ? batteryPercent : null);
    } catch (e) {
      updatePhoneStatus(false, null);
    }
  };
  poll();
  phoneHeartbeatTimer = setInterval(poll, 30000);
}

function updatePhoneStatus(connected, batteryPercent) {
  const phoneStatusEl = el("phone-status-text");
  if (!phoneStatusEl) return;
  phoneStatusEl.textContent = connected ? "Phone is connected to Firebase" : "Phone not reachable right now";
  phoneStatusEl.classList.toggle("connected", connected);
  phoneStatusEl.classList.toggle("disconnected", !connected);
  // Blank (not a stale/misleading number) whenever the phone isn't
  // actually reachable, matching the tablet's own battery indicator.
  const batteryEl = el("battery-text");
  if (batteryEl) {
    batteryEl.textContent = batteryPercent != null ? "🔋" + batteryPercent + "%" : "";
    batteryEl.classList.toggle("low", batteryPercent != null && batteryPercent <= 20);
  }
  updateChatConnectionWarning();
}

// Names specifically which side is down (this browser's own connection to
// Firebase, vs. the phone itself being unreachable) rather than a generic
// "not connected", since they call for different reactions -- a dead phone
// means "wait" no matter what this device does, while a dead Firebase
// connection is this device's own wifi/data to fix.
function updateChatConnectionWarning() {
  const warningEl = el("chat-connection-warning");
  if (!warningEl) return;
  const firebaseConnected = incomingConnected && sentConnected && scheduledConnected;
  const phoneConnected = lastHeartbeatSeenAt > 0 && (Date.now() - lastHeartbeatSeenAt) < PHONE_HEARTBEAT_STALE_MS;
  const text = !firebaseConnected
      ? "Not connected to Firebase — this may take a while to send."
      : !phoneConnected
      ? "Phone not reachable — this may take a while to send."
      : null;
  warningEl.textContent = text || "";
  warningEl.classList.toggle("hidden", !text);
}

// How long a stream may go with zero events (not just data -- Firebase's
// SSE also sends periodic keep-alives) before it's treated as dead and
// force-reconnected. This exists because a plain EventSource can end up
// silently stuck: if the underlying connection dies without a clean
// TCP close -- exactly what happens on a real device after a wifi/cell
// drop-and-reconnect -- the browser never fires another "error" (so
// onConnectedChange(false) never even runs) or "open" event, and just
// sits there forever looking like it's still trying. Writes (sending a
// message, a picture upload) go over their own separate one-shot
// fetch() calls, so they keep working fine the whole time -- which is
// exactly why this can show "Reconnecting..." while pictures still send.
// This is the same class of bug already fixed on the Android side (see
// the phone/tablet apps' stream client and its finite read timeout);
// EventSource has no equivalent built-in protection, so it's handled here.
const STREAM_STALE_MS = 60 * 1000;

function openStream(path, upsertFn, deleteFn, onConnectedChange, onSingleItemUpserted) {
  let es = null;
  let lastEventAt = Date.now();
  const bump = () => { lastEventAt = Date.now(); };

  function connect() {
    es = new EventSource(roomUrl(path));

    es.addEventListener("open", () => { bump(); onConnectedChange(true); });
    es.addEventListener("error", () => onConnectedChange(false));
    // Catches any keep-alive/unnamed event too, so idle-but-healthy rooms
    // don't get mistaken for dead ones.
    es.addEventListener("message", bump);

    const handle = (event) => {
      bump();
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
  }

  connect();

  const watchdog = setInterval(() => {
    if (Date.now() - lastEventAt > STREAM_STALE_MS) {
      es.close();
      onConnectedChange(false);
      connect();
    }
  }, 15000);

  return { close: () => { clearInterval(watchdog); es.close(); } };
}

function updateConnectionStatus() {
  // Only ever reflects this browser's own connection to Firebase -- see
  // updatePhoneStatus() for whether the phone itself is actually online,
  // which is a separate thing this never used to distinguish.
  const connected = incomingConnected && sentConnected && scheduledConnected;
  const dot = el("conv-status-dot");
  if (dot) dot.classList.toggle("connected", connected);
  const statusText = el("conv-status-text");
  if (statusText) statusText.textContent = connected ? "You're connected to Firebase" : "Reconnecting to Firebase...";
  updateChatConnectionWarning();
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
      if (file.size > 60 * 1024 * 1024) throw new Error("Attachment too large");
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

// Removes a message that's still showing "Sending..." (a local-only echo
// with no confirmed Firebase record yet) -- lets it be dismissed if it's
// stuck with no connection to actually send it. Only ever removes the
// local echo; if the send does eventually go through anyway, the real
// "sent" record just shows up as a new message.
function deletePending(messageId) {
  messages = messages.filter((m) => !(m.id === messageId && m.id.startsWith("local-")));
  saveCache();
  renderConversationList();
  if (currentChatNumber) renderChat(currentChatNumber);
}

// Long-press (or press-and-hold with a mouse) on a message bubble opens an
// action sheet -- Copy and Forward always, Delete only for a message
// that's still stuck "Sending...". Implemented on raw touch/mouse events
// rather than the native "contextmenu"/long-press-to-select behavior,
// which fights with this on a touchscreen and doesn't exist for touch at
// all in older browsers.
const LONG_PRESS_MS = 500;
function attachLongPress(el, onLongPress) {
  let timer = null;
  let firedOrCancelled = false;
  const start = () => {
    firedOrCancelled = false;
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (!firedOrCancelled) {
        firedOrCancelled = true;
        onLongPress();
      }
    }, LONG_PRESS_MS);
  };
  const cancel = () => {
    firedOrCancelled = true;
    clearTimeout(timer);
  };
  el.addEventListener("touchstart", start, { passive: true });
  el.addEventListener("touchmove", cancel, { passive: true });
  el.addEventListener("touchend", cancel);
  el.addEventListener("touchcancel", cancel);
  el.addEventListener("mousedown", start);
  el.addEventListener("mousemove", cancel);
  el.addEventListener("mouseup", cancel);
  el.addEventListener("mouseleave", cancel);
  // Suppresses the browser's own long-press context menu / text-selection
  // callout so it doesn't pop up alongside the action sheet.
  el.addEventListener("contextmenu", (e) => e.preventDefault());
}

async function onMessageLongPress(m) {
  if (selectionMode) {
    toggleSelection(m.id);
    return;
  }
  const options = [
    { label: "📋 Copy", value: "copy" },
    { label: "↪️ Forward", value: "forward" },
    { label: "ℹ️ Message info", value: "info" },
    { label: "☑️ Select", value: "select" },
  ];
  const isPending = m.direction === "out" && m.id.startsWith("local-");
  if (isPending) options.push({ label: "🗑️ Delete", value: "delete" });

  const choice = await showActionSheet("Message", options);
  if (choice === "copy") {
    try {
      await navigator.clipboard.writeText(m.body || "");
    } catch (e) {
      logDebug("Copy failed: " + (e && e.stack ? e.stack : e));
    }
  } else if (choice === "forward") {
    startForward(m.body);
  } else if (choice === "info") {
    showMessageInfo(m);
  } else if (choice === "select") {
    enterSelectionMode(m.id);
  } else if (choice === "delete") {
    if (confirm("Delete this message? It hasn't gone through yet.")) deletePending(m.id);
  }
}

function showMessageInfo(m) {
  const isPending = m.direction === "out" && m.id.startsWith("local-");
  const status = m.direction === "out" ? (isPending ? "Sending..." : "Sent") : "Received";
  const lines = [
    "Status: " + status,
    "Time: " + new Date(m.timestamp).toLocaleString(),
    "Number: " + m.number,
  ];
  alert(lines.join("\n"));
}

// ---------- forward ----------

// Matches Google Messages: forwarding takes you to the conversation list
// to pick (or search for, or start) a target instead of a plain number
// prompt -- openChat() picks the pending body back up once a target is
// actually chosen, however that happens (tap an existing conversation,
// search then tap, or New Message).
let forwardingBody = null;

function startForward(body) {
  forwardingBody = body || "";
  currentChatNumber = null;
  showScreen("conversations");
  renderConversationList();
  el("forward-banner").classList.remove("hidden");
}

function cancelForward() {
  forwardingBody = null;
  el("forward-banner").classList.add("hidden");
}

// ---------- multi-select ----------

let selectionMode = false;
let selectedMessageIds = new Set();

function enterSelectionMode(initialId) {
  selectionMode = true;
  selectedMessageIds = new Set([initialId]);
  renderChat(currentChatNumber);
}

function exitSelectionMode() {
  selectionMode = false;
  selectedMessageIds.clear();
  renderChat(currentChatNumber);
}

function toggleSelection(id) {
  if (selectedMessageIds.has(id)) selectedMessageIds.delete(id);
  else selectedMessageIds.add(id);
  if (selectedMessageIds.size === 0) {
    exitSelectionMode();
    return;
  }
  renderChat(currentChatNumber);
}

function updateSelectionToolbar() {
  const toolbar = el("selection-toolbar");
  toolbar.classList.toggle("hidden", !selectionMode);
  if (selectionMode) {
    const n = selectedMessageIds.size;
    el("selection-count").textContent = n + " selected";
  }
}

async function confirmBulkDelete() {
  const n = selectedMessageIds.size;
  if (n === 0) return;
  if (!confirm(`Delete ${n} message${n === 1 ? "" : "s"}? This can be restored later from Settings within 30 days.`)) return;
  const ids = Array.from(selectedMessageIds);
  exitSelectionMode();
  for (const id of ids) await softDeleteMessage(id);
}

// Moves a real (already-confirmed) message into deletedMessages/ with a
// timestamp instead of deleting it outright, so Settings > Recently
// Deleted can restore it for 30 days -- and since this happens in
// Firebase, every device sees the same delete/restore, not just this one.
// A still-"Sending..." local-only message never made it to Firebase in
// the first place, so there's nothing to preserve -- just drop it.
async function softDeleteMessage(id) {
  const m = messages.find((x) => x.id === id);
  if (!m) return;
  if (id.startsWith("local-")) {
    deletePending(id);
    return;
  }
  const path = m.direction === "in" ? "incoming" : "sent";
  try {
    const res = await fetch(roomUrl(`messages/${path}/${id}`));
    const data = res.ok ? await res.json() : null;
    if (data) {
      await fetch(roomUrl(`deletedMessages/${path}/${id}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ...data, deletedAt: Date.now() }),
      });
    }
    await fetch(roomUrl(`messages/${path}/${id}`), { method: "DELETE" });
  } catch (e) {
    logDebug("Delete failed: " + (e && e.stack ? e.stack : e));
  }
  messages = messages.filter((x) => x.id !== id);
  saveCache();
  renderConversationList();
  if (currentChatNumber) renderChat(currentChatNumber);
}

// ---------- settings / recently deleted ----------

const DELETED_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

function onSettingsClick() {
  showScreen("settings");
  loadDeletedMessages();
}

/** The phone's recent HistoricalSyncer.syncNow() history -- see the phone's own SyncLog.java. Read-only, so any pick just closes it. */
async function onSyncLogClick() {
  let entries = [];
  try {
    const res = await fetch(roomUrl("syncLog"));
    const data = res.ok ? await res.json() : null;
    if (Array.isArray(data)) entries = data;
  } catch (e) {
    logDebug("Loading sync log failed: " + (e && e.stack ? e.stack : e));
  }
  if (entries.length === 0) {
    await showActionSheet("Sync Log", [{ label: "No syncs yet", value: "close" }]);
    return;
  }
  const options = entries.map((e) => {
    const type = e.type === "pictures" ? "Pictures" : "Messages";
    const when = e.at ? new Date(e.at).toLocaleString(undefined, {
      month: "short", day: "numeric", year: "numeric", hour: "numeric", minute: "2-digit",
    }) : "unknown time";
    return { label: `${type} (${e.manual ? "manual" : "auto"}) — ${when}`, value: "close" };
  });
  await showActionSheet("Sync Log", options);
}

// number -> array of {path, key, data, deletedAt}, refreshed by every
// loadDeletedMessages() call and read by the drill-down thread screen.
let deletedGroups = new Map();
let deletedThreadNumber = null;
let deletedThreadSelected = new Set(); // holds "path|key" strings

async function loadDeletedMessages() {
  const items = [];
  for (const path of ["incoming", "sent"]) {
    try {
      const res = await fetch(roomUrl(`deletedMessages/${path}`));
      const snapshot = res.ok ? await res.json() : null;
      if (!snapshot || typeof snapshot !== "object") continue;
      const now = Date.now();
      for (const key of Object.keys(snapshot)) {
        const data = snapshot[key];
        const deletedAt = data.deletedAt || 0;
        if (now - deletedAt > DELETED_RETENTION_MS) {
          // Past 30 days -- prune lazily instead of needing a scheduled
          // job anywhere; this is the only place that ever reads this data.
          fetch(roomUrl(`deletedMessages/${path}/${key}`), { method: "DELETE" }).catch(() => {});
          continue;
        }
        items.push({ path, key, data, deletedAt });
      }
    } catch (e) {
      logDebug("Loading deleted messages failed: " + (e && e.stack ? e.stack : e));
    }
  }

  deletedGroups = new Map();
  for (const item of items) {
    const number = normalizeNumber(item.path === "incoming" ? item.data.sender : item.data.to);
    if (!deletedGroups.has(number)) deletedGroups.set(number, []);
    deletedGroups.get(number).push(item);
  }
  renderDeletedGroupsList();
}

// Settings shows one collapsed row per conversation with deleted
// messages -- like a list of folders -- rather than every message mixed
// together. Tap opens that conversation's deleted messages to select
// which ones to restore; long-press restores all of them in one step
// without needing to open anything, same pattern as everywhere else in
// this app that has both a quick whole-thing action and a "look inside
// and pick" one.
function renderDeletedGroupsList() {
  const list = el("deleted-list");
  list.innerHTML = "";
  el("deleted-empty-state").classList.toggle("hidden", deletedGroups.size > 0);

  const sortedNumbers = [...deletedGroups.keys()].sort((a, b) => {
    const aLatest = Math.max(...deletedGroups.get(a).map((i) => i.deletedAt));
    const bLatest = Math.max(...deletedGroups.get(b).map((i) => i.deletedAt));
    return bLatest - aLatest;
  });

  for (const number of sortedNumbers) {
    const groupItems = deletedGroups.get(number);
    const row = document.createElement("div");
    row.className = "deleted-group-row";
    row.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(displayName(number) || number)}</div>
        <div class="preview">${groupItems.length} deleted</div>
      </div>
    `;
    row.addEventListener("click", () => openDeletedThread(number));
    attachLongPress(row, () => showDeletedGroupMenu(number));
    list.appendChild(row);
  }
}

async function showDeletedGroupMenu(number) {
  const choice = await showActionSheet(displayName(number) || number, [
    { label: "↩️ Restore All", value: "restore" },
    { label: "🗑️ Delete Forever", value: "delete" },
  ]);
  if (choice === "restore") confirmRestoreAllForNumber(number);
  else if (choice === "delete") confirmDeleteForeverAllForNumber(number);
}

async function confirmRestoreAllForNumber(number) {
  const groupItems = deletedGroups.get(number) || [];
  if (groupItems.length === 0) return;
  const label = displayName(number) || number;
  if (!confirm(`Restore all ${groupItems.length} deleted message(s) from ${label}?`)) return;
  for (const item of groupItems) await restoreDeletedMessage(item, false);
  loadDeletedMessages();
}

async function confirmDeleteForeverAllForNumber(number) {
  const groupItems = deletedGroups.get(number) || [];
  if (groupItems.length === 0) return;
  const label = displayName(number) || number;
  if (!confirm(`Permanently delete all ${groupItems.length} message(s) from ${label}? This can't be undone.`)) return;
  for (const item of groupItems) await permanentlyDeleteMessage(item, false);
  loadDeletedMessages();
}

function openDeletedThread(number) {
  deletedThreadNumber = number;
  deletedThreadSelected = new Set();
  el("deleted-thread-title").textContent = displayName(number) || number;
  showScreen("deleted-thread");
  renderDeletedThread();
}

function renderDeletedThread() {
  const list = el("deleted-thread-list");
  list.innerHTML = "";
  const items = (deletedGroups.get(deletedThreadNumber) || []).slice().sort((a, b) => b.deletedAt - a.deletedAt);

  for (const item of items) {
    const id = item.path + "|" + item.key;
    const preview = item.data.imageUrl ? "📷 Picture" + (item.data.body ? ": " + item.data.body : "") : (item.data.body || "");
    const row = document.createElement("div");
    row.className = "deleted-item";
    row.innerHTML = `
      <div class="select-circle${deletedThreadSelected.has(id) ? " checked" : ""}"></div>
      <div class="info"><div class="preview">${escapeHtml(preview)}</div></div>
    `;
    row.addEventListener("click", () => toggleDeletedThreadSelection(id));
    list.appendChild(row);
  }
  updateDeletedThreadToolbar();
}

function toggleDeletedThreadSelection(id) {
  if (deletedThreadSelected.has(id)) deletedThreadSelected.delete(id);
  else deletedThreadSelected.add(id);
  renderDeletedThread();
}

function updateDeletedThreadToolbar() {
  el("deleted-thread-count").textContent = deletedThreadSelected.size + " selected";
}

async function restoreSelectedInThread() {
  const items = (deletedGroups.get(deletedThreadNumber) || [])
      .filter((item) => deletedThreadSelected.has(item.path + "|" + item.key));
  if (items.length === 0) return;
  for (const item of items) await restoreDeletedMessage(item, false);
  await loadDeletedMessages();
  showScreen("settings");
}

async function deleteForeverSelectedInThread() {
  const items = (deletedGroups.get(deletedThreadNumber) || [])
      .filter((item) => deletedThreadSelected.has(item.path + "|" + item.key));
  if (items.length === 0) return;
  const n = items.length;
  if (!confirm(`Permanently delete ${n} message${n === 1 ? "" : "s"}? This can't be undone.`)) return;
  for (const item of items) await permanentlyDeleteMessage(item, false);
  await loadDeletedMessages();
  showScreen("settings");
}

/** Skips the normal 30-day wait and removes a trashed message outright -- same as the lazy auto-purge in loadDeletedMessages(), just on demand. */
async function permanentlyDeleteMessage(item, reload = true) {
  const { path, key } = item;
  try {
    await fetch(roomUrl(`deletedMessages/${path}/${key}`), { method: "DELETE" });
  } catch (e) {
    logDebug("Permanent delete failed: " + (e && e.stack ? e.stack : e));
    return;
  }
  if (reload) loadDeletedMessages();
}

async function restoreDeletedMessage(item, reload = true) {
  const { path, key, data } = item;
  const restored = { ...data };
  delete restored.deletedAt;
  try {
    await fetch(roomUrl(`messages/${path}/${key}`), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(restored),
    });
    await fetch(roomUrl(`deletedMessages/${path}/${key}`), { method: "DELETE" });
  } catch (e) {
    logDebug("Restore failed: " + (e && e.stack ? e.stack : e));
    return;
  }
  // The live stream's own "put" event also picks this back up on every
  // connected device, this just reflects it here immediately too.
  if (path === "incoming") upsertIncoming(key, restored); else upsertSent(key, restored);
  saveCache();
  renderConversationList();
  if (reload) loadDeletedMessages();
}

// Tapping a scheduled message's bubble is the only way to cancel it --
// there was previously no way to at all.
function cancelScheduled(messageId) {
  if (!confirm("Cancel this scheduled message? It won't be sent.")) return;
  fetch(roomUrl("messages/scheduled/" + messageId), { method: "DELETE" })
      .catch((e) => logDebug("Cancel scheduled failed: " + (e && e.stack ? e.stack : e)));
  messages = messages.filter((m) => !(m.direction === "scheduled" && m.id === messageId));
  seenScheduledKeys.delete(messageId);
  saveCache();
  renderConversationList();
  if (currentChatNumber) renderChat(currentChatNumber);
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
    .map((c) => ({ ...c, unread: isUnread(c), pinned: isPinned(c.number) }))
    // Pinned first (matching the tablet app), chronological within each
    // group -- an unread conversation used to jump to the top on its own,
    // but that's a change of mind from before: it should stay in the order
    // its last message actually arrived, same as every normal texting app.
    // isUnread() above still marks it (bold name + dot in the rendered
    // list), just no longer as a sort key by itself.
    .sort((a, b) => (b.pinned - a.pinned) || (b.last.timestamp - a.last.timestamp));
}

function displayName(number) {
  const withName = messages.find((m) => m.number === number && m.contactName);
  return (withName && withName.contactName) || number;
}

let conversationSearchQuery = "";

// ---------- conversation multi-select (mirrors the tablet app's Select) ----------

let conversationSelectionMode = false;
let selectedConversationNumbers = new Set();

function enterConversationSelectionMode(initialNumber) {
  conversationSelectionMode = true;
  selectedConversationNumbers = new Set([initialNumber]);
  renderConversationList();
}

function exitConversationSelectionMode() {
  conversationSelectionMode = false;
  selectedConversationNumbers.clear();
  renderConversationList();
}

function toggleConversationSelection(number) {
  if (selectedConversationNumbers.has(number)) selectedConversationNumbers.delete(number);
  else selectedConversationNumbers.add(number);
  if (selectedConversationNumbers.size === 0) {
    exitConversationSelectionMode();
    return;
  }
  renderConversationList();
}

function updateConversationSelectionToolbar() {
  const toolbar = el("conv-selection-toolbar");
  toolbar.classList.toggle("hidden", !conversationSelectionMode);
  el("conv-toolbar").classList.toggle("hidden", conversationSelectionMode);
  if (conversationSelectionMode) {
    el("conv-selection-count").textContent = selectedConversationNumbers.size + " selected";
  }
}

async function confirmDeleteSelectedConversations() {
  const numbers = Array.from(selectedConversationNumbers);
  const n = numbers.length;
  if (n === 0) return;
  if (!confirm(`Delete ${n} conversation${n === 1 ? "" : "s"}? Messages can be restored later from Settings within 30 days.`)) return;
  exitConversationSelectionMode();
  for (const number of numbers) await softDeleteConversation(number);
}

/** Soft-deletes every message in a conversation, one at a time, via the same trash mechanism as deleting an individual message. */
async function softDeleteConversation(number) {
  const ids = messages.filter((m) => m.number === number && m.direction !== "scheduled").map((m) => m.id);
  for (const id of ids) await softDeleteMessage(id);
}

async function showConversationLongPressMenu(number) {
  if (conversationSelectionMode) {
    toggleConversationSelection(number);
    return;
  }
  const pinned = isPinned(number);
  const choice = await showActionSheet(displayName(number) || number, [
    { label: pinned ? "📌 Unpin" : "📌 Pin to top", value: "pin" },
    { label: "☑️ Select", value: "select" },
    { label: "🚫 Block/Unblock", value: "block" },
  ]);
  if (choice === "pin") togglePinned(number);
  else if (choice === "select") enterConversationSelectionMode(number);
  else if (choice === "block") toggleBlocked(number);
}

/**
 * The tablet/PWA have no local blocked-numbers list of their own (unlike
 * the phone, which also has Android's BlockedNumberContract) -- reads and
 * writes rooms/{roomId}/blockedNumbers/{number} directly, which the phone
 * polls (BlockList.java) to also block incoming texts from a number
 * blocked here.
 */
async function toggleBlocked(number) {
  try {
    const res = await fetch(roomUrl(`blockedNumbers/${number}`));
    const existing = res.ok ? await res.json() : null;
    const currentlyBlocked = existing !== null && existing !== undefined;
    if (currentlyBlocked) {
      await fetch(roomUrl(`blockedNumbers/${number}`), { method: "DELETE" });
    } else {
      await fetch(roomUrl(`blockedNumbers/${number}`), {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: "true",
      });
    }
    alert(currentlyBlocked ? "Unblocked" : "Blocked");
  } catch (e) {
    logDebug("Toggle blocked failed: " + (e && e.stack ? e.stack : e));
  }
}

function renderConversationList() {
  const list = el("conversation-list");
  let convos = conversationsByNumber();
  const q = conversationSearchQuery.trim().toLowerCase();
  if (q) {
    convos = convos.filter(({ number }) => {
      const name = (displayName(number) || "").toLowerCase();
      return name.includes(q) || number.includes(q);
    });
  }
  list.innerHTML = "";
  el("empty-state").classList.toggle("hidden", convos.length > 0);
  updateConversationSelectionToolbar();

  for (const { number, last, unread, pinned } of convos) {
    const item = document.createElement("div");
    const selected = conversationSelectionMode && selectedConversationNumbers.has(number);
    item.className = "conversation-item" + (unread ? " unread" : "") + (selected ? " selected" : "");
    const prefix = last.direction === "out" ? "You: " : last.direction === "scheduled" ? "Scheduled: " : "";
    const preview = last.imageUrl ? "📷 Picture" + (last.body ? ": " + last.body : "") : last.body;
    const checkHtml = conversationSelectionMode
        ? `<div class="select-circle${selected ? " checked" : ""}"></div>` : "";
    const pinHtml = pinned ? '<span class="pin-mark">📌</span>' : "";
    item.innerHTML = `
      ${checkHtml}
      <div class="conversation-item-body">
        <div class="name">${pinHtml}${unread ? '<span class="unread-dot">●</span>' : ""}${escapeHtml(displayName(number))}</div>
        <div class="preview">${prefix}${escapeHtml(preview)}</div>
      </div>
      <div class="time">${formatTime(last.timestamp)}</div>
    `;
    item.addEventListener("click", () => {
      if (conversationSelectionMode) toggleConversationSelection(number);
      else openChat(number);
    });
    attachLongPress(item, () => showConversationLongPressMenu(number));
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
  updateChatConnectionWarning();
  // A forward in progress: this is the chosen target, so drop the pending
  // body into the composer for review instead of sending it automatically.
  if (forwardingBody !== null) {
    el("compose-input").value = forwardingBody;
    el("compose-input").focus();
    forwardingBody = null;
    el("forward-banner").classList.add("hidden");
  }
}

function renderChat(number) {
  const list = el("message-list");
  list.innerHTML = "";
  updateSelectionToolbar();
  const thread = messages
    .filter((m) => m.number === number)
    .sort((a, b) => a.timestamp - b.timestamp);

  for (const m of thread) {
    const row = document.createElement("div");
    const isScheduled = m.direction === "scheduled";
    const isOut = m.direction === "out";
    row.className = "bubble-row " + (isScheduled ? "out" : m.direction);
    // A "local-" id is this browser's own optimistic echo, shown the
    // instant Send was clicked, before the phone has confirmed anything --
    // upsertSent() replaces it with the real Firebase record (a normal
    // push-key id) once the phone actually reports the send. Matches
    // asking "did this actually reach the phone, or are we still in
    // limbo" at a glance.
    const deliveryStatus = isOut && !isScheduled
        ? (m.id.startsWith("local-") ? " · Sending..." : " · ✓ Sent")
        : "";
    const meta = isScheduled
        ? "⏰ Scheduled for " + formatTime(m.sendAt)
        : formatTime(m.timestamp) + deliveryStatus;
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
    // The circle only appears in selection mode, and never on a scheduled
    // message -- those aren't part of the conversation history to bulk
    // manage the same way, they already have their own tap-to-cancel.
    const showCircle = selectionMode && !isScheduled;
    const circleHtml = showCircle
        ? `<div class="select-circle${selectedMessageIds.has(m.id) ? " checked" : ""}"></div>`
        : "";
    row.innerHTML = `${circleHtml}<div class="bubble${isScheduled ? " scheduled" : ""}">${imageHtml}${attachmentHtml}${bodyHtml}<span class="meta">${meta}</span></div>`;
    if (showCircle) {
      const messageId = m.id;
      row.addEventListener("click", () => toggleSelection(messageId));
    } else if (isScheduled) {
      const messageId = m.id;
      row.querySelector(".bubble").addEventListener("click", () => cancelScheduled(messageId));
    } else {
      attachLongPress(row.querySelector(".bubble"), () => onMessageLongPress(m));
    }
    if (m.imageUrl) {
      const imageUrl = m.imageUrl;
      const messageId = m.id;
      // stopPropagation so tapping the picture itself doesn't also trigger
      // the bubble-level cancel/delete/select handler above.
      row.querySelector(".bubble-image").addEventListener("click", (e) => {
        e.stopPropagation();
        if (selectionMode) toggleSelection(messageId); else openImageViewer(imageUrl);
      });
    }
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
