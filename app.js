// Filled in at CI build time from the FIREBASE_DATABASE_URL /
// FIREBASE_DATABASE_SECRET GitHub Actions secrets -- these placeholders are
// what actually lives in source control (see .github/workflows/build.yml).
// The database address and key are NOT in this file: the build encrypts them with the site passphrase (ENC_CONFIG) and the
// browser decrypts them after the passphrase is typed once (then remembered on that device only).
let DATABASE_URL = "";
let DATABASE_SECRET = "";
const ENC_CONFIG = "2YmSDLhRBA1x589Q8lnACA==.NUiPh6y71TLSQqp3.7Z+jDTKcuTRNDIQjDkCGarv5S5zCEOQTGWvQTDih5qkyZlbJNsUP+6LeInfeipyQXuedUeQfKny1YDR4lhIs1R4vEtz+yF1KhkYkMRK9fe650IDUq70x07dblHVEjzbvwEi3IPuQQcJNawStLpYrhPB8+4if+pK5bI1pVP4=";
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
let phoneUnread = null; // number -> unread texts as reported by the phone (null until it reports)
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
  if (n.startsWith("g:") || n.startsWith("m:")) return n; // a group (g:) or mass-text (m:) conversation key
  const digits = n.replace(/[^\d]/g, "");
  if (digits.length === 11 && digits.startsWith("1")) {
    return digits.slice(1);
  }
  return digits;
}

// ---------- groups and mass texts ----------
// g:n1,n2,n3 = a group (one shared MMS thread); m:n1,n2,n3 = a mass text ("Just me": each person gets it separately, replies come back
// one by one). Numbers are 10-digit and sorted, exactly as on the tablet.
function isMulti(key) {
  return typeof key === "string" && (key.startsWith("g:") || key.startsWith("m:"));
}

function multiKey(prefix, numbers) {
  const parts = [...new Set(numbers.map(normalizeNumber).filter(Boolean))].sort();
  return prefix + parts.join(",");
}

// A message the phone sent to several people is reported as one address like "n1,n2,n3": that is the group's key.
function groupKeyFromAddress(to) {
  if (!to) return "";
  if (isMulti(to)) return to;
  if (/[,;|]/.test(to)) {
    const parts = [...new Set(to.split(/[,;|]/).map(normalizeNumber).filter(Boolean))].sort();
    if (parts.length >= 2) return "g:" + parts.join(",");
  }
  return normalizeNumber(to);
}

// "gm:<sender>;<n1,n2,...>" = a reply on a group MMS (everyone on it, you included): the group whose members are all of them but you.
function matchGroup(list) {
  const p = new Set(list.split(",").map(normalizeNumber).filter(Boolean));
  const seen = new Set();
  for (const m of messages) {
    if (!m.number || !m.number.startsWith("g:") || seen.has(m.number)) continue;
    seen.add(m.number);
    const g = m.number.slice(2).split(",").filter(Boolean);
    if (g.every((n) => p.has(n)) && p.size - g.length === 1) return m.number;
  }
  return null;
}

let groupNames = {};
function groupNamesKey() { return "flip_relay_web_groupnames_" + roomId; }
function loadGroupNames() {
  try { groupNames = JSON.parse(localStorage.getItem(groupNamesKey()) || "{}"); } catch (e) { groupNames = {}; }
  fetch(roomUrl("groupNames")).then((r) => (r.ok ? r.json() : null)).then((d) => {
    if (d && typeof d === "object") {
      groupNames = d;
      try { localStorage.setItem(groupNamesKey(), JSON.stringify(d)); } catch (e) { /* storage blocked */ }
      renderConversationList();
      if (currentChatNumber && isMulti(currentChatNumber)) el("chat-title").textContent = displayName(currentChatNumber);
    }
  }).catch(() => {});
}
function setGroupName(key, name) {
  if (name) groupNames[key] = name; else delete groupNames[key];
  try { localStorage.setItem(groupNamesKey(), JSON.stringify(groupNames)); } catch (e) { /* storage blocked */ }
  // the phone has ONE conversation for a group and a mass text with the same people: write the name for both kinds
  const members = key.slice(2);
  for (const k of ["g:" + members, "m:" + members]) {
    fetch(roomUrl("groupNames/" + encodeURIComponent(k)), { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(name || null) }).catch(() => {});
  }
}
function renameGroup(key) {
  const n = prompt("Name this group:", groupNames[key] || "");
  if (n === null) return;
  setGroupName(key, n.trim());
  el("chat-title").textContent = displayName(key);
  renderConversationList();
}

// Mass-text bookkeeping: the phone reports one sent message per person; they all belong to the ONE conversation the message was written in.
const massRecent = []; // { key, body, at }
function memberOfKey(key, number) { return key.slice(2).split(",").includes(number); }
// 1 = confirmed our pending message there, 2 = another copy of one already confirmed (ignored), 0 = not a mass text
function foldIntoMassText(to, body, ts) {
  const now = Date.now();
  for (let i = massRecent.length - 1; i >= 0; i--) if (now - massRecent[i].at > 180000) massRecent.splice(i, 1);
  const e = messages.find((m) => m.direction === "out" && m.number && m.number.startsWith("m:") && m.id.startsWith("local-") &&
    memberOfKey(m.number, to) && (m.body || "") === (body || "") && Math.abs(m.timestamp - ts) < 120000);
  if (e) {
    massRecent.push({ key: e.number, body, at: now });
    e.id = "mass-" + e.timestamp + "-" + Math.random().toString(36).slice(2, 8);
    e.source = "web";
    return 1;
  }
  if (massRecent.some((r) => memberOfKey(r.key, to) && (r.body || "") === (body || ""))) return 2;
  return 0;
}

// "Show where messages were sent from": a small phone / computer icon by each sent message.
const SHOW_SOURCE_KEY = "flip_relay_web_show_source";
function showSourceOn() { try { return localStorage.getItem(SHOW_SOURCE_KEY) === "1"; } catch (e) { return false; } }

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
  if (phoneUnread) {
    // The phone's own read state wins: read on the phone => read here. Opening the chat here also counts as read.
    return (phoneUnread[convo.number] || 0) > 0 && convo.last.timestamp > (readState[convo.number] || 0);
  }
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
  if (number && archivedStay.has(number) && archived.has(number)) return; // archived to stay archived: no notification
  if (groupsHidden() && String(data.sender || "").startsWith("gm:")) return; // group texts hidden here
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

function addGmHeader() {
  const bar = document.querySelector("#screen-conversations .topbar");
  if (!bar || document.getElementById("gm-search-btn")) return;
  const mk = (id, title, path, handler) => {
    const b = document.createElement("button");
    b.id = id;
    b.className = "gm-head-btn gm-only";
    b.title = title;
    b.innerHTML = '<svg viewBox="0 0 24 24"><path d="' + path + '"/></svg>';
    b.addEventListener("click", handler);
    return b;
  };
  bar.appendChild(mk("gm-groups-btn", "Group texts", "M16,11c1.66,0 2.99,-1.34 2.99,-3S17.66,5 16,5c-1.66,0 -3,1.34 -3,3s1.34,3 3,3zM8,11c1.66,0 2.99,-1.34 2.99,-3S9.66,5 8,5C6.34,5 5,6.34 5,8s1.34,3 3,3zM8,13c-2.33,0 -7,1.17 -7,3.5V19h14v-2.5c0,-2.33 -4.67,-3.5 -7,-3.5zM16,13c-0.29,0 -0.62,0.02 -0.97,0.05 1.16,0.84 1.97,1.97 1.97,3.45V19h6v-2.5c0,-2.33 -4.67,-3.5 -7,-3.5z", () => el("groups-btn").click()));
  bar.appendChild(mk("gm-calls-btn", "Calls", "M6.62,10.79c1.44,2.83 3.76,5.14 6.59,6.59l2.2,-2.2c0.27,-0.27 0.67,-0.36 1.02,-0.24 1.12,0.37 2.33,0.57 3.57,0.57 0.55,0 1,0.45 1,1V20c0,0.55 -0.45,1 -1,1 -9.39,0 -17,-7.61 -17,-17 0,-0.55 0.45,-1 1,-1h3.5c0.55,0 1,0.45 1,1 0,1.25 0.2,2.45 0.57,3.57 0.11,0.35 0.03,0.74 -0.25,1.02l-2.2,2.2z", () => el("calls-btn").click()));
  bar.appendChild(mk("gm-search-btn", "Search", "M15.5,14h-0.79l-0.28,-0.27C15.41,12.59 16,11.11 16,9.5 16,5.91 13.09,3 9.5,3S3,5.91 3,9.5 5.91,16 9.5,16c1.61,0 3.09,-0.59 4.23,-1.57l0.27,0.28v0.79l5,4.99L20.49,19l-4.99,-5zM9.5,14C7.01,14 5,11.99 5,9.5S7.01,5 9.5,5 14,7.01 14,9.5 11.99,14 9.5,14z", () => el("search-toggle-btn").click()));
  bar.appendChild(mk("gm-settings-btn", "Settings", "M19.14,12.94c0.04,-0.3 0.06,-0.61 0.06,-0.94 0,-0.32 -0.02,-0.64 -0.07,-0.94l2.03,-1.58c0.18,-0.14 0.23,-0.41 0.12,-0.61l-1.92,-3.32c-0.12,-0.22 -0.37,-0.29 -0.59,-0.22l-2.39,0.96c-0.5,-0.38 -1.03,-0.7 -1.62,-0.94L14.4,2.81c-0.04,-0.24 -0.24,-0.41 -0.48,-0.41h-3.84c-0.24,0 -0.43,0.17 -0.47,0.41L9.25,5.35C8.66,5.59 8.12,5.92 7.63,6.29L5.24,5.33c-0.22,-0.08 -0.47,0 -0.59,0.22L2.74,8.87C2.62,9.08 2.66,9.34 2.86,9.48l2.03,1.58C4.84,11.36 4.8,11.69 4.8,12s0.02,0.64 0.07,0.94l-2.03,1.58c-0.18,0.14 -0.23,0.41 -0.12,0.61l1.92,3.32c0.12,0.22 0.37,0.29 0.59,0.22l2.39,-0.96c0.5,0.38 1.03,0.7 1.62,0.94l0.36,2.54c0.05,0.24 0.24,0.41 0.48,0.41h3.84c0.24,0 0.44,-0.17 0.47,-0.41l0.36,-2.54c0.59,-0.24 1.13,-0.56 1.62,-0.94l2.39,0.96c0.22,0.08 0.47,0 0.59,-0.22l1.92,-3.32c0.12,-0.22 0.07,-0.47 -0.12,-0.61L19.14,12.94zM12,15.6c-1.98,0 -3.6,-1.62 -3.6,-3.6s1.62,-3.6 3.6,-3.6 3.6,1.62 3.6,3.6S13.98,15.6 12,15.6z", () => el("settings-btn").click()));
}

function init() {
  addGmHeader();
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
  el("layout-btn").addEventListener("click", onLayoutClick);
  el("gm-fab").addEventListener("click", () => el("new-message-btn").click());
  applyLayout();
  el("calls-btn").addEventListener("click", onCallsClick);
  el("groups-btn").addEventListener("click", () => { groupsView = !groupsView; renderConversationList(); });
  el("calls-back-btn").addEventListener("click", () => showScreen("conversations"));
  el("calls-refresh-btn").addEventListener("click", onCallsRefreshClick);
  el("deleted-select-multiple-btn").addEventListener("click", () => enterDeletedGroupsSelectionMode(null));
  el("deleted-selection-cancel-btn").addEventListener("click", exitDeletedGroupsSelectionMode);
  el("deleted-selection-restore-btn").addEventListener("click", confirmRestoreSelectedGroups);
  el("deleted-selection-delete-btn").addEventListener("click", confirmDeleteSelectedGroups);
  el("deleted-thread-back-btn").addEventListener("click", () => showScreen("settings"));
  el("deleted-thread-restore-btn").addEventListener("click", restoreSelectedInThread);
  el("deleted-thread-delete-forever-btn").addEventListener("click", deleteForeverSelectedInThread);
  el("conv-selection-cancel-btn").addEventListener("click", exitConversationSelectionMode);
  el("conv-select-all-btn").addEventListener("click", toggleSelectAllConversations);
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
  // Merged into one button, like Google Messages -- confirmed explicit
  // request: a normal tap sends now, holding it down opens the schedule
  // picker instead. suppressNextSendClick stops the tap's own "click"
  // (which still fires right after a long-press's touchend/mouseup) from
  // ALSO sending the message the same moment the schedule picker opens.
  let suppressNextSendClick = false;
  attachLongPress(el("send-btn"), () => {
    suppressNextSendClick = true;
    onScheduleButtonClick();
  });
  el("send-btn").addEventListener("click", () => {
    if (suppressNextSendClick) {
      suppressNextSendClick = false;
      return;
    }
    onSendClick();
  });
  el("compose-input").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      onSendClick();
    }
  });
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
// New group / mass text: collect several numbers (contact picker where the browser has one, typed numbers otherwise), then ask Group or Just me.
async function createGroupFlow() {
  const numbers = [];
  const names = {};
  if (navigator.contacts && navigator.contacts.select) {
    try {
      const picked = await navigator.contacts.select(["name", "tel"], { multiple: true });
      for (const c of picked || []) {
        const n = normalizeNumber((c.tel && c.tel[0]) || "");
        if (n) { numbers.push(n); names[n] = (c.name && c.name[0]) || n; }
      }
    } catch (e) { logDebug("Contact picker unavailable/cancelled: " + e); }
  }
  for (;;) {
    const have = numbers.length ? "Added: " + numbers.map((n) => names[n] || n).join(", ") + "\n\n" : "";
    const typed = prompt(have + "Add a number (leave empty when you are done):");
    if (typed === null || typed.trim() === "") break;
    const n = normalizeNumber(typed);
    if (n && !numbers.includes(n)) numbers.push(n);
  }
  if (numbers.length < 2) { if (numbers.length === 1) openChat(numbers[0]); return; }
  const mode = await showActionSheet("Recipients reply to", [
    { label: "👥 Group - one shared conversation, everyone sees every reply", value: "g:" },
    { label: "👤 Just me - a mass text: each person gets it separately, replies come only to you", value: "m:" },
  ]);
  if (!mode) return;
  openChat(multiKey(mode, numbers));
}

async function onNewMessageClick() {
  {
    const choice0 = await showActionSheet("New Message", [
      { label: "⌨️ Type a number", value: "type" },
      { label: "👥 Create group", value: "group" },
      ...(navigator.contacts && navigator.contacts.select ? [{ label: "👤 Choose from Contacts", value: "contacts" }] : []),
    ]);
    if (choice0 === "group") { await createGroupFlow(); return; }
    if (choice0 === null) return;
    if (choice0 === "type") {
      const number0 = prompt("Phone number?");
      if (!number0) return;
      const normalized0 = normalizeNumber(number0);
      if (normalized0) openChat(normalized0);
      return;
    }
  }
  if (navigator.contacts && navigator.contacts.select) {
    const choice = "contacts"; // the sheet above already chose; the original code below handles the contact picker
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
  stagedAttachments = [];
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
function pickFile({ accept, capture, multiple }) {
  return new Promise((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = accept;
    if (capture) input.capture = capture;
    if (multiple) input.multiple = true;
    let resolved = false;
    input.addEventListener("change", () => {
      resolved = true;
      resolve(multiple ? Array.from(input.files) : (input.files[0] || null));
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

  const picked = await pickFile({
    accept: type === "photo" ? "image/*" : "video/*",
    capture: mode === "live" ? "environment" : null,
    multiple: mode !== "live",
  });
  const files = Array.isArray(picked) ? picked : (picked ? [picked] : []);
  if (!files.length) return;
  // 60MB, matching the tablet's own cap -- the phone re-encodes video down
  // to a small size once it receives it (VideoTranscoder), so this only
  // needs to protect against picking something absurd, not the actual MMS
  // limit.
  for (const file of files) {
    if (file.size > 60 * 1024 * 1024) {
      alert(file.name + " is too large to send (over 60MB) and was left out.");
      continue;
    }
    setPendingAttachment(file, type, null);
  }
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
  // "text/vcard" is the standard, registered MIME type (RFC 6350);
  // "text/x-vcard" is the old pre-registration experimental type. Matches
  // the phone's own MmsSender fix for the same reason.
  const file = new File([vcard], name + ".vcf", { type: "text/vcard" });
  setPendingAttachment(file, "contact", name);
}

function setPendingAttachment(file, kind, name) {
  if (pendingAttachmentFile) stagedAttachments.push({ file: pendingAttachmentFile, kind: pendingAttachmentKind, name: pendingAttachmentName });
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
  if (stagedAttachments.length) { // more than one: show how many (the X takes them all off again)
    el("attachment-label").textContent = "\uD83D\uDCCE " + (stagedAttachments.length + 1) + " attachments in this message";
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
    loadGroupNames();
    loadArchived();
    checkDeviceApproval();
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
    // Confirmed live as unwanted: the browser's own "this site wants to
    // send notifications" permission prompt, right after pairing --
    // "I don't want that, I want it to just be there." Not requesting this
    // means desktop push notifications for incoming messages just never
    // activate (Notification.permission stays "default"), silently, with
    // no prompt ever shown.
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

// ---------- layout: classic / Google tablet / Google phone ----------

const LAYOUT_KEY = "layout_mode";
const LAYOUT_LABELS = { auto: "Automatic", tablet: "Google Messages \u2014 tablet", phone: "Google Messages \u2014 phone", classic: "Classic" };

function storedLayout() {
  try { return localStorage.getItem(LAYOUT_KEY) || "auto"; } catch (e) { return "auto"; }
}

function effectiveLayout() {
  const m = storedLayout();
  if (m === "classic" || m === "tablet" || m === "phone") return m;
  return window.innerWidth >= 900 ? "tablet" : "phone";
}

function applyLayout() {
  const l = effectiveLayout();
  document.body.classList.toggle("gm", l !== "classic");
  document.body.classList.toggle("gm-tablet", l === "tablet");
  document.body.classList.toggle("gm-phone", l === "phone");
  const fab = el("gm-fab");
  if (fab) fab.classList.toggle("hidden", l === "classic" || currentScreenName !== "conversations" && !(l === "tablet" && currentScreenName === "chat"));
  const btn = document.getElementById("layout-btn");
  if (btn) btn.textContent = "Layout: " + LAYOUT_LABELS[storedLayout()];
}

async function onLayoutClick() {
  const choice = await showActionSheet("Layout", [
    { label: "Automatic", value: "auto" },
    { label: "Google Messages \u2014 tablet (side by side)", value: "tablet" },
    { label: "Google Messages \u2014 phone (one screen at a time)", value: "phone" },
    { label: "Classic (the original look)", value: "classic" },
  ]);
  if (!choice) return;
  try { localStorage.setItem(LAYOUT_KEY, choice); } catch (e) { /* private mode */ }
  applyLayout();
  showScreen(currentScreenName === "chat" ? "chat" : "conversations");
}

const GM_AVATARS = [["#eaa695", "#eaa696"], ["#d8b4f7", "#c8a2f8"], ["#83e7ca", "#89ecc3"], ["#86cbbe", "#6cc1b9"],
  ["#c098f0", "#bf9bea"], ["#ffa480", "#ffb189"], ["#ef9eb0", "#d784c8"], ["#ffb77b", "#ffb282"]];
const GM_PERSON = '<svg viewBox="0 0 24 24"><path d="M12,12c2.21,0 4,-1.79 4,-4s-1.79,-4 -4,-4 -4,1.79 -4,4 1.79,4 4,4zM12,14c-2.67,0 -8,1.34 -8,4v2h16v-2c0,-2.66 -5.33,-4 -8,-4z"/></svg>';

function gmMiniAvatar(name, cls) {
  const saved = name && /^\p{L}/u.test(name);
  if (!saved) return '<div class="gm-avatar unknown ' + cls + '">' + GM_PERSON + "</div>";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const pair = GM_AVATARS[Math.abs(h) % GM_AVATARS.length];
  return '<div class="gm-avatar ' + cls + '" style="background:linear-gradient(135deg,' + pair[0] + "," + pair[1] + ')">' + escapeHtml(name[0].toUpperCase()) + "</div>";
}

// A group's picture: up to three small letter circles in a triangle, like Google Messages.
function gmClusterHtml(key) {
  const names = key.slice(2).split(",").filter(Boolean).slice(0, 3).map((n) => displayName(n));
  return '<div class="gm-avatar gm-cluster">' + names.map((nm, i) => gmMiniAvatar(nm, "gm-mini gm-mini" + i)).join("") + "</div>";
}

function gmAvatarHtml(number) {
  if (isMulti(number)) return gmClusterHtml(number);
  const name = displayName(number) || "";
  const saved = name && name !== number && /^\p{L}/u.test(name);
  if (!saved) return '<div class="gm-avatar unknown">' + GM_PERSON + "</div>";
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) | 0;
  const pair = GM_AVATARS[Math.abs(h) % GM_AVATARS.length];
  return '<div class="gm-avatar" style="background:linear-gradient(135deg,' + pair[0] + "," + pair[1] + ')">' + escapeHtml(name[0].toUpperCase()) + "</div>";
}

let currentScreenName = "pairing";

function showScreen(name) {
  currentScreenName = name;
  const tablet = effectiveLayout() === "tablet";
  ["pairing", "conversations", "chat", "settings", "deleted-thread", "calls"].forEach((s) => {
    let visible = s === name;
    if (tablet && (name === "conversations" || name === "chat") && (s === "conversations" || s === "chat")) visible = true;
    el("screen-" + s).classList.toggle("hidden", !visible);
  });
  // tablet layout: with no conversation open, the right side shows a hint instead of an empty chat
  const showHint = tablet && currentChatNumber == null;
  const ph = document.getElementById("chat-placeholder");
  if (ph) ph.style.display = showHint ? "flex" : "none";
  el("message-list").style.display = showHint ? "none" : "";
  applyLayout();
}

window.addEventListener("resize", () => { if (storedLayout() === "auto") { applyLayout(); showScreen(currentScreenName); } });

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
// next write, doesn't flicker the status -- comfortable margin above the
// phone's own ~5s write interval. Was 120s against a since-shrunk ~30s
// write interval, but never updated here when the phone (and the tablet's
// matching poll) sped up -- this PWA copy was lagging behind by as much as
// two full minutes before "not connected" ever showed. Matches the
// tablet's own PHONE_HEARTBEAT_STALE_MS exactly now.
const PHONE_HEARTBEAT_STALE_MS = 20 * 1000;

// How long a "Sending..." local echo sits before the bubble itself says so
// isn't delivering, instead of silently staying "Sending..." forever with
// no visible sign anything went wrong -- confirmed live as a real gap: a
// contact attachment that had actually failed on the phone (no retry, no
// failure report back) just sat there looking identical to "still in
// progress" for minutes. Matches the tablet's own PENDING_TIMEOUT_MS.
const PENDING_TIMEOUT_MS = 3 * 60 * 1000;
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
  updatePhoneStatus(lastHeartbeatSeenAt > 0 && (Date.now() - lastHeartbeatSeenAt) < PHONE_HEARTBEAT_STALE_MS, null, null, false);
  const poll = async () => {
    try {
      const res = await fetch(roomUrl("phoneHeartbeat"));
      const data = res.ok ? await res.json() : null;
      const value = data && typeof data.timestamp === "number" ? data.timestamp : null;
      // -1 (the phone's own sentinel for "couldn't read battery") means
      // the same as no value at all -- don't show a bogus "-1%".
      const batteryPercent = data && typeof data.batteryPercent === "number" && data.batteryPercent >= 0
          ? data.batteryPercent : null;
      // Both can be true at once -- the phone can be on Wi-Fi while its
      // cellular radio is also registered, same as its own status bar's
      // two separate icons.
      const network = data ? { wifi: !!data.wifi, cellular: !!data.cellular } : null;
      const charging = !!(data && data.charging);
      const now = Date.now();
      if (value != null) {
        if (hasPolledHeartbeatOnce && value !== lastHeartbeatValue) {
          lastHeartbeatSeenAt = now;
        }
        lastHeartbeatValue = value;
      }
      hasPolledHeartbeatOnce = true;
      saveHeartbeatState();
      try {
        const ur = await fetch(roomUrl("unreadState"));
        const ud = ur.ok ? await ur.json() : null;
        if (ud && typeof ud.at === "number" && ud.at > 0) {
          const next = ud.counts || {};
          if (JSON.stringify(next) !== JSON.stringify(phoneUnread)) {
            phoneUnread = next;
            renderConversationList();
          }
        }
      } catch (e) {
        // not fatal: keeps the last known counts
      }
      const connected = lastHeartbeatSeenAt > 0 && (now - lastHeartbeatSeenAt) < PHONE_HEARTBEAT_STALE_MS;
      updatePhoneStatus(connected, connected ? batteryPercent : null, connected ? network : null, connected && charging);
    } catch (e) {
      updatePhoneStatus(false, null, null, false);
    }
  };
  poll();
  // Matches the phone's own ~5s write interval (was 30s, same staleness
  // problem as PHONE_HEARTBEAT_STALE_MS above).
  phoneHeartbeatTimer = setInterval(poll, 5000);
}

function updatePhoneStatus(connected, batteryPercent, network, charging) {
  const phoneStatusEl = el("phone-status-text");
  if (!phoneStatusEl) return;
  phoneStatusEl.textContent = connected ? "Phone is connected to Firebase" : "Phone not reachable right now";
  phoneStatusEl.classList.toggle("connected", connected);
  phoneStatusEl.classList.toggle("disconnected", !connected);

  // Real icon graphics (same vector paths as the tablet's own status row),
  // not emoji -- confirmed explicit request. Wi-Fi only shows up when
  // actually connected; the signal bars only show up at all once the
  // phone's reachable, and the no-signal X badges them when it's reachable
  // but off cellular, matching the tablet's own logic exactly.
  const wifiIcon = el("wifi-icon");
  if (wifiIcon) wifiIcon.classList.toggle("hidden", !(network && network.wifi));

  const signalWrap = el("signal-icon-wrap");
  const noSignalBadge = el("no-signal-badge");
  if (signalWrap) signalWrap.classList.toggle("hidden", !connected);
  if (noSignalBadge) noSignalBadge.classList.toggle("hidden", !(connected && network && !network.cellular));

  // Blank (not a stale/misleading number) whenever the phone isn't
  // actually reachable, matching the tablet's own battery indicator. No
  // "%" sign -- just the number, inside the icon, same as the tablet.
  const batteryWrap = el("battery-icon-wrap");
  const batteryNumber = el("battery-number");
  const batteryBolt = el("battery-bolt");
  if (batteryWrap) {
    const show = batteryPercent != null;
    batteryWrap.classList.toggle("hidden", !show);
    batteryWrap.classList.toggle("low", show && batteryPercent <= 20);
    if (batteryNumber) batteryNumber.textContent = show ? batteryPercent : "";
    if (batteryBolt) batteryBolt.classList.toggle("hidden", !(show && charging));
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
  const rawSender = data.sender || "";
  let inNumber, fromNumber = null;
  if (rawSender.startsWith("gm:")) { // a reply on a group MMS: file it in the matching group, remember who wrote it
    const semi = rawSender.indexOf(";");
    const who = normalizeNumber(rawSender.slice(3, semi < 0 ? undefined : semi));
    const grp = semi < 0 ? null : matchGroup(rawSender.slice(semi + 1));
    inNumber = grp || who;
    fromNumber = grp ? who : null;
  } else {
    inNumber = normalizeNumber(rawSender);
  }
  messages.push({
    id: key,
    direction: "in",
    fromNumber,
    number: inNumber,
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

  const number = groupKeyFromAddress(data.to);
  const body = data.body || "";
  const timestamp = data.timestamp || Date.now();

  const folded = foldIntoMassText(number, body, timestamp);
  if (folded === 1) return true;
  if (folded === 2) return false;
  if (number.startsWith("m:")) massRecent.push({ key: number, body, at: Date.now() });

  // A sent picture / voice message / video is matched to its "Sending..." copy by what it carries (same kind, close in time), not by
  // its caption: the phone writes its own caption text for media. The closest in time wins.
  const recKind = data.imageUrl ? "picture" : (data.attachmentType || null);
  let localIdx = -1, bestGap = Infinity;
  messages.forEach((m, i) => {
    if (m.direction !== "out" || !m.id.startsWith("local-") || m.number !== number) return;
    const gap = Math.abs(m.timestamp - timestamp);
    if (gap >= 120000) return;
    const echoKind = m.attachmentKind || (m.imageUrl ? "picture" : null);
    const same = m.body === body || (recKind && recKind === (echoKind === "photo" ? "picture" : echoKind));
    if (same && gap < bestGap) { bestGap = gap; localIdx = i; }
  });
  const matchedEcho = localIdx !== -1;
  if (matchedEcho) messages.splice(localIdx, 1);

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
    source: matchedEcho ? "web" : "phone",
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

// Everything added to this message goes out one after the other, the typed text with the last one.
let stagedAttachments = [];
let lastSendTs = 0;

async function onSendClick() {
  const input = el("compose-input");
  const rawBody = input.value.trim();
  const items = stagedAttachments.slice();
  if (pendingAttachmentFile) items.push({ file: pendingAttachmentFile, kind: pendingAttachmentKind, name: pendingAttachmentName });
  if (!rawBody && !items.length) return;
  if (!currentChatNumber) return;
  stagedAttachments = [];
  input.value = "";
  clearAttachment();
  if (!items.length) { await sendOne(rawBody, null, null, null); return; }
  for (let i = 0; i < items.length; i++) {
    await sendOne(i === items.length - 1 ? rawBody : "", items[i].file, items[i].kind, items[i].name);
  }
}

async function sendOne(rawBody, file, kind, attachmentName) {
  const timestamp = Math.max(Date.now(), lastSendTs + 1);
  lastSendTs = timestamp;
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
  renderChat(currentChatNumber);
  renderConversationList();
  // One-shot re-render right at the pending timeout, so a still-stuck
  // bubble actually flips to "Not delivered" instead of only updating
  // whenever some unrelated event happens to trigger a fresh render.
  setTimeout(() => {
    if (currentChatNumber === msg.number) renderChat(currentChatNumber);
  }, PENDING_TIMEOUT_MS + 1000);

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
  const kind = m.imageUrl ? "Picture (MMS)" : m.attachmentKind === "video" ? "Video (MMS)" : m.attachmentKind === "audio" ? "Voice message (MMS)" : m.attachmentKind ? "Contact card (MMS)" : "Text message";
  const bytes = new TextEncoder().encode(m.body || "").length;
  const lines = [
    (m.direction === "out" ? "Sent: " : "Received: ") + new Date(m.timestamp).toLocaleString(),
    "Status: " + status,
    (m.direction === "out" ? "To: " : "From: ") + (isMulti(m.number) ? displayName(m.number) : (displayName(m.number) === m.number ? m.number : displayName(m.number) + " (" + m.number + ")")),
    "Type: " + kind,
    "Text size: " + bytes + (bytes === 1 ? " byte" : " bytes"),
  ];
  if (m.fromNumber) lines.push("Written by: " + displayName(m.fromNumber));
  if (m.direction === "out") lines.push("Sent from: " + (m.source === "web" ? "this page (through the phone)" : "the phone"));
  lines.push("Message ID: " + m.id, "Conversation: " + m.number);
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

/**
 * No access to the phone's own content://sms from here, so this just asks
 * the phone to do the work -- see the phone's own
 * RelayService.checkReconcileRequest(), which polls for this. Picks up
 * both directions: a message deleted directly on the phone that hasn't
 * been reconciled yet (its own background pass only checks one slice a
 * day, and only while charging), and anything local that never made it to
 * Firebase in the first place.
 */
async function onForceResyncClick() {
  if (!confirm("Ask the phone to re-check everything against its real messages right now, instead of"
      + " waiting for its own background schedule? This can take a little while for a large message"
      + " history.")) return;
  try {
    await fetch(roomUrl("reconcileRequest"), {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ at: Date.now() }),
    });
    alert("Requested -- the phone will pick this up shortly.");
  } catch (e) {
    logDebug("Force resync request failed: " + (e && e.stack ? e.stack : e));
    alert("Couldn't reach Firebase to request this -- try again.");
  }
}

function onSettingsClick() {
  showScreen("settings");
  addExtraSettings();
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
// Select Multiple for Recently Deleted's own conversation groups -- same
// checkbox pattern the main conversation list's own selection mode already
// uses, since restoring/deleting several conversations' worth of deleted
// messages one at a time (long-press each) was the actual gap being
// reported: there was no way to act on more than one at once.
let deletedGroupsSelectionMode = false;
let selectedDeletedGroups = new Set();

function renderDeletedGroupsList() {
  const list = el("deleted-list");
  list.innerHTML = "";
  el("deleted-empty-state").classList.toggle("hidden", deletedGroups.size > 0);
  el("deleted-select-multiple-btn").classList.toggle("hidden", deletedGroupsSelectionMode || deletedGroups.size === 0);

  const sortedNumbers = [...deletedGroups.keys()].sort((a, b) => {
    const aLatest = Math.max(...deletedGroups.get(a).map((i) => i.deletedAt));
    const bLatest = Math.max(...deletedGroups.get(b).map((i) => i.deletedAt));
    return bLatest - aLatest;
  });

  for (const number of sortedNumbers) {
    const groupItems = deletedGroups.get(number);
    const row = document.createElement("div");
    row.className = "deleted-group-row";
    const selected = selectedDeletedGroups.has(number);
    row.innerHTML = `
      ${deletedGroupsSelectionMode ? `<div class="select-circle${selected ? " checked" : ""}"></div>` : ""}
      <div class="info">
        <div class="name">${escapeHtml(displayName(number) || number)}</div>
        <div class="preview">${groupItems.length} deleted</div>
      </div>
    `;
    if (deletedGroupsSelectionMode) {
      row.addEventListener("click", () => toggleDeletedGroupSelection(number));
    } else {
      row.addEventListener("click", () => openDeletedThread(number));
      attachLongPress(row, () => showDeletedGroupMenu(number));
    }
    list.appendChild(row);
  }
}

function toggleDeletedGroupSelection(number) {
  if (!selectedDeletedGroups.delete(number)) selectedDeletedGroups.add(number);
  if (selectedDeletedGroups.size === 0) {
    exitDeletedGroupsSelectionMode();
    return;
  }
  el("deleted-selection-count").textContent = `${selectedDeletedGroups.size} selected`;
  renderDeletedGroupsList();
}

function enterDeletedGroupsSelectionMode(preChecked) {
  deletedGroupsSelectionMode = true;
  selectedDeletedGroups = new Set(preChecked ? [preChecked] : []);
  el("deleted-selection-count").textContent = `${selectedDeletedGroups.size} selected`;
  el("deleted-selection-toolbar").classList.remove("hidden");
  renderDeletedGroupsList();
}

function exitDeletedGroupsSelectionMode() {
  deletedGroupsSelectionMode = false;
  selectedDeletedGroups = new Set();
  el("deleted-selection-toolbar").classList.add("hidden");
  renderDeletedGroupsList();
}

async function confirmRestoreSelectedGroups() {
  const numbers = [...selectedDeletedGroups];
  if (numbers.length === 0) return;
  if (!confirm(`Restore ${numbers.length} conversation${numbers.length === 1 ? "" : "s"}?`)) return;
  for (const number of numbers) {
    for (const item of deletedGroups.get(number) || []) await restoreDeletedMessage(item, false);
  }
  exitDeletedGroupsSelectionMode();
  loadDeletedMessages();
}

async function confirmDeleteSelectedGroups() {
  const numbers = [...selectedDeletedGroups];
  if (numbers.length === 0) return;
  if (!confirm(`Are you sure you want to delete ${numbers.length} conversation${numbers.length === 1 ? "" : "s"} forever? This can't be undone.`)) return;
  for (const number of numbers) {
    for (const item of deletedGroups.get(number) || []) await permanentlyDeleteMessage(item, false);
  }
  exitDeletedGroupsSelectionMode();
  loadDeletedMessages();
}

async function showDeletedGroupMenu(number) {
  const choice = await showActionSheet(displayName(number) || number, [
    { label: "↩️ Restore All", value: "restore" },
    { label: "🗑️ Delete Forever", value: "delete" },
    { label: "☑️ Select Multiple", value: "select" },
  ]);
  if (choice === "restore") confirmRestoreAllForNumber(number);
  else if (choice === "delete") confirmDeleteForeverAllForNumber(number);
  else if (choice === "select") enterDeletedGroupsSelectionMode(number);
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

// ---------- calls ----------
// Calls (missed, incoming, outgoing) the phone's own call log picked up --
// see the phone's own CallLogRelayService. Read-only except for dismissing
// entries (which just removes them from this list; the phone's own call
// log is never touched).

let allCalls = [];

function onCallsClick() {
  showScreen("calls");
  loadCalls();
}

async function loadCalls() {
  let calls = [];
  try {
    const res = await fetch(roomUrl("calls"));
    const snapshot = res.ok ? await res.json() : null;
    if (snapshot && typeof snapshot === "object") {
      calls = Object.keys(snapshot).map((key) => ({
        key,
        number: snapshot[key].number,
        contactName: snapshot[key].contactName || null,
        type: snapshot[key].type || "incoming",
        timestamp: snapshot[key].timestamp || 0,
        duration: snapshot[key].duration || 0,
      })).filter((c) => c.number);
    }
  } catch (e) {
    logDebug("Loading calls failed: " + (e && e.stack ? e.stack : e));
  }
  calls.sort((a, b) => b.timestamp - a.timestamp);
  allCalls = calls;
  renderCallsList();
  await loadCallsStatus();
}

// showFeedback is true only for an explicit Refresh button press -- per
// explicit instruction that pressing it gave no visual sign it was doing
// anything. The automatic load when opening the Calls screen stays silent.
async function onCallsRefreshClick() {
  const btn = el("calls-refresh-btn");
  btn.disabled = true;
  const original = btn.textContent;
  btn.textContent = "↻ Refreshing…";
  await loadCalls();
  btn.textContent = "✓ Refreshed";
  setTimeout(() => {
    btn.textContent = original;
    btn.disabled = false;
  }, 1200);
}

async function loadCallsStatus() {
  const statusLine = el("calls-status-line");
  try {
    const res = await fetch(roomUrl("callsStatus"));
    const status = res.ok ? await res.json() : null;
    if (!status || typeof status !== "object") {
      statusLine.textContent = "Calls sync: not set up on the phone yet";
      return;
    }
    const when = status.lastSyncedAt ? relativeTime(status.lastSyncedAt) : "never";
    statusLine.textContent = status.enabled
        ? `Calls sync: On · last synced ${when}`
        : "Calls sync: Off on the phone";
  } catch (e) {
    logDebug("Loading calls status failed: " + (e && e.stack ? e.stack : e));
  }
}

// "12s ago", "3m ago", "2h ago", "5d ago" -- mirrors the phone's own CallsSettingsActivity.relativeTime().
function relativeTime(whenMs) {
  const seconds = Math.floor((Date.now() - whenMs) / 1000);
  if (seconds < 5) return "just now";
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

// A directional arrow symbol next to the type, matching the phone's own native call log glyphs, per explicit request.
function callTypeLabel(type) {
  if (type === "missed") return "↙ Missed";     // ↙
  if (type === "outgoing") return "↗ Outgoing"; // ↗
  return "↘ Incoming"; // ↘
}

// "0:45", "3:12" -- how long the call itself lasted, per explicit instruction (never shown for missed calls, which are always 0).
function formatCallDuration(seconds) {
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${s < 10 ? "0" + s : s}`;
}

let callsTab = 0; // 0 = All, 1 = Contacts, 2 = Not contacts, 3 = Missed
function renderCallsList() {
  const list = el("calls-list");
  list.innerHTML = "";
  let bar = document.getElementById("calls-tabs");
  if (!bar) {
    bar = document.createElement("div");
    bar.id = "calls-tabs";
    bar.style.cssText = "display:flex;gap:6px;padding:6px 12px;overflow-x:auto";
    list.parentNode.insertBefore(bar, list);
  }
  bar.innerHTML = "";
  ["All", "Contacts", "Not contacts", "Missed"].forEach((label, i) => {
    const b = document.createElement("button");
    b.className = "toolbar-btn";
    b.textContent = label;
    if (i === callsTab) b.style.fontWeight = "700";
    b.addEventListener("click", () => { callsTab = i; renderCallsList(); });
    bar.appendChild(b);
  });
  const shown = allCalls.filter((c) => callsTab === 0 || (callsTab === 1 && c.contactName) || (callsTab === 2 && !c.contactName) || (callsTab === 3 && c.type === "missed"));
  el("calls-empty-state").classList.toggle("hidden", shown.length > 0);

  for (const call of shown) {
    const row = document.createElement("div");
    row.className = "deleted-group-row";
    const when = call.timestamp ? new Date(call.timestamp).toLocaleString(undefined, {
      month: "short", day: "numeric", hour: "numeric", minute: "2-digit",
    }) : "";
    const durationPart = call.type === "missed" ? "" : `${formatCallDuration(call.duration)} &middot; `;
    row.innerHTML = `
      <div class="info">
        <div class="name">${escapeHtml(call.contactName || call.number)}</div>
        <div class="preview"${call.type === "missed" ? ' style="color:var(--danger)"' : ""}>${escapeHtml(callTypeLabel(call.type))} &middot; ${durationPart}${escapeHtml(when)}</div>
      </div>
    `;
    row.addEventListener("click", () => { window.location.href = "tel:" + call.number; });
    list.appendChild(row);
  }
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
    .map((c) => ({ ...c, unread: isUnread(c), unreadCount: phoneUnread ? (phoneUnread[c.number] || 0) : 0, pinned: isPinned(c.number) }))
    // Pinned first (matching the tablet app), chronological within each
    // group -- an unread conversation used to jump to the top on its own,
    // but that's a change of mind from before: it should stay in the order
    // its last message actually arrived, same as every normal texting app.
    // isUnread() above still marks it (bold name + dot in the rendered
    // list), just no longer as a sort key by itself.
    .sort((a, b) => (b.pinned - a.pinned) || (b.last.timestamp - a.last.timestamp));
}

function displayName(number) {
  if (isMulti(number)) { // a group: the name you gave it, or its members' names
    if (groupNames[number]) return groupNames[number];
    return number.slice(2).split(",").filter(Boolean).map((n) => displayName(n)).join(", ");
  }
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
    const visible = filteredConversations();
    const allSelected = visible.length > 0 && visible.every(({ number }) => selectedConversationNumbers.has(number));
    el("conv-select-all-btn").textContent = allSelected ? "Deselect All" : "Select All";
  }
}

/** Selects (or deselects) every conversation currently visible, honoring the active search filter -- same fix as the tablet/phone apps' own conversation-list Select All. */
function toggleSelectAllConversations() {
  const visible = filteredConversations();
  const allSelected = visible.length > 0 && visible.every(({ number }) => selectedConversationNumbers.has(number));
  if (allSelected) {
    // Stays in selection mode with nothing selected, same as the phone/
    // tablet apps -- "Deselect All" clears the picks without kicking back
    // out to the plain conversation list.
    selectedConversationNumbers.clear();
  } else {
    for (const { number } of visible) selectedConversationNumbers.add(number);
  }
  renderConversationList();
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
  const options = [
    { label: pinned ? "📌 Unpin" : "📌 Pin to top", value: "pin" },
    { label: "🗄️ Archive", value: "archive" },
    { label: "☑️ Select", value: "select" },
  ];
  if (isMulti(number)) options.splice(2, 0, { label: "✏️ Rename group", value: "rename" });
  else options.push({ label: "🚫 Block/Unblock", value: "block" });
  const choice = await showActionSheet(displayName(number) || number, options);
  if (choice === "archive") {
    const how = await showActionSheet("Archive", [
      { label: "Come back when a new message arrives", value: "back" },
      { label: "Stay archived, even for new messages", value: "stay" },
    ]);
    if (how) { setArchived(number, true, how === "stay"); renderConversationList(); }
    return;
  }
  if (choice === "rename") { const n = prompt("Name this group:", groupNames[number] || ""); if (n !== null) { setGroupName(number, n.trim()); renderConversationList(); } return; }
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

const HIDE_GROUPS_KEY = "flip_relay_web_hide_groups";
function groupsHidden() { try { return localStorage.getItem(HIDE_GROUPS_KEY) === "1"; } catch (e) { return false; } }
let groupsView = false; // the Group texts screen: only groups and mass texts
let groupsSeenAt = 0;
function updateGroupsButton() {
  const b = document.getElementById("groups-btn");
  if (!b) return;
  b.classList.toggle("hidden", groupsHidden());
  const unread = conversationsByNumber().some((c) => isMulti(c.number) && c.unread && !archived.has(c.number));
  b.textContent = groupsView ? "All chats" : (unread ? "Groups \u25CF" : "Groups");
  b.style.color = unread && !groupsView ? "#e53935" : "";
  const g = document.getElementById("gm-groups-btn");
  if (g) { g.classList.toggle("hidden", groupsHidden()); g.style.position = "relative"; g.style.color = groupsView ? "var(--accent, #0b57d0)" : ""; g.dataset.dot = unread && !groupsView ? "1" : "0"; }
}
function filteredConversations() {
  let convos = conversationsByNumber().filter((c) => !archived.has(c.number));
  if (groupsHidden()) convos = convos.filter((c) => !isMulti(c.number));
  else convos = convos.filter((c) => isMulti(c.number) === groupsView); // groups only on their own screen
  const q = conversationSearchQuery.trim().toLowerCase();
  if (q) {
    convos = convos.filter(({ number }) => {
      const name = (displayName(number) || "").toLowerCase();
      return name.includes(q) || number.includes(q);
    });
  }
  return convos;
}

function renderConversationList() {
  const list = el("conversation-list");
  const convos = filteredConversations();
  list.innerHTML = "";
  el("empty-state").classList.toggle("hidden", convos.length > 0);
  updateConversationSelectionToolbar();
  updateGroupsButton();

  for (const { number, last, unread, unreadCount, pinned } of convos) {
    const item = document.createElement("div");
    const selected = conversationSelectionMode && selectedConversationNumbers.has(number);
    item.className = "conversation-item" + (unread ? " unread" : "") + (selected ? " selected" : "") + (number === currentChatNumber ? " open" : "");
    const prefix = last.direction === "out" ? "You: " : last.direction === "scheduled" ? "Scheduled: "
      : (isMulti(number) && last.fromNumber ? displayName(last.fromNumber) + ": " : "");
    const preview = last.imageUrl ? "📷 Picture" + (last.body ? ": " + last.body : "") : last.body;
    const checkHtml = conversationSelectionMode
        ? `<div class="select-circle${selected ? " checked" : ""}"></div>` : "";
    const pinHtml = pinned ? '<span class="pin-mark">📌</span>' : "";
    item.innerHTML = `
      ${checkHtml}
      ${gmAvatarHtml(number)}
      <div class="conversation-item-body">
        <div class="name">${pinHtml}${unread ? '<span class="unread-dot">●</span>' : ""}${escapeHtml(displayName(number))}</div>
        <div class="preview">${prefix}${escapeHtml(preview)}</div>
      </div>
      <div class="time">${formatTime(last.timestamp)}</div>
      ${unread && unreadCount > 0 ? `<div class="unread-badge">${unreadCount > 999 ? "999+" : unreadCount}</div>` : ""}
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
  el("chat-subtitle").textContent = isMulti(number) ? (number.startsWith("m:") ? "Mass text - tap the name to rename" : "Group - tap the name to rename") : number;
  el("compose-input").placeholder = number.startsWith("m:") ? "Mass text" : number.startsWith("g:") ? "Group text" : "Text message";
  el("chat-title").style.cursor = isMulti(number) ? "pointer" : "";
  el("chat-title").onclick = isMulti(number) ? () => renameGroup(number) : null;
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

  let lastShown = 0;
  for (const m of thread) {
    if (m.direction !== "scheduled" && (m.timestamp - lastShown > 3600000 || new Date(m.timestamp).toDateString() !== new Date(lastShown).toDateString())) {
      const sep = document.createElement("div");
      sep.className = "gm-sep gm-only";
      const dd = new Date(m.timestamp);
      const today = new Date();
      const days = Math.round((new Date(today.getFullYear(), today.getMonth(), today.getDate()) - new Date(dd.getFullYear(), dd.getMonth(), dd.getDate())) / 86400000);
      const clock = dd.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      sep.textContent = (days === 0 ? "Today" : days === 1 ? "Yesterday" : dd.toLocaleDateString([], { weekday: "long", month: "short", day: "numeric" })) + " \u2022 " + clock;
      list.appendChild(sep);
      lastShown = m.timestamp;
    }
    const row = document.createElement("div");
    const isScheduled = m.direction === "scheduled";
    const isOut = m.direction === "out";
    row.className = "bubble-row " + (isScheduled ? "out" : m.direction);
    // in a group, say who wrote each message (their picture and name above the first of a run), like Google Messages
    if (!isOut && !isScheduled && isMulti(number) && m.fromNumber) {
      const prev = thread[thread.indexOf(m) - 1];
      if (!prev || prev.direction !== "in" || prev.fromNumber !== m.fromNumber) {
        const who = displayName(m.fromNumber);
        const hdr = document.createElement("div");
        hdr.className = "gm-sender";
        const pal = ["#b4146b", "#0b57d0", "#1e8e3e", "#c25e00", "#8430ce", "#c5221f"];
        let hh = 0;
        for (let i = 0; i < who.length; i++) hh = (hh * 31 + who.charCodeAt(i)) | 0;
        hdr.innerHTML = gmMiniAvatar(who, "gm-sender-avatar") + '<span style="color:' + pal[Math.abs(hh) % pal.length] + '">' + escapeHtml(who) + "</span>";
        list.appendChild(hdr);
      }
      row.classList.add("indent");
    }
    // A "local-" id is this browser's own optimistic echo, shown the
    // instant Send was clicked, before the phone has confirmed anything --
    // upsertSent() replaces it with the real Firebase record (a normal
    // push-key id) once the phone actually reports the send. Matches
    // asking "did this actually reach the phone, or are we still in
    // limbo" at a glance. Past PENDING_TIMEOUT_MS with no confirmation,
    // says so instead of silently staying "Sending..." forever.
    const stillPending = m.id.startsWith("local-");
    const stuck = stillPending && (Date.now() - m.timestamp) > PENDING_TIMEOUT_MS;
    const deliveryStatus = isOut && !isScheduled
        ? (stuck ? " · Not delivered" : stillPending ? " · Sending..." : " · ✓ Sent")
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
    row.innerHTML = `${circleHtml}<div class="bubble${isScheduled ? " scheduled" : ""}">${imageHtml}${attachmentHtml}${bodyHtml}<span class="meta${stuck ? " stuck" : ""}">${meta}</span></div>`;
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
    if (!isScheduled) {
      const t = document.createElement("div");
      t.className = "gm-time gm-only " + (isOut ? "out" : "in") + (stuck ? " stuck" : "");
      t.textContent = formatTime(m.timestamp) + (isOut ? (stuck ? " \u00B7 Not sent" : stillPending ? " \u00B7 Sending..." : "") : "");
      if (isOut && showSourceOn()) { // phone / computer icon at the far right of the line
        const ic = document.createElement("span");
        ic.className = "gm-source";
        ic.title = m.source === "web" ? "Sent from this page" : "Sent from the phone";
        ic.textContent = m.source === "web" ? "\uD83D\uDCBB" : "\uD83D\uDCF1";
        t.appendChild(ic);
      }
      list.appendChild(t);
    }
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

// ---------- swipe sideways between Conversations, Group texts and Calls (a setting, off by default) ----------
const SWIPE_KEY = "flip_relay_web_swipe";
function swipeOn() { try { return localStorage.getItem(SWIPE_KEY) === "1"; } catch (e) { return false; } }
(function setupSwipe() {
  let x0 = null, y0 = null;
  document.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (x0 == null || !swipeOn()) { x0 = null; return; }
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 110 || Math.abs(dx) < Math.abs(dy) * 2) return;
    if (currentScreenName === "conversations" && !selectionMode && !conversationSelectionMode) {
      if (dx < 0) { if (!groupsView && !groupsHidden()) { groupsView = true; renderConversationList(); } else onCallsClick(); }
      else if (groupsView) { groupsView = false; renderConversationList(); }
    } else if (currentScreenName === "calls" && dx > 0 && callsTab === 0) {
      showScreen("conversations");
    }
  });
})();

// ---------- archive (hide a conversation from the list without deleting it) ----------
let archived = new Set();
function archivedKey() { return "flip_relay_web_archived_" + roomId; }
function loadArchived() {
  try { archived = new Set(JSON.parse(localStorage.getItem(archivedKey()) || "[]")); } catch (e) { archived = new Set(); }
  try { archivedStay = new Set(JSON.parse(localStorage.getItem(archivedKey() + "_stay") || "[]")); } catch (e) { archivedStay = new Set(); }
}
let archivedStay = new Set(); // archived to STAY archived: new messages do not bring them back
function setArchived(number, on, stay) {
  if (on) archived.add(number); else archived.delete(number);
  if (on && stay) archivedStay.add(number); else archivedStay.delete(number);
  try { localStorage.setItem(archivedKey() + "_stay", JSON.stringify([...archivedStay])); } catch (e) { /* storage blocked */ }
  try { localStorage.setItem(archivedKey(), JSON.stringify([...archived])); } catch (e) { /* storage blocked */ }
}
// a new message in an archived conversation brings it back to the list
const _origUpsertIncoming = upsertIncoming;
upsertIncoming = function (key, data) {
  const added = _origUpsertIncoming(key, data);
  if (added) { const last = messages[messages.length - 1]; if (last && archived.has(last.number) && !archivedStay.has(last.number) && Date.now() - last.timestamp < 60000) setArchived(last.number, false); }
  return added;
};

// ---------- this device in the owner's list + approval (registry/<room>/tablets/<id>, shown on the dashboard) ----------
function webDeviceId() {
  try {
    let id = localStorage.getItem("flip_relay_web_device_id");
    if (!id) { id = "web-" + Math.random().toString(36).slice(2, 10) + Date.now().toString(36); localStorage.setItem("flip_relay_web_device_id", id); }
    return id;
  } catch (e) { return "web-unknown"; }
}
function webDeviceName() {
  const ua = navigator.userAgent || "";
  const os = /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iOS" : /Windows/.test(ua) ? "Windows" : /Mac/.test(ua) ? "Mac" : /Linux/.test(ua) ? "Linux" : "Browser";
  const br = /Edg\//.test(ua) ? "Edge" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "browser";
  return "Web app (" + br + " on " + os + ")";
}
let approvalOverlay = null;
async function checkDeviceApproval() {
  if (!roomId) return;
  try {
    const rres = await fetch(`${DATABASE_URL}/registry/${roomId}.json?auth=${DATABASE_SECRET}`);
    const reg = rres.ok ? await rres.json() : null;
    let allowed = true;
    if (reg && typeof reg === "object") {
      const require = reg.requireTabletApproval === true;
      const id = webDeviceId();
      const mine = reg.tablets && reg.tablets[id];
      const now = Date.now();
      const base = `${DATABASE_URL}/registry/${roomId}/tablets/${id}.json`;
      if (!mine) {
        await fetch(base + "?auth=" + DATABASE_SECRET, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: !require, name: webDeviceName(), model: webDeviceName(), app: "Web app", firstSeen: now, lastSeen: now }) });
        allowed = !require;
      } else {
        fetch(base + "?auth=" + DATABASE_SECRET + "&x-http-method-override=PATCH", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ lastSeen: now }) }).catch(() => {});
        allowed = mine.approved !== false || !require;
        if (mine.approved === false && require) allowed = false;
      }
    }
    setApprovalOverlay(!allowed);
    if (!allowed) setTimeout(checkDeviceApproval, 8000);
  } catch (e) { logDebug("approval check skipped: " + e); }
}
function setApprovalOverlay(show) {
  if (show && !approvalOverlay) {
    approvalOverlay = document.createElement("div");
    approvalOverlay.style.cssText = "position:fixed;inset:0;z-index:9999;background:var(--bg,#fff);color:var(--fg,#111);display:flex;align-items:center;justify-content:center;text-align:center;padding:32px;";
    approvalOverlay.innerHTML = "<div><h2>Waiting for approval</h2><p>The owner of this phone has to approve this device on the dashboard before it can show any messages.</p><p>" + escapeHtml(webDeviceName()) + "</p><p>This page checks again by itself.</p></div>";
    document.body.appendChild(approvalOverlay);
  } else if (!show && approvalOverlay) { approvalOverlay.remove(); approvalOverlay = null; }
}

// ---------- extra settings: show sent-from icon, backup / restore of this page's own data ----------
function addExtraSettings() {
  const body = document.getElementById("settings-body");
  if (!body || document.getElementById("extra-settings")) return;
  const box = document.createElement("div");
  box.id = "extra-settings";
  const mk = (label, fn) => { const b = document.createElement("button"); b.className = "settings-row"; b.textContent = label; b.addEventListener("click", fn); box.appendChild(b); return b; };
  const src = mk("", () => { try { localStorage.setItem(SHOW_SOURCE_KEY, showSourceOn() ? "0" : "1"); } catch (e) { /* blocked */ } src.textContent = "Show where messages were sent from: " + (showSourceOn() ? "On" : "Off"); if (currentChatNumber) renderChat(currentChatNumber); });
  src.textContent = "Show where messages were sent from: " + (showSourceOn() ? "On" : "Off");
  const hg = mk("", () => { try { localStorage.setItem(HIDE_GROUPS_KEY, groupsHidden() ? "0" : "1"); } catch (e) { /* blocked */ } hg.textContent = "Hide group texts (this page only): " + (groupsHidden() ? "On" : "Off"); renderConversationList(); });
  hg.textContent = "Hide group texts (this page only): " + (groupsHidden() ? "On" : "Off");
  const sw = mk("", () => { try { localStorage.setItem(SWIPE_KEY, swipeOn() ? "0" : "1"); } catch (e) { /* blocked */ } sw.textContent = "Swipe between screens: " + (swipeOn() ? "On" : "Off"); });
  sw.textContent = "Swipe between screens: " + (swipeOn() ? "On" : "Off");
  mk("Archived conversations", async () => {
    const list = [...archived];
    if (!list.length) { await showActionSheet("Archived", [{ label: "Nothing archived", value: "x" }]); return; }
    const pick = await showActionSheet("Tap one to bring it back", list.map((n) => ({ label: displayName(n), value: n })));
    if (pick) { setArchived(pick, false); renderConversationList(); }
  });
  mk("Save this page's settings to a file", () => {
    const data = {};
    try { for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); if (k && k.startsWith("flip_relay_web_") && !/_cache|device_id|lock|salt|hash/i.test(k)) data[k] = localStorage.getItem(k); } } catch (e) { /* blocked */ }
    const blob = new Blob([JSON.stringify({ room: roomId, data }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "flip-relay-web-settings.json";
    document.body.appendChild(a); a.click(); a.remove();
  });
  mk("Restore settings from a file", async () => {
    const f = await pickFile({ accept: "application/json" });
    if (!f) return;
    try {
      const j = JSON.parse(await f.text());
      for (const [k, v] of Object.entries(j.data || {})) if (k.startsWith("flip_relay_web_")) localStorage.setItem(k, v);
      alert("Restored. The page reloads now.");
      location.reload();
    } catch (e) { alert("That file could not be read."); }
  });
  body.insertBefore(box, body.firstChild);
}

// ---- App code (lock screen) -------------------------------------------------------------------------------------------
// A code of 4 or more digits is asked for every time the app opens. Only a salted SHA-256 of it is kept, in this browser.
// It keeps people who pick up the tablet/phone out of the conversations; it is not a server-side password.
const LOCK_KEY = "flip_relay_app_lock";
const LOCK_SKIP_KEY = "flip_relay_app_lock_skipped";

async function lockHash(code, salt) {
  const data = new TextEncoder().encode(salt + ":" + code);
  const buf = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function lockStored() {
  try { return JSON.parse(localStorage.getItem(LOCK_KEY) || "null"); } catch (e) { return null; }
}

// ---- Site passphrase: unlocks the (encrypted) database address and key -------------------------------------------------------
const CFG_KEY = "flip_relay_cfg_v1";

function b64bytes(b) { return Uint8Array.from(atob(b), (c) => c.charCodeAt(0)); }

async function decryptConfig(pass) {
  const [salt, iv, ct] = ENC_CONFIG.split(".").map(b64bytes);
  const km = await crypto.subtle.importKey("raw", new TextEncoder().encode(pass), "PBKDF2", false, ["deriveKey"]);
  const key = await crypto.subtle.deriveKey({ name: "PBKDF2", salt: salt, iterations: 300000, hash: "SHA-256" }, km, { name: "AES-GCM", length: 256 }, false, ["decrypt"]);
  const pt = await crypto.subtle.decrypt({ name: "AES-GCM", iv: iv }, key, ct);
  return JSON.parse(new TextDecoder().decode(pt));
}

async function configGate() {
  if (ENC_CONFIG.indexOf("__") === 0) return; // local/unbuilt copy: nothing encrypted
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch (e) {}
  if (saved && saved.url && saved.secret) { DATABASE_URL = saved.url; DATABASE_SECRET = saved.secret; return; }
  await lockCard({
    title: "Enter the site passphrase",
    text: "Asked once on each device. Without it this page cannot reach your messages.",
    fields: ["Passphrase"],
    textKeyboard: true,
    okLabel: "Continue",
    validate: async (v) => {
      try {
        const c = await decryptConfig(v[0].replace(/\s+/g, "").toLowerCase());
        DATABASE_URL = c.url; DATABASE_SECRET = c.secret;
        localStorage.setItem(CFG_KEY, JSON.stringify(c));
        return "";
      } catch (e) {
        return "Wrong passphrase";
      }
    },
  });
}

// Shows a full-screen card; resolves when the user finishes (or skips).
function lockCard(opts) {
  return new Promise((resolve) => {
    const wrap = document.createElement("div");
    wrap.style.cssText = "position:fixed;inset:0;z-index:99999;background:#F1F1F3;display:flex;align-items:center;justify-content:center;padding:16px;font-family:system-ui,sans-serif";
    const card = document.createElement("div");
    card.style.cssText = "background:#fff;border-radius:24px;padding:24px;width:100%;max-width:340px;box-shadow:0 2px 12px rgba(0,0,0,.12);display:flex;flex-direction:column;gap:12px";
    const h = document.createElement("h2");
    h.textContent = opts.title;
    h.style.cssText = "margin:0;font-size:20px;color:#1b1b1f";
    card.appendChild(h);
    if (opts.text) {
      const t = document.createElement("div");
      t.textContent = opts.text;
      t.style.cssText = "font-size:14px;color:#444";
      card.appendChild(t);
    }
    const inputs = [];
    (opts.fields || []).forEach((label) => {
      const i = document.createElement("input");
      i.type = "password";
      i.inputMode = opts.textKeyboard ? "text" : "numeric";
      i.autocomplete = "off";
      i.placeholder = label;
      i.style.cssText = "font-size:18px;padding:12px;border:1px solid #c4c6d0;border-radius:12px;" + (opts.textKeyboard ? "" : "letter-spacing:4px");
      card.appendChild(i);
      inputs.push(i);
    });
    const err = document.createElement("div");
    err.style.cssText = "color:#b3261e;font-size:13px;min-height:16px";
    card.appendChild(err);
    const row = document.createElement("div");
    row.style.cssText = "display:flex;gap:8px;justify-content:flex-end";
    const done = (v) => { wrap.remove(); resolve(v); };
    (opts.extra || []).forEach((x) => {
      const b = document.createElement("button");
      b.textContent = x.label;
      b.style.cssText = "border:0;background:none;color:#0b57d0;font-size:15px;padding:10px 14px;border-radius:20px";
      b.addEventListener("click", () => done(x.value));
      row.appendChild(b);
    });
    const ok = document.createElement("button");
    ok.textContent = opts.okLabel || "OK";
    ok.style.cssText = "border:0;background:#0b57d0;color:#fff;font-size:15px;padding:10px 20px;border-radius:20px";
    const submit = async () => {
      const vals = inputs.map((i) => i.value.trim());
      const msg = await opts.validate(vals);
      if (msg) { err.textContent = msg; inputs.forEach((i) => (i.value = "")); if (inputs[0]) inputs[0].focus(); return; }
      done(true);
    };
    ok.addEventListener("click", submit);
    inputs.forEach((i) => i.addEventListener("keydown", (e) => { if (e.key === "Enter") submit(); }));
    row.appendChild(ok);
    card.appendChild(row);
    wrap.appendChild(card);
    document.body.appendChild(wrap);
    if (inputs[0]) inputs[0].focus();
  });
}

async function lockSetNew() {
  return lockCard({
    title: "Set a code",
    text: "At least 4 digits. It will be asked every time this app opens.",
    fields: ["New code", "Repeat code"],
    okLabel: "Save",
    extra: opts_cancel(),
    validate: async (v) => {
      if (!/^[0-9]{4,12}$/.test(v[0])) return "Use 4 to 12 digits.";
      if (v[0] !== v[1]) return "The two codes are different.";
      const salt = Array.from(crypto.getRandomValues(new Uint8Array(8))).map((b) => b.toString(16).padStart(2, "0")).join("");
      localStorage.setItem(LOCK_KEY, JSON.stringify({ salt: salt, hash: await lockHash(v[0], salt) }));
      return "";
    },
  });
}
function opts_cancel() { return [{ label: "Cancel", value: false }]; }

async function lockAskCode(title) {
  const st = lockStored();
  if (!st) return true;
  return lockCard({
    title: title || "Enter your code",
    fields: ["Code"],
    okLabel: "Unlock",
    validate: async (v) => ((await lockHash(v[0], st.salt)) === st.hash ? "" : "Wrong code"),
  });
}

// Runs before the app starts: set-up offer on the first open, then the code on every open.
async function lockGate() {
  try {
    if (!window.crypto || !crypto.subtle) return; // very old browser: no lock
    const st = lockStored();
    if (st) {
      await lockAskCode("Enter your code");
      return;
    }
    if (!localStorage.getItem(LOCK_SKIP_KEY)) {
      const set = await lockCard({
        title: "Protect this app with a code?",
        text: "Pick a code now, or skip. You can set, change or remove it later in Settings.",
        fields: [],
        okLabel: "Set a code",
        extra: [{ label: "Skip", value: "skip" }],
        validate: async () => "",
      });
      if (set === "skip") { localStorage.setItem(LOCK_SKIP_KEY, "1"); return; }
      localStorage.setItem(LOCK_SKIP_KEY, "1");
      await lockSetNew();
    }
  } catch (e) {
    console.warn("lock skipped", e);
  }
}

// ---- Theme: System / Light / Dark (applies to the Google layouts; Classic is always dark) ----------------------------------------
const THEME_KEY = "flip_relay_theme";
function themeMode() {
  try { const t = localStorage.getItem(THEME_KEY); return t === "light" || t === "dark" ? t : "system"; } catch (e) { return "system"; }
}
function applyTheme() {
  const m = themeMode();
  document.body.classList.toggle("theme-light", m === "light");
  document.body.classList.toggle("theme-dark", m === "dark");
}
function addThemeSettingsButton() {
  const anchor = document.getElementById("disconnect-btn");
  if (!anchor || document.getElementById("theme-btn")) return;
  const b = document.createElement("button");
  b.id = "theme-btn";
  b.className = "settings-row";
  anchor.parentNode.insertBefore(b, anchor);
  const label = () => { const m = themeMode(); b.textContent = "Theme: " + (m === "light" ? "Light" : m === "dark" ? "Dark" : "System default") + " (tap to change)"; };
  label();
  b.addEventListener("click", () => {
    const next = { system: "light", light: "dark", dark: "system" }[themeMode()];
    try { localStorage.setItem(THEME_KEY, next); } catch (e) {}
    applyTheme();
    label();
  });
}

// Settings button: set / change / remove the code (the current code is needed to change or remove it).
function addLockSettingsButton() {
  const anchor = document.getElementById("disconnect-btn");
  if (!anchor || document.getElementById("app-lock-btn")) return;
  const b = document.createElement("button");
  b.id = "app-lock-btn";
  b.className = "settings-row";
  anchor.parentNode.insertBefore(b, anchor);
  const refresh = () => { b.textContent = lockStored() ? "App code: on (change or remove)" : "App code: off (set one)"; };
  refresh();
  b.addEventListener("click", async () => {
    if (!lockStored()) { await lockSetNew(); refresh(); return; }
    if (!(await lockAskCode("Enter the current code"))) return;
    const choice = await lockCard({
      title: "App code",
      text: "Change it or remove it?",
      fields: [],
      okLabel: "Change",
      extra: [{ label: "Remove", value: "remove" }, { label: "Cancel", value: false }],
      validate: async () => "",
    });
    if (choice === "remove") localStorage.removeItem(LOCK_KEY);
    else if (choice === true) await lockSetNew();
    refresh();
  });
}

configGate().then(lockGate).then(() => { init(); applyTheme(); addLockSettingsButton(); addThemeSettingsButton(); });

