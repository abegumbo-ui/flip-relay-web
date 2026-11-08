// Filled in at CI build time from the FIREBASE_DATABASE_URL /
// FIREBASE_DATABASE_SECRET GitHub Actions secrets -- these placeholders are
// what actually lives in source control (see .github/workflows/build.yml).
// The database address and key are NOT in this file: the build encrypts them with the site passphrase (ENC_CONFIG) and the
// browser decrypts them after the passphrase is typed once (then remembered on that device only).
let DATABASE_URL = "";
let DATABASE_SECRET = ""; // holds THIS page's own sign-in token (renewed every 40 minutes), never a master key
const ENC_CONFIG = "__ENC_CONFIG__";
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
    localStorage.setItem(CACHE_OK_PREFIX + roomId, "1");
  } catch (e) {
    // storage full or unavailable -- not fatal, just means history won't persist (and the next load takes the whole folder again)
    try { localStorage.removeItem(CACHE_OK_PREFIX + roomId); } catch (e2) {}
  }
}

// ---- downloading only what's new (the database bill).
// Every load and every stream (re)connect used to download the room's whole message folders. Once this page has them saved, it asks
// only for messages from a day before the newest one it has; deletions of older ones arrive through the trash streams instead.
const CACHE_OK_PREFIX = "flip_relay_cache_ok_";
const WINDOW_MARGIN_MS = 24 * 3600 * 1000;
let windowRefusedUntil = 0;
let trashStreams = [];

function newestSeen(direction) {
  let best = 0;
  const limit = Date.now() + 3600 * 1000;
  for (const m of messages) {
    if (m.direction !== direction || String(m.id).startsWith("local-")) continue;
    if (m.timestamp > best && m.timestamp < limit) best = m.timestamp;
  }
  return best;
}

/** Start of the recent-only window for a folder, or 0 = take the whole folder (nothing saved yet, or the query was refused). */
function windowSince(direction) {
  if (Date.now() < windowRefusedUntil) return 0;
  try { if (localStorage.getItem(CACHE_OK_PREFIX + roomId) !== "1") return 0; } catch (e) { return 0; }
  const s = newestSeen(direction);
  return s > 0 ? s - WINDOW_MARGIN_MS : 0;
}

function windowUrl(path, since, field) {
  return since > 0 ? roomUrl(path) + `&orderBy=%22${field || "timestamp"}%22&startAt=${since}` : roomUrl(path);
}

async function fetchFolder(path, since) {
  if (since > 0) {
    const r = await fetch(windowUrl(path, since));
    if (r.status !== 400) return r;
    windowRefusedUntil = Date.now() + 3600 * 1000; // no index for the query: whole folder for an hour
  }
  return fetch(roomUrl(path));
}

/** A message deleted elsewhere lands in the trash folder: drop it here. A trash record that disappears was restored (or emptied). */
function startTrashStreams() {
  for (const t of trashStreams) t.close();
  trashStreams = [];
  for (const [which, dir] of [["incoming", "in"], ["sent", "out"]]) {
    const seenSet = () => (dir === "in" ? seenIncomingKeys : seenSentKeys);
    const query = () => {
      const s = newestSeen(dir);
      return windowUrl(`deletedMessages/${which}`, (s > 0 ? s : Date.now()) - WINDOW_MARGIN_MS, "deletedAt");
    };
    trashStreams.push(openStream(`deletedMessages/${which}`, (key) => {
      const before = messages.length;
      messages = messages.filter((m) => !(m.direction === dir && m.id === key));
      seenSet().delete(key);
      return messages.length !== before;
    }, (key) => {
      fetch(roomUrl(`messages/${which}/${key}`)).then((r) => r.ok ? r.json() : null).then((data) => {
        if (!data) return;
        const changed = dir === "in" ? upsertIncoming(key, data) : upsertSent(key, data);
        if (changed) {
          saveCache();
          renderConversationList();
          if (currentChatNumber) renderChat(currentChatNumber);
        }
      }).catch(() => {});
      return false;
    }, () => {}, null, query));
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
async function renameGroup(key) {
  const n = await gmPrompt("Name this group:", groupNames[key] || "");
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
function showSourceOn() { try { return localStorage.getItem(SHOW_SOURCE_KEY) !== "0"; } catch (e) { return false; } }

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
  // tell the flip only when there was something unread from that person (not on every open)
  const last = messages.filter((m) => m.number === number && m.direction === "in").reduce((t, m) => Math.max(t, m.timestamp || 0), 0);
  if (last > (readMarkSent[number] || 0)) sendReadMark(number, readState[number]);
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
  if (number && mutedSet.has(number)) return; // muted (on any device)
  const title = data.contactName || number || "New message";
  const body = data.imageUrl ? "📷 Picture" : (data.attachmentType === "video" ? "🎥 Video"
      : data.attachmentType === "vcard" ? "👤 Contact" : (data.body || ""));
  try {
    const n = new Notification(title, { body, tag: "flip-relay-" + number });
    n.onclick = () => { if (window.flipDesktop) window.flipDesktop.show(); window.focus(); if (number) openChat(number); };
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
  if (location.hash === "#showreadby") { // hidden switch for this page only: a message's Info says who read it
    try {
      const on = localStorage.getItem("flip_relay_show_read_by") !== "1";
      localStorage.setItem("flip_relay_show_read_by", on ? "1" : "0");
      setTimeout(() => alert(on ? "Who read it: now shown in Message info on this page." : "Who read it: hidden on this page."), 500);
    } catch (e) { /* storage blocked */ }
    history.replaceState(null, "", location.pathname);
  }
  addGmHeader();
  addTabBars();
  setupTabletChrome();
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
  el("settings-back-btn").addEventListener("click", () => { if (tlSettingsBack()) return; if (settingsSectionOpen) openSettingsSection(null); else showScreen("conversations"); });
  el("disconnect-btn").addEventListener("click", onForgetClick);
  el("sync-log-btn").addEventListener("click", onSyncLogClick);
  el("layout-btn").addEventListener("click", onLayoutClick);
  el("phone-buttons-btn").addEventListener("click", openPhoneButtons);
  el("mark-all-read-btn").addEventListener("click", async () => { if (await gmConfirm("Mark every conversation as read, here and on the flip phone?")) await markAllRead(); });
  el("needs-reply-btn").addEventListener("click", showNeedsReply);
  const undoLabel = () => { el("undo-send-btn").textContent = "Undo send: " + (undoSendOn() ? "On (5 seconds to take a message back)" : "Off"); };
  undoLabel();
  el("undo-send-btn").addEventListener("click", () => { try { localStorage.setItem(UNDO_KEY, undoSendOn() ? "off" : "on"); } catch (e) { /* storage blocked */ } undoLabel(); });
  el("sync-btn").addEventListener("click", openSyncPanel);
  el("locate-btn").addEventListener("click", openLocatePanel);
  el("voicemail-btn").addEventListener("click", openVoicemailPanel);
  el("gm-fab").addEventListener("click", () => el("new-message-btn").click());
  applyLayout();
  el("calls-btn").addEventListener("click", onCallsClick);
  el("groups-btn").addEventListener("click", () => { groupsView = !groupsView; renderConversationList(); });
  el("calls-back-btn").addEventListener("click", () => goTab(groupsView ? "groups" : "chats"));
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
    const typed = await gmPrompt(have + "Add a number (leave empty when you are done):");
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

// ---------- start a chat, like the tablet: a "To" box, everyone you text with (search as you type), a typed number, and
// "Create group" only when group texts are in the same list as the chats ----------
const AV_COLORS = ["#1a73e8", "#e8710a", "#188038", "#d93025", "#9334e6", "#12b5cb", "#e52592", "#5f6368"];
function avatarFor(name, number) {
  let h = 0; for (const ch of String(number)) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  const letter = (name && /[A-Za-z]/.test(name[0])) ? name[0].toUpperCase() : "";
  return `<span class="tl-av" style="background:${AV_COLORS[h % AV_COLORS.length]}">${letter || svgIcon("person", 22)}</span>`;
}
function openNewChat() {
  injectTabletStyles();
  // "Create group" only where groups are: in the Chats list (Show groups in Messages), or straight away from the Groups tab
  const groupsHere = !groupsHidden() && groupsInMessages();
  const startInGroup = !groupsHidden() && !groupsInMessages() && currentTab === "groups";
  const ov = document.createElement("div");
  ov.className = "tl-nc";
  ov.innerHTML = `<header><button class="icon-btn" data-x="back" title="Back">&#8592;</button><h2 style="margin:0;font-weight:400" data-x="title">New conversation</h2></header>
    <div class="to"><span style="opacity:.7">To</span><input data-x="q" type="text" inputmode="text" autocomplete="off" placeholder="Type a name or phone number"></div>
    <div class="chips" data-x="chips"></div><div data-x="list"></div>`;
  document.body.appendChild(ov);
  const q = (k) => ov.querySelector(`[data-x="${k}"]`);
  const input = q("q");
  let groupMode = false;
  const picked = [];
  const close = () => ov.remove();
  q("back").onclick = () => { if (groupMode && !startInGroup) { groupMode = false; picked.length = 0; render(); } else close(); };
  // everyone this room texts with, most recent first (from every conversation, whichever tab this was opened from)
  const people = [];
  const seen = new Set();
  for (const c of conversationsByNumber()) {
    if (isMulti(c.number) || seen.has(c.number)) continue;
    seen.add(c.number);
    people.push({ number: c.number, name: displayName(c.number) || "" });
  }
  let goBtn = null;
  const finishGroup = async () => {
    if (picked.length < 2) { if (picked.length === 1) { close(); openChat(picked[0]); } return; }
    const mode = await tabletSheet("Recipients reply to", [
      { icon: "group", color: "#1a73e8", title: "Group", sub: "One shared conversation, everyone sees every reply", value: "g:" },
      { icon: "person", color: "#188038", title: "Just me", sub: "A mass text: each person gets it on their own, replies come only to you", value: "m:" },
    ]);
    if (!mode) return;
    close();
    openChat(multiKey(mode, picked));
  };
  const row = (iconHtml, title, sub, fn) => {
    const r = document.createElement("button");
    r.className = "tl-row";
    r.innerHTML = `${iconHtml}<span style="flex:1;min-width:0"><div class="tl-t"></div>${sub ? '<div class="tl-s"></div>' : ""}</span>`;
    r.querySelector(".tl-t").textContent = title;
    if (sub) r.querySelector(".tl-s").textContent = sub;
    r.onclick = fn;
    return r;
  };
  const circle = (icon, color) => `<span class="tl-av" style="background:${color}">${svgIcon(icon, 22)}</span>`;
  function render() {
    q("title").textContent = groupMode ? "New group" : "New conversation";
    const chips = q("chips");
    chips.innerHTML = "";
    for (const n of picked) {
      const c = document.createElement("span");
      c.className = "chip";
      c.textContent = (displayName(n) || n) + "  ×";
      c.onclick = () => { picked.splice(picked.indexOf(n), 1); render(); };
      chips.appendChild(c);
    }
    if (goBtn) { goBtn.remove(); goBtn = null; }
    if (groupMode && picked.length) {
      goBtn = document.createElement("button");
      goBtn.className = "go";
      goBtn.textContent = picked.length >= 2 ? "Next" : "Open chat";
      goBtn.onclick = finishGroup;
      ov.appendChild(goBtn);
    }
    const list = q("list");
    list.innerHTML = "";
    const text = input.value.trim();
    const digits = text.replace(/\D/g, "");
    const box = document.createElement("div");
    // a typed number
    if (digits.length >= 3) {
      const n = normalizeNumber(text);
      if (n) box.appendChild(row(circle("dialpad", "#5f6368"), (groupMode ? "Add " : "Send to ") + text, null, () => {
        if (groupMode) { if (!picked.includes(n)) picked.push(n); input.value = ""; render(); input.focus(); }
        else { close(); openChat(n); }
      }));
    }
    if (!groupMode && !text) {
      if (groupsHere) box.appendChild(row(circle("group", "#1a73e8"), "Create group", null, () => { groupMode = true; render(); input.focus(); }));
      if (navigator.contacts && navigator.contacts.select) box.appendChild(row(circle("person", "#188038"), "Choose from this device's contacts", null, async () => {
        try {
          const [c] = await navigator.contacts.select(["name", "tel"], { multiple: false });
          const n = c && normalizeNumber((c.tel && c.tel[0]) || "");
          if (n) { close(); openChat(n); }
        } catch (e) { /* cancelled */ }
      }));
    }
    if (box.children.length) { box.className = "tl-group"; list.appendChild(box); }
    const lower = text.toLowerCase();
    const match = people.filter((p) => !text || p.name.toLowerCase().includes(lower) || (digits && p.number.includes(digits)));
    if (match.length) {
      const hd = document.createElement("div");
      hd.className = "hd";
      hd.textContent = text ? "Matches" : "People you text";
      list.appendChild(hd);
      const g = document.createElement("div");
      g.className = "tl-group";
      for (const p of match.slice(0, 200)) {
        const isOn = picked.includes(p.number);
        g.appendChild(row(avatarFor(p.name, p.number), (isOn ? "✓ " : "") + (p.name || p.number), p.name ? p.number : null, () => {
          if (groupMode) { if (isOn) picked.splice(picked.indexOf(p.number), 1); else picked.push(p.number); input.value = ""; render(); }
          else { close(); openChat(p.number); }
        }));
      }
      list.appendChild(g);
    } else if (text && digits.length < 3) {
      const e = document.createElement("p");
      e.className = "settings-hint";
      e.style.margin = "16px 24px";
      e.textContent = "Nobody by that name. Type their phone number instead.";
      list.appendChild(e);
    }
  }
  if (startInGroup) groupMode = true;
  input.addEventListener("input", render);
  input.addEventListener("keydown", (e) => {
    if (e.key !== "Enter") return;
    const first = ov.querySelector(".tl-row");
    if (first) first.click();
  });
  render();
  setTimeout(() => input.focus(), 50);
}

// A sheet near the top with big rows (icon in a circle, title, line under it). Resolves with the chosen value, or null.
function tabletSheet(title, options) {
  injectTabletStyles();
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "tl-sheet-bg";
    bg.innerHTML = `<div class="tl-sheet"><div style="font-size:20px;margin:4px 6px 12px"></div><div></div></div>`;
    bg.querySelector(".tl-sheet > div").textContent = title;
    const box = bg.querySelector(".tl-sheet > div:last-child");
    const done = (v) => { bg.remove(); resolve(v); };
    for (const o of options) {
      const r = document.createElement("button");
      r.className = "tl-row";
      r.style.borderRadius = "16px";
      r.innerHTML = `<span class="tl-av" style="background:${o.color}">${svgIcon(o.icon, 22)}</span><span style="flex:1;min-width:0"><div class="tl-t"></div><div class="tl-s"></div></span>`;
      r.querySelector(".tl-t").textContent = o.title;
      r.querySelector(".tl-s").textContent = o.sub || "";
      r.onclick = () => done(o.value);
      box.appendChild(r);
    }
    bg.onclick = (e) => { if (e.target === bg) done(null); };
    document.body.appendChild(bg);
  });
}

// The attach picker: one row of round buttons, like the tablet (Gallery, Camera, Video, Contact).
function attachPicker() {
  injectTabletStyles();
  return new Promise((resolve) => {
    const bg = document.createElement("div");
    bg.className = "tl-sheet-bg";
    bg.innerHTML = `<div class="tl-sheet"><div style="font-size:18px;margin:2px 6px 10px">Attach</div><div class="tl-grid"></div></div>`;
    const grid = bg.querySelector(".tl-grid");
    const done = (v) => { bg.remove(); resolve(v); };
    for (const [value, icon, color, label] of [["gallery", "photo", "#1a73e8", "Gallery"], ["camera", "camera", "#e8710a", "Camera"], ["video", "video", "#d93025", "Video"], ["contact", "person", "#188038", "Contact"]]) {
      const t = document.createElement("button");
      t.className = "tl-tile";
      t.innerHTML = `<span class="c" style="background:${color}">${svgIcon(icon, 26)}</span><span></span>`;
      t.lastElementChild.textContent = label;
      t.onclick = () => done(value);
      grid.appendChild(t);
    }
    bg.onclick = (e) => { if (e.target === bg) done(null); };
    document.body.appendChild(bg);
  });
}

async function onNewMessageClick() {
  openNewChat();
}

async function onNewMessageClickOld() {
  {
    const choice0 = await showActionSheet("New Message", [
      { label: "⌨️ Type a number", value: "type" },
      { label: "👥 Create group", value: "group" },
      ...(navigator.contacts && navigator.contacts.select ? [{ label: "👤 Choose from Contacts", value: "contacts" }] : []),
    ]);
    if (choice0 === "group") { await createGroupFlow(); return; }
    if (choice0 === null) return;
    if (choice0 === "type") {
      const number0 = await gmPrompt("Phone number?");
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
  const number = await gmPrompt("Phone number?");
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
      fillSheetOption(btn, opt.label);
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
  const pick = await attachPicker();
  if (!pick) return;

  if (pick === "contact") {
    await attachContact();
    return;
  }
  // Gallery: pictures or videos from the device; Camera: take a picture now; Video: record or pick a video
  const type = pick === "video" ? "video" : "photo";
  const live = pick === "camera";
  const picked = await pickFile({
    accept: pick === "gallery" ? "image/*,video/*" : type === "photo" ? "image/*" : "video/*",
    capture: live ? "environment" : null,
    multiple: !live,
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
    setPendingAttachment(file, (file.type || "").startsWith("video/") ? "video" : type, null);
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
  const name = await gmPrompt("Contact name?");
  if (!name) return;
  const tel = await gmPrompt("Phone number?");
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
        : kind === "audio" ? "🎤 Voice message attached" : "👤 " + (name || "Contact");
    el("attachment-label").classList.remove("hidden");
  }
  if (stagedAttachments.length) { // more than one: show how many (the X takes them all off again)
    el("attachment-label").textContent = "\uD83D\uDCCE " + (stagedAttachments.length + 1) + " attachments in this message";
    el("attachment-label").classList.remove("hidden");
  }
  el("attachment-preview").classList.remove("hidden");
}

function randHex16() { const b = new Uint8Array(8); crypto.getRandomValues(b); return Array.from(b).map((x) => x.toString(16).padStart(2, "0")).join(""); }
// ---------- this page's own Firebase identity (anonymous sign-in) ----------
const FB_API_KEY = "AIzaSyCphMISERkBe6ajJIJDJAwQ0rmyrQzw7aA"; // Firebase's public project identifier, not a secret
let fbUid = null, fbRefresh = null, fbTimer = null;
async function fbSignIn() {
  try { const saved = JSON.parse(localStorage.getItem("flip_relay_web_fbauth") || "null"); if (saved) fbRefresh = saved.refresh; } catch (e) { /* none */ }
  let j;
  if (fbRefresh) {
    const r = await fetch("https://securetoken.googleapis.com/v1/token?key=" + FB_API_KEY, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: "grant_type=refresh_token&refresh_token=" + encodeURIComponent(fbRefresh) });
    if (r.ok) { const d = await r.json(); j = { idToken: d.id_token, refreshToken: d.refresh_token, localId: d.user_id }; }
  }
  if (!j) {
    const r = await fetch("https://identitytoolkit.googleapis.com/v1/accounts:signUp?key=" + FB_API_KEY, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ returnSecureToken: true }) });
    if (!r.ok) throw new Error("sign-in failed (HTTP " + r.status + ")");
    j = await r.json();
  }
  DATABASE_SECRET = j.idToken; fbUid = j.localId; fbRefresh = j.refreshToken;
  try { localStorage.setItem("flip_relay_web_fbauth", JSON.stringify({ refresh: fbRefresh, uid: fbUid })); } catch (e) { /* storage blocked */ }
  if (!fbTimer) fbTimer = setInterval(() => { fbSignIn().catch((e) => logDebug("token renewal failed: " + e)); }, 40 * 60 * 1000);
  return fbUid;
}
const joinedThisLoad = new Set();
// Puts this page on the room's guest list with the room's long key (a page without the key has to scan or type it).
async function joinRoomWeb(room) {
  if (!fbUid) await fbSignIn();
  const done = "flip_relay_web_joined_" + room;
  // joined again on every page load (one small write): if this page was removed from the room on the dashboard, it gets back in
  // with the room key instead of being refused everywhere while it thinks all is well
  let wasJoined = false;
  try { wasJoined = !!localStorage.getItem(done); } catch (e) { /* storage blocked */ }
  if (!joinedThisLoad.has(room)) {
    let key = null;
    try { key = localStorage.getItem(roomKeyStore(room)); } catch (e) { /* storage blocked */ }
    if (!key) {
      if (!wasJoined) return false; // never joined and no key: it has to scan or type the code
    } else {
      const r = await fetch(`${DATABASE_URL}/rooms/${room}/members/${fbUid}.json?auth=${encodeURIComponent(DATABASE_SECRET)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify(key) });
      if (!r.ok && !wasJoined) return false;
      if (r.ok) try { localStorage.setItem(done, "1"); } catch (e) { /* storage blocked */ }
    }
    joinedThisLoad.add(room);
  }
  await reportBuildWeb(room);
  return true;
}
// Tells the database which app and build this page is (rooms/<room>/builds/<uid>), so the database rules can refuse builds older than
// the owner's minimum (admin/minBuild). Once per build; raise WEB_BUILD whenever the page must be reloaded by everyone.
const WEB_BUILD = 1;
async function reportBuildWeb(room) {
  const mark = `${room}:${fbUid}:${WEB_BUILD}`;
  try { if (localStorage.getItem("flip_relay_web_build") === mark) return; } catch (e) { /* storage blocked */ }
  try {
    const r = await fetch(`${DATABASE_URL}/rooms/${room}/builds/${fbUid}.json?auth=${encodeURIComponent(DATABASE_SECRET)}`, { method: "PUT", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ k: "web", b: WEB_BUILD }) });
    if (r.ok) { try { localStorage.setItem("flip_relay_web_build", mark); } catch (e) { /* storage blocked */ } }
  } catch (e) { logDebug("build report failed: " + e); }
}

// ---------- the long pairing key (16 characters): typed instead of the short code; picked up quietly for existing rooms ----------
async function sha256Hex16(text) {
  const d = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(d)).slice(0, 8).map((b) => b.toString(16).padStart(2, "0")).join("");
}
async function rootRead(path) {
  const r = await fetch(`${DATABASE_URL}/${path}.json?auth=${encodeURIComponent(DATABASE_SECRET)}`);
  if (!r.ok) return null;
  return r.json();
}
function roomKeyStore(room) { return "flip_relay_web_roomkey_" + room; }
// Typed text -> { room, key }: "FR1:ROOM:KEY", a 16-character key (dashes and spaces allowed), or a short code
function parsePairingText(raw) {
  const s = (raw || "").trim().toUpperCase();
  if (s.startsWith("FR1:")) { const p = s.split(":"); if (p.length >= 3) return { room: p[1], key: p[2].replace(/-/g, "") }; }
  const compact = s.replace(/[-\s]/g, "");
  return compact.length === 16 || compact.length === 12 ? { room: null, key: compact } : { room: compact, key: null };
}
async function resolvePairing(raw) {
  const p = parsePairingText(raw);
  if (!p.key) return null;
  if (!fbUid) await fbSignIn();
  const room = p.room || await rootRead("keyIndex/" + await sha256Hex16(p.key));
  if (typeof room !== "string" || !room) return null;
  try { localStorage.setItem(roomKeyStore(room), p.key); } catch (e) { /* storage blocked */ }
  try { localStorage.removeItem("flip_relay_web_joined_" + room); } catch (e) { /* storage blocked */ }
  return (await joinRoomWeb(room)) ? room : null; // joining only works with the right key
}

async function onConnectClick() {
  const typed = el("code-input").value;
  if (!parsePairingText(typed).key) { el("pairing-error").textContent = "Type the 16-character code from the flip phone's Pairing Code screen."; return; }
  el("pairing-error").textContent = "Checking the code...";
  const room = await resolvePairing(typed);
  if (!room) { el("pairing-error").textContent = "That 16-character code is not right. Check it against the flip phone's Pairing Code screen."; return; }
  el("code-input").value = room;
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
  try { await fbSignIn(); await joinRoomWeb(code); } catch (e) { logDebug("sign-in/join problem: " + e); }
  clearDebugLog();
  setPairingProgress(true, "Connecting to " + code + "...");

  try {
    loadCache(); // what this page already has decides how much to download
    const [incomingRes, sentRes, scheduledRes] = await Promise.all([
      fetchFolder("messages/incoming", windowSince("in")),
      fetchFolder("messages/sent", windowSince("out")),
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

async function onForgetClick() {
  if (!await gmConfirm("Disconnect this page? You'll need the pairing code again to reconnect.")) return;
  if (incomingStream) incomingStream.close();
  if (sentStream) sentStream.close();
  if (scheduledStream) scheduledStream.close();
  for (const t of trashStreams) t.close();
  trashStreams = [];
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
  if (m === "tablet" || m === "phone") return m;
  return window.innerWidth >= 600 ? "tablet" : "phone";
}

function applyLayout() {
  const l = effectiveLayout();
  document.body.classList.toggle("gm", l !== "classic");
  document.body.classList.toggle("gm-tablet", l === "tablet");
  document.body.classList.toggle("gm-phone", l === "phone");
  const fab = el("gm-fab");
  if (fab) fab.classList.toggle("hidden", l === "classic" || currentScreenName !== "conversations" && !(l === "tablet" && currentScreenName === "chat"));
  const btn = document.getElementById("layout-btn");
  if (btn) btn.textContent = "Layout: " + (LAYOUT_LABELS[storedLayout()] || LAYOUT_LABELS.auto);
}

async function onLayoutClick() {
  const choice = await showActionSheet("Layout", [
    { label: "Automatic", value: "auto" },
    { label: "Google Messages \u2014 tablet (side by side)", value: "tablet" },
    { label: "Google Messages \u2014 phone (one screen at a time)", value: "phone" },
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
  // the database only lets joined devices (or the admin key) into a room, so every room request carries the key this page already holds
  return `${DATABASE_URL}/rooms/${roomId}/${path}.json?auth=${encodeURIComponent(DATABASE_SECRET)}`;
}

function startStreams() {
  incomingStream = openStream("messages/incoming", upsertIncoming, (key) => {
    const before = messages.length;
    messages = messages.filter((m) => !(m.direction === "in" && m.id === key));
    seenIncomingKeys.delete(key);
    return messages.length !== before;
  }, (connected) => { incomingConnected = connected; updateConnectionStatus(); }, notifyIncoming,
  () => windowUrl("messages/incoming", windowSince("in")));

  sentStream = openStream("messages/sent", upsertSent, (key) => {
    const before = messages.length;
    messages = messages.filter((m) => !(m.direction === "out" && m.id === key));
    seenSentKeys.delete(key);
    return messages.length !== before;
  }, (connected) => { sentConnected = connected; updateConnectionStatus(); }, null,
  () => windowUrl("messages/sent", windowSince("out")));

  startTrashStreams();

  scheduledStream = openStream("messages/scheduled", upsertScheduled, (key) => {
    const before = messages.length;
    messages = messages.filter((m) => !(m.direction === "scheduled" && m.id === key));
    seenScheduledKeys.delete(key);
    return messages.length !== before;
  }, (connected) => { scheduledConnected = connected; updateConnectionStatus(); });

  startPhoneHeartbeatPoll();
  loadMuted();
  startAutoBanner();
  pollVoicemailDot();
}

// ---------- banner while "I'm busy" or automatic replies are on (set on a tablet, shared through the room; shown here, never sent from here) ----------
let autoBannerTimer = 0;
function startAutoBanner() {
  clearInterval(autoBannerTimer);
  const tick = async () => {
    if (!roomId || document.hidden) return;
    let busy, rules;
    try {
      const [a, b] = await Promise.all([fetch(roomUrl("busyMode")), fetch(roomUrl("personRules"))]);
      if (!a.ok && !b.ok) return;
      busy = a.ok ? await a.json() : null;
      rules = b.ok ? await b.json() : null;
    } catch (e) { return; }
    const ban = el("auto-banner");
    if (!ban) return;
    const now = Date.now();
    let text = "";
    if (busy && busy.on && (!busy.endsAt || busy.endsAt > now)) {
      const until = busy.endsAt > now ? " until " + new Date(busy.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
      text = `I'm busy is ON${until} - texts are answered automatically${busy.by ? " (turned on on " + busy.by + ")" : ""}. Tap to turn it off.`;
      ban.onclick = async () => {
        if (!await gmConfirm("Turn I'm busy off on every tablet?")) return;
        try {
          const r = await fetch(roomUrl("busyMode"), { method: "PUT", body: JSON.stringify(Object.assign({}, busy, { on: false, by: "web page", at: Date.now() })) });
          if (!r.ok) throw new Error(r.status);
          ban.classList.add("hidden");
        } catch (e) { alert("Not changed: no connection."); }
      };
    } else if (rules) {
      const people = Object.values(rules).filter((r) => r && (r.t || r.d || r.m)).length;
      if (people) text = `Automatic replies are on for ${people} ${people === 1 ? "person" : "people"} (set on a tablet).`;
      ban.onclick = null;
    }
    ban.textContent = text;
    ban.classList.toggle("hidden", !text);
  };
  tick();
  autoBannerTimer = setInterval(tick, 15000);
}

// ---------- muted conversations: shared with the flip phone and the tablets (rooms/<room>/muted/<number> = true) ----------
let mutedSet = new Set();
async function loadMuted() {
  try {
    const r = await fetch(roomUrl("muted"));
    if (r.ok) mutedSet = new Set(Object.keys((await r.json()) || {}));
  } catch (e) { /* offline: keep what we had */ }
}
async function toggleMuted(number) {
  const want = !mutedSet.has(number);
  try {
    const r = await fetch(roomUrl(`muted/${number}`), want ? { method: "PUT", body: "true" } : { method: "DELETE" });
    if (!r.ok) throw new Error(r.status);
    if (want) mutedSet.add(number); else mutedSet.delete(number);
    renderConversationList();
  } catch (e) { alert("Not changed: no connection. Try again."); }
}

// ---------- read marks: tell the flip phone a conversation was read here, so it is marked read there too ----------
const readMarkSent = {};
function sendReadMark(number, ts) {
  if (!roomId || !number || (readMarkSent[number] || 0) >= ts) return;
  readMarkSent[number] = ts;
  fetch(roomUrl(`readMarks/${number}`), { method: "PUT", body: JSON.stringify(ts) }).catch(() => { readMarkSent[number] = 0; });
  putReadBy([number], ts);
}
async function markAllRead() {
  const now = Date.now(), patch = {};
  for (const c of filteredConversations()) { readState[c.number] = now; patch[c.number] = now; readMarkSent[c.number] = now; }
  saveReadState();
  renderConversationList();
  try { await fetch(roomUrl("readMarks"), { method: "PATCH", body: JSON.stringify(patch) }); } catch (e) { /* the flip catches up next time */ }
  putReadBy(Object.keys(patch), now);
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
      phoneSsidSeen = data && typeof data.ssid === "string" ? data.ssid : "";
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

// The flip phone at a glance, in a line at the top of the web page (the tablet has its own round card for this).
let phoneSsidSeen = "";
let lastFlip = null;
function updateFlipStrip(connected, batteryPercent, network, charging) {
  lastFlip = { connected, batteryPercent, network, charging };
  let s = document.getElementById("flip-strip");
  if (!s) {
    const tabs = document.querySelector("#screen-conversations .tl-dock");
    if (!tabs) return;
    s = document.createElement("div");
    s.id = "flip-strip";
    s.style.cursor = "pointer";
    s.title = "Flip phone and sync";
    s.onclick = () => { onSettingsClick(); openSettingsSection("phone"); };
    tabs.after(s);
  }
  const parts = ["Flip phone: " + (connected ? "Connected" : "Not connected")];
  if (connected) {
    if (network && network.wifi) parts.push("Wi-Fi" + (phoneSsidSeen ? " " + phoneSsidSeen : ""));
    else if (network && network.cellular) parts.push("Mobile data");
    else if (network) parts.push("No Wi-Fi or data");
    if (batteryPercent != null) parts.push("Battery " + batteryPercent + "%" + (charging ? ", charging" : ""));
  }
  s.textContent = parts.join("  ·  ");
  s.style.color = !connected || (batteryPercent != null && batteryPercent <= 20 && !charging) ? "var(--gm-red,#d93025)" : "";
}

function updatePhoneStatus(connected, batteryPercent, network, charging) {
  updateFlipStrip(connected, batteryPercent, network, charging);
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

function openStream(path, upsertFn, deleteFn, onConnectedChange, onSingleItemUpserted, urlFn) {
  let es = null;
  let lastEventAt = Date.now();
  const bump = () => { lastEventAt = Date.now(); };

  function connect() {
    const url = urlFn ? urlFn() : roomUrl(path);
    const windowed = url.includes("&orderBy=");
    es = new EventSource(url);

    es.addEventListener("open", () => { bump(); onConnectedChange(true); });
    es.addEventListener("error", () => {
      onConnectedChange(false);
      // a refused query closes the stream for good: take the whole folder for an hour instead of retrying the same query
      if (windowed && es.readyState === EventSource.CLOSED) windowRefusedUntil = Date.now() + 3600 * 1000;
    });
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
  // its caption: the phone writes its own caption text for media. When several pictures / videos go out together, the one that finishes
  // first belongs to the copy added first, not the one closest in time: the same uploaded file URL is the exact match, otherwise the oldest wins.
  const recKind = data.imageUrl ? "picture" : (data.attachmentType || null);
  const recUrl = data.imageUrl || data.attachmentUrl || null;
  let localIdx = -1, bestGap = Infinity, bestOldest = Infinity, bestExact = false;
  messages.forEach((m, i) => {
    if (m.direction !== "out" || !m.id.startsWith("local-") || m.number !== number) return;
    const gap = Math.abs(m.timestamp - timestamp);
    const exact = !!(recUrl && m.uploadUrl && m.uploadUrl === recUrl);
    if (gap >= 120000 && !exact) return;
    const echoKind = m.attachmentKind || (m.imageUrl ? "picture" : null);
    const mediaSame = !!(recKind && recKind === (echoKind === "photo" ? "picture" : echoKind));
    const same = exact || m.body === body || mediaSame;
    if (!same || bestExact) return;
    if (exact) { bestExact = true; localIdx = i; }
    else if (mediaSame) { if (m.timestamp < bestOldest) { bestOldest = m.timestamp; localIdx = i; } }
    else if (bestOldest === Infinity && gap < bestGap) { bestGap = gap; localIdx = i; }
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

// Pictures are shrunk before they go out, like the tablet app and the phone do: at most 1280 px on the long side, saved as a JPEG at 80%
// and stepped down until it is about 300 KB or less (a flip phone's picture message has to stay small). Falls back to the original.
async function compressImage(file) {
  try {
    if (!file || !/^image\//.test(file.type || "image/jpeg")) return file;
    const bmp = await createImageBitmap(file, { imageOrientation: "from-image" });
    const MAX = 1280;
    const scale = Math.min(1, MAX / Math.max(bmp.width, bmp.height));
    const w = Math.max(1, Math.round(bmp.width * scale)), h = Math.max(1, Math.round(bmp.height * scale));
    const canvas = document.createElement("canvas");
    canvas.width = w;
    canvas.height = h;
    const ctx = canvas.getContext("2d");
    ctx.fillStyle = "#ffffff"; // transparent PNG / GIF areas become white in a JPEG
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(bmp, 0, 0, w, h);
    if (bmp.close) bmp.close();
    let best = null;
    for (const q of [0.8, 0.7, 0.6, 0.5]) {
      best = await new Promise((res) => canvas.toBlob(res, "image/jpeg", q));
      if (best && best.size <= 300000) break;
    }
    if (!best) return file;
    if (scale === 1 && /jpeg/.test(file.type || "") && file.size <= best.size) return file; // already small: keep it as it is
    return best;
  } catch (e) {
    return file;
  }
}

// Uploads straight from the browser to Firebase Storage, same REST API the
// phone's FirebaseStorageClient uses -- no server-side code needed.
async function uploadToStorage(file, path) {
  const encodedPath = encodeURIComponent(path);
  const res = await fetch(
    `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o?uploadType=media&name=${encodedPath}`,
    { method: "POST", headers: { "Content-Type": file.type || "image/jpeg", ...(fbUid && DATABASE_SECRET ? { Authorization: "Firebase " + DATABASE_SECRET } : {}) }, body: file }
  );
  if (!res.ok) throw new Error("Storage upload failed: HTTP " + res.status);
  return `https://firebasestorage.googleapis.com/v0/b/${STORAGE_BUCKET}/o/${encodedPath}?alt=media`;
}

// Everything added to this message goes out one after the other, the typed text with the last one.
let stagedAttachments = [];
let lastSendTs = 0;

// ---------- undo send: a message waits 5 seconds with an Undo button before it goes out (on by default, like the tablet) ----------
const UNDO_KEY = "flip_relay_undo_send";
function undoSendOn() { try { return localStorage.getItem(UNDO_KEY) !== "off"; } catch (e) { return true; } }
function undoBar(text) {
  return new Promise((resolve) => {
    const bar = document.createElement("div");
    bar.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(84px + env(safe-area-inset-bottom,0px));z-index:70;display:flex;gap:16px;align-items:center;padding:12px 16px;border-radius:14px;background:#323232;color:#fff;box-shadow:0 4px 16px rgba(0,0,0,.3);max-width:calc(100vw - 32px)";
    bar.innerHTML = `<span></span><button style="background:none;border:0;color:#8ab4f8;font-weight:600;font-size:15px;cursor:pointer">Undo</button>`;
    bar.firstElementChild.textContent = text;
    document.body.appendChild(bar);
    const t = setTimeout(() => { bar.remove(); resolve(true); }, 5000);
    bar.querySelector("button").onclick = () => { clearTimeout(t); bar.remove(); resolve(false); };
  });
}

// ---------- needs a reply: conversations whose last message came in and was not answered ----------
async function showNeedsReply() {
  const list = filteredConversations().filter((c) => c.last && c.last.direction === "in" && !isMulti(c.number)).slice(0, 40);
  if (!list.length) { await showActionSheet("Needs a reply", [{ label: "Nothing waiting for a reply", value: "" }]); return; }
  const pick = await showActionSheet("Needs a reply", list.map((c) => ({ label: `${displayName(c.number) || c.number} · ${agoText(c.last.timestamp || 0)}`, value: c.number })));
  if (pick) openChat(pick);
}

async function onSendClick() {
  const input = el("compose-input");
  const rawBody = input.value.trim();
  const items = stagedAttachments.slice();
  if (pendingAttachmentFile) items.push({ file: pendingAttachmentFile, kind: pendingAttachmentKind, name: pendingAttachmentName });
  if (!rawBody && !items.length) { startVoiceRecording(); return; } // nothing to send: the round button records a voice message
  if (!currentChatNumber) return;
  stagedAttachments = [];
  input.value = "";
  clearAttachment();
  if (undoSendOn()) { // 5 seconds to take it back (Settings > Undo send)
    const to = currentChatNumber;
    const sent = await undoBar(items.length ? "Sending " + items.length + " attachment" + (items.length === 1 ? "" : "s") + "..." : "Sending...");
    if (!sent) {
      if (currentChatNumber === to) input.value = rawBody;
      if (items.length) alert("Not sent. Attach the picture or file again to send it.");
      return;
    }
    if (currentChatNumber !== to) { const keep = currentChatNumber; currentChatNumber = to; try { await sendAll(rawBody, items); } finally { currentChatNumber = keep; } return; }
  }
  await sendAll(rawBody, items);
}

async function sendAll(rawBody, items) {
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
  const label = kind === "video" ? "🎥 Video" : kind === "audio" ? "🎤 Voice message" : kind === "contact" ? "👤 " + (attachmentName || "Contact") : null;
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
    attachmentUrl: kind === "audio" ? (() => { const u = URL.createObjectURL(file); amrBlobUrls.add(u); return u; })() : null,
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
      imagePath = `attachments/${roomId}/${timestamp}-${randHex16()}.jpg`;
      imageUrl = await uploadToStorage(await compressImage(file), imagePath);
      msg.uploadUrl = imageUrl;
    } else if (kind === "video" || kind === "contact" || kind === "audio") {
      if (file.size > 60 * 1024 * 1024) throw new Error("Attachment too large");
      attachmentType = kind === "video" ? "video" : kind === "audio" ? "audio" : "vcard";
      const ext = kind === "video" ? (file.name.split(".").pop() || "mp4") : kind === "audio" ? "amr" : "vcf";
      const path = `attachments/${roomId}/${timestamp}-${randHex16()}.${ext}`;
      attachmentUrl = await uploadToStorage(file, path);
      msg.uploadUrl = attachmentUrl;
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
  tlMessageMenu(m);
}

// Saves a picture / video / voice message to the browser's Downloads. A web page cannot pick a folder, so the file name starts with "Messages".
async function saveMessageMedia(m) {
  const url = m.imageUrl || m.attachmentUrl;
  if (!url) return;
  try {
    const res = await fetch(url);
    if (!res.ok) throw new Error("HTTP " + res.status);
    const blob = await res.blob();
    const kind = m.imageUrl ? "Picture" : m.attachmentKind === "video" ? "Video" : m.attachmentKind === "audio" ? "Voice message" : "Attachment";
    const t = blob.type || "";
    const ext = t.includes("jpeg") ? "jpg" : t.includes("png") ? "png" : t.includes("gif") ? "gif" : t.includes("mp4") ? "mp4" : t.includes("mpeg") ? "mp3" : t.includes("amr") ? "amr" : t.includes("vcard") ? "vcf" : (m.imageUrl ? "jpg" : "bin");
    const d = new Date(m.timestamp || Date.now());
    const pad = (n) => String(n).padStart(2, "0");
    const stamp = d.getFullYear() + "-" + pad(d.getMonth() + 1) + "-" + pad(d.getDate()) + " " + pad(d.getHours()) + pad(d.getMinutes());
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "Messages - " + kind + " " + stamp + "." + ext;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 10000);
  } catch (e) {
    alert("Could not save it: the file is no longer available.");
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
  // "who read it" shows only on a page where it was switched on (open the page once with #showreadby); every page records it
  let showReadBy = false;
  try { showReadBy = localStorage.getItem("flip_relay_show_read_by") === "1"; } catch (e) { /* storage blocked */ }
  if (m.direction !== "in" || !showReadBy) { alert(lines.join("\n")); return; }
  // a received message: who read it (rooms/<room>/readBy/<number>); none of the tablets or web pages = read on the flip phone
  readByLine(m).then((line) => alert([line, ...lines].join("\n")));
}

async function readByLine(m) {
  let o;
  try {
    const r = await fetch(roomUrl(`readBy/${m.number}`));
    if (!r.ok) return "Read: could not check (no connection)";
    o = (await r.json()) || {};
  } catch (e) { return "Read: could not check (no connection)"; }
  const fmt = (t) => new Date(t).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });
  const who = Object.values(o).filter((d) => d && (d.at || 0) >= (m.timestamp || 0)).sort((a, b) => a.at - b.at)
    .map((d) => (d.n || "a device") + (d.k === "web" ? "" : " (tablet)") + " at " + fmt(d.at));
  if (who.length) return "Read on: " + who.join(", ");
  if (phoneUnread) {
    const n = phoneUnread[m.number] || 0;
    return n > 0 ? "Not read yet" : "Read on the flip phone";
  }
  return "Read: not known yet";
}

// this page in the "who read it" list (rooms/<room>/readBy/<number>/<this page's id>)
function readByName() {
  const ua = navigator.userAgent || "";
  const os = /Windows/.test(ua) ? "Windows" : /Mac OS/.test(ua) ? "Mac" : /Android/.test(ua) ? "Android" : /iPhone|iPad/.test(ua) ? "iPhone" : /Linux/.test(ua) ? "Linux" : "";
  return "Web page" + (os ? " (" + os + ")" : "");
}
function putReadBy(numbers, ts) {
  if (!roomId || !fbUid || !numbers.length) return;
  const patch = {};
  for (const n of numbers) if (n && !/[.#$\[\]]/.test(n)) patch[`${n}/${fbUid}`] = { n: readByName(), k: "web", at: ts };
  fetch(roomUrl("readBy"), { method: "PATCH", body: JSON.stringify(patch) }).catch(() => { /* best effort */ });
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
  if (!await gmConfirm(`Delete ${n} message${n === 1 ? "" : "s"}? This can be restored later from Settings within 30 days.`)) return;
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
  if (!await gmConfirm("Ask the phone to re-check everything against its real messages right now, instead of"
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
  addLockSettingsButton();
  addThemeSettingsButton();
  organizeSettings();
  openSettingsSection(null);
  loadDeletedMessages();
}

/** The phone's recent HistoricalSyncer.syncNow() history -- see the phone's own SyncLog.java. Read-only, so any pick just closes it. */
// Settings > Flip phone buttons: the flip's home-screen button shortcuts (its accessibility service), the same as the tablet's screen.
// rooms/<room>/buttons/config {on, keys, at} is applied on the flip within seconds; buttons/state is what the flip reports;
// buttons/disable turns the accessibility service off (three confirmations; only a person on the flip can turn it back on).
const PHONE_BUTTONS = [["DPAD_UP", "D-pad Up"], ["BACK", "Clear (C)"], ["SOFT_LEFT", "Left soft key"], ["SOFT_RIGHT", "Right soft key"], ["CALL", "Send/Call"], ["SPEAKER_IN", "Mic/voice (press and hold)"]];
const PHONE_BUTTONS_DEFAULT = ["DPAD_UP", "BACK", "SOFT_RIGHT", "SPEAKER_IN"];
function openPhoneButtons() {
  const pp = openPanel("Flip phone buttons");
  const ov = pp.body;
  ov.innerHTML = `
    <p class="settings-hint">On the flip phone's home screen, these buttons open Message+. Turn each one on or off here; the flip follows within a few seconds.</p>
    <div style="border-radius:20px;padding:14px 18px;margin:12px 0;background:var(--gm-card,rgba(127,127,127,.12))"><div class="settings-hint" style="margin:0">Status on the flip</div><div data-x="state" style="font-size:18px;font-weight:600">Checking...</div></div>
    <div data-x="switches" style="border-radius:20px;padding:6px 18px;margin:12px 0;background:var(--gm-card,rgba(127,127,127,.12))"></div>
    <div style="border-radius:20px;padding:14px 18px;margin:12px 0;background:var(--gm-card,rgba(127,127,127,.12))"><h3 style="margin:0 0 6px">Troubleshooting</h3>
      <p class="settings-hint">"Paused: Message+ is not the default texting app" - turn on "Work even if Message+ is not the default" above. Or on the flip open Settings &gt; Apps &gt; Default apps &gt; SMS app and choose Message+. The buttons come back by themselves.</p>
      <p class="settings-hint">"Not turned on in the flip's Accessibility settings" - this step has to be done on the flip itself: Settings &gt; Accessibility &gt; Message+ &gt; On, then OK. No app or tablet can do it.</p>
      <p class="settings-hint">To turn it off by hand on the flip: Settings &gt; Accessibility &gt; Message+ &gt; Off.</p>
      <p class="settings-hint">A button does something odd on the home screen: switch just that button off above.</p></div>
    <button class="settings-row danger" data-x="off" style="border-radius:20px">Turn off accessibility completely</button>
    <p class="settings-hint">This switches the flip's accessibility service off. It can only be turned back on by hand on the flip (Settings &gt; Accessibility &gt; Message+).</p>`;
  const q = (k) => ov.querySelector(`[data-x="${k}"]`);
  const box = q("switches");
  const rows = [["master", "Button shortcuts", "All of them on or off"], ["anyDefault", "Work even if Message+ is not the default", "Off: while another app is the flip's default texting app, every button does what it normally does"], ...PHONE_BUTTONS.map(([id, label]) => [id, label, ""])];
  const inputs = {};
  for (const [id, label, sub] of rows) {
    const r = document.createElement("label");
    r.style.cssText = "display:flex;align-items:center;gap:12px;padding:12px 0;cursor:pointer";
    r.innerHTML = `<span style="flex:1;min-width:0"><span style="display:block;font-size:16px">${label}</span>${sub ? `<span class="settings-hint" style="margin:0">${sub}</span>` : ""}</span><input type="checkbox" style="width:22px;height:22px">`;
    inputs[id] = r.querySelector("input");
    box.appendChild(r);
  }
  let alive = true, timer = 0, filling = false;
  pp.onClose(() => { alive = false; clearTimeout(timer); });
  const save = async () => {
    if (filling) return;
    const keys = {};
    for (const [id] of PHONE_BUTTONS) keys[id] = inputs[id].checked;
    try {
      const r = await fetch(roomUrl("buttons/config"), { method: "PUT", body: JSON.stringify({ on: inputs.master.checked, anyDefault: inputs.anyDefault.checked, keys, by: "web", at: { ".sv": "timestamp" } }) });
      if (!r.ok) throw new Error(r.status);
    } catch (e) { alert("Not saved: no connection. Try again."); }
  };
  for (const id in inputs) inputs[id].onchange = () => {
    if (id === "master") { for (const [k] of PHONE_BUTTONS) inputs[k].disabled = !inputs.master.checked; inputs.anyDefault.disabled = !inputs.master.checked; }
    save();
  };
  q("off").onclick = async () => {
    if (!await gmConfirm("Step 1 of 3: Do you understand what you are doing? This turns off the flip phone's accessibility service, so none of the buttons open Message+.")) return;
    if (!await gmConfirm("Step 2 of 3: Are you sure? It cannot be turned back on from here. Someone has to do it on the flip: Settings > Accessibility > Message+.")) return;
    if (!await gmConfirm("Step 3 of 3: Last question: turn off accessibility on the flip phone now?")) return;
    try {
      const r = await fetch(roomUrl("buttons/disable"), { method: "PUT", body: JSON.stringify({ at: { ".sv": "timestamp" }, by: "web" }) });
      alert(r.ok ? "Sent. The flip turns it off within a few seconds." : "Not sent: no connection.");
    } catch (e) { alert("Not sent: no connection."); }
  };
  const load = async () => {
    if (!alive) return;
    let all = null;
    try { const r = await fetch(roomUrl("buttons")); if (r.ok) all = (await r.json()) || {}; } catch (e) { /* offline */ }
    if (!alive) return;
    const st = q("state");
    if (!all) { st.textContent = "Could not reach the flip's settings (no internet?)"; }
    else {
      const s = (all.state || {}).state;
      const lines = { working: (all.state || {}).isDefault === false ? "Working (Message+ is not the default texting app)" : "Working", off: "Off (switched off here)", not_default: "Paused: Message+ is not the flip's default texting app", not_allowed: "Not turned on in the flip's Accessibility settings" };
      st.textContent = lines[s] || "Waiting for the flip (it needs Message+ build 170 or newer)";
      st.style.color = s === "not_default" || s === "not_allowed" ? "var(--gm-red,#d93025)" : "";
      const cfg = all.config, keys = cfg && cfg.keys;
      if (document.activeElement == null || !box.contains(document.activeElement)) {
        filling = true;
        inputs.master.checked = !cfg || cfg.on !== false;
        inputs.anyDefault.checked = !cfg || cfg.anyDefault !== false;
        inputs.anyDefault.disabled = !inputs.master.checked;
        for (const [id] of PHONE_BUTTONS) { inputs[id].checked = keys ? !!keys[id] : PHONE_BUTTONS_DEFAULT.includes(id); inputs[id].disabled = !inputs.master.checked; }
        filling = false;
      }
    }
    timer = setTimeout(load, 5000);
  };
  load();
}

// ---------- Settings laid out like the tablet: a list of sections (icon, title, what is inside); each opens its own page ----------
const ICONS = {
  forum: "M21 6h-2v9H6v2c0 .55.45 1 1 1h11l4 4V7c0-.55-.45-1-1-1zm-4 6V3c0-.55-.45-1-1-1H3c-.55 0-1 .45-1 1v14l4-4h10c.55 0 1-.45 1-1z",
  contacts: "M20 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-8 2.75c1.24 0 2.25 1.01 2.25 2.25s-1.01 2.25-2.25 2.25S9.75 10.24 9.75 9 10.76 6.75 12 6.75zM17 17H7v-1.5c0-1.67 3.33-2.5 5-2.5s5 .83 5 2.5V17z",
  arrowUp: "M7.41 15.41L12 10.83l4.59 4.58L18 14l-6-6-6 6z",
  arrowDown: "M7.41 8.59L12 13.17l4.59-4.58L18 10l-6 6-6-6z",
  people: "M16.67 13.13C18.04 14.06 19 15.32 19 17v3h4v-3c0-2.18-3.57-3.47-6.33-3.87zM15 12c2.21 0 4-1.79 4-4s-1.79-4-4-4c-.47 0-.91.1-1.33.24C14.5 5.27 15 6.58 15 8s-.5 2.73-1.33 3.76c.42.14.86.24 1.33.24zM9 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0-6c1.1 0 2 .9 2 2s-.9 2-2 2-2-.9-2-2 .9-2 2-2zm0 7c-2.67 0-8 1.34-8 4v3h16v-3c0-2.66-5.33-4-8-4zm6 5H3v-.99C3.2 16.29 6.3 15 9 15s5.8 1.29 6 2v1z",
  systemUpdate: "M17 1.01L7 1c-1.1 0-2 .9-2 2v18c0 1.1.9 2 2 2h10c1.1 0 2-.9 2-2V3c0-1.1-.9-1.99-2-1.99zM17 19H7V5h10v14zm-1-6h-3V8h-2v5H8l4 4 4-4z",
  close: "M19 6.41L17.59 5 12 10.59 6.41 5 5 6.41 10.59 12 5 17.59 6.41 19 12 13.41 17.59 19 19 17.59 13.41 12z",
  more: "M12 8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm0 2c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
  gear: "M19.14 12.94c.04-.3.06-.61.06-.94 0-.32-.02-.64-.07-.94l2.03-1.58c.18-.14.23-.41.12-.61l-1.92-3.32c-.12-.22-.37-.29-.59-.22l-2.39.96c-.5-.38-1.03-.7-1.62-.94l-.36-2.54c-.04-.24-.24-.41-.48-.41h-3.84c-.24 0-.43.17-.47.41l-.36 2.54c-.59.24-1.13.57-1.62.94l-2.39-.96c-.22-.08-.47 0-.59.22L2.74 8.87c-.12.21-.08.47.12.61l2.03 1.58c-.05.3-.09.63-.09.94s.02.64.07.94l-2.03 1.58c-.18.14-.23.41-.12.61l1.92 3.32c.12.22.37.29.59.22l2.39-.96c.5.38 1.03.7 1.62.94l.36 2.54c.05.24.24.41.48.41h3.84c.24 0 .44-.17.47-.41l.36-2.54c.59-.24 1.13-.56 1.62-.94l2.39.96c.22.08.47 0 .59-.22l1.92-3.32c.12-.22.07-.47-.12-.61l-2.01-1.58zM12 15.6c-1.98 0-3.6-1.62-3.6-3.6s1.62-3.6 3.6-3.6 3.6 1.62 3.6 3.6-1.62 3.6-3.6 3.6z",
  download: "M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z",
  share: "M18 16.08c-.76 0-1.44.3-1.96.77L8.91 12.7c.05-.23.09-.46.09-.7s-.04-.47-.09-.7l7.05-4.11c.54.5 1.25.81 2.04.81 1.66 0 3-1.34 3-3s-1.34-3-3-3-3 1.34-3 3c0 .24.04.47.09.7L8.04 9.81C7.5 9.31 6.79 9 6 9c-1.66 0-3 1.34-3 3s1.34 3 3 3c.79 0 1.5-.31 2.04-.81l7.12 4.16c-.05.21-.08.43-.08.65 0 1.61 1.31 2.92 2.92 2.92s2.92-1.31 2.92-2.92-1.31-2.92-2.92-2.92z",
  playOutline: "M10 16.5l6-4.5-6-4.5v9zM12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z",
  checklist: "M22 7h-9v2h9V7zm0 8h-9v2h9v-2zM5.54 11L2 7.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 11zm0 8L2 15.46l1.41-1.41 2.12 2.12 4.24-4.24 1.41 1.41L5.54 19z",
  tablet: "M21 4H3c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h18c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2zm-2 14H5V6h14v12z",
  archive: "M20.54 5.23l-1.39-1.68C18.88 3.21 18.47 3 18 3H6c-.47 0-.88.21-1.16.55L3.46 5.23C3.17 5.57 3 6.02 3 6.5V19c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V6.5c0-.48-.17-.93-.46-1.27zM12 17.5L6.5 12H10v-2h4v2h3.5L12 17.5zM5.12 5l.81-1h12l.94 1H5.12z",
  star: "M12 17.27L18.18 21l-1.64-7.03L22 9.24l-7.19-.61L12 2 9.19 8.63 2 9.24l5.46 4.73L5.82 21z",
  bell: "M12 22c1.1 0 2-.9 2-2h-4c0 1.1.89 2 2 2zm6-6v-5c0-3.07-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68C7.63 5.36 6 7.92 6 11v5l-2 2v1h16v-1l-2-2z",
  bellOff: "M20 18.69L7.84 6.14 5.27 3.49 4 4.76l2.8 2.8v.01c-.52.99-.8 2.16-.8 3.42v5l-2 2v1h13.73l2 2L21 19.72l-1-1.03zM12 22c1.11 0 2-.89 2-2h-4c0 1.11.89 2 2 2zm6-7.32V11c0-3.08-1.64-5.64-4.5-6.32V4c0-.83-.67-1.5-1.5-1.5s-1.5.67-1.5 1.5v.68c-.15.03-.29.08-.42.12-.1.03-.2.07-.3.11h-.01c-.01 0-.01 0-.02.01-.23.09-.46.2-.68.31 0 0-.01 0-.01.01L18 14.68z",
  lock: "M18 8h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6 9c-1.1 0-2-.9-2-2s.9-2 2-2 2 .9 2 2-.9 2-2 2zm3.1-9H8.9V6c0-1.71 1.39-3.1 3.1-3.1 1.71 0 3.1 1.39 3.1 3.1v2z",
  history: "M13 3c-4.97 0-9 4.03-9 9H1l3.89 3.89.07.14L9 12H6c0-3.87 3.13-7 7-7s7 3.13 7 7-3.13 7-7 7c-1.93 0-3.68-.79-4.94-2.06l-1.42 1.42C8.27 19.99 10.51 21 13 21c4.97 0 9-4.03 9-9s-4.03-9-9-9zm-1 5v5l4.28 2.54.72-1.21-3.5-2.08V8H12z",
  info: "M11 7h2v2h-2zm0 4h2v6h-2zm1-9C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm0 18c-4.41 0-8-3.59-8-8s3.59-8 8-8 8 3.59 8 8-3.59 8-8 8z",
  trash: "M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z",
  doneAll: "M18 7l-1.41-1.41-6.34 6.34 1.41 1.41L18 7zm4.24-1.41L11.66 16.17 7.48 12l-1.41 1.41L11.66 19l12-12-1.42-1.41zM.41 13.41L6 19l1.41-1.41L1.83 12 .41 13.41z",
  block: "M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zM4 12c0-4.42 3.58-8 8-8 1.85 0 3.55.63 4.9 1.69L5.69 16.9C4.63 15.55 4 13.85 4 12zm8 8c-1.85 0-3.55-.63-4.9-1.69L18.31 7.1C19.37 8.45 20 10.15 20 12c0 4.42-3.58 8-8 8z",
  phone: "M16 1H8C6.34 1 5 2.34 5 4v16c0 1.66 1.34 3 3 3h8c1.66 0 3-1.34 3-3V4c0-1.66-1.34-3-3-3zm-2 20h-4v-1h4v1zm3.25-3H6.75V4h10.5v14z",
  place: "M12 2C8.13 2 5 5.13 5 9c0 5.25 7 13 7 13s7-7.75 7-13c0-3.87-3.13-7-7-7zm0 9.5c-1.38 0-2.5-1.12-2.5-2.5s1.12-2.5 2.5-2.5 2.5 1.12 2.5 2.5-1.12 2.5-2.5 2.5z",
  voicemail: "M18.5 6C15.46 6 13 8.46 13 11.5c0 1.33.47 2.55 1.26 3.5H9.74c.79-.95 1.26-2.17 1.26-3.5C11 8.46 8.54 6 5.5 6S0 8.46 0 11.5 2.46 17 5.5 17h13c3.04 0 5.5-2.46 5.5-5.5S21.54 6 18.5 6zm-13 9C3.57 15 2 13.43 2 11.5S3.57 8 5.5 8 9 9.57 9 11.5 7.43 15 5.5 15zm13 0c-1.93 0-3.5-1.57-3.5-3.5S16.57 8 18.5 8 22 9.57 22 11.5 20.43 15 18.5 15z",
  sync: "M12 4V1L8 5l4 4V6c3.31 0 6 2.69 6 6 0 1.01-.25 1.97-.7 2.8l1.46 1.46C19.54 15.03 20 13.57 20 12c0-4.42-3.58-8-8-8zm0 14c-3.31 0-6-2.69-6-6 0-1.01.25-1.97.7-2.8L5.24 7.74C4.46 8.97 4 10.43 4 12c0 4.42 3.58 8 8 8v3l4-4-4-4v3z",
  undo: "M12.5 8c-2.65 0-5.05.99-6.9 2.6L2 7v9h9l-3.62-3.62c1.39-1.16 3.16-1.88 5.12-1.88 3.54 0 6.55 2.31 7.6 5.5l2.37-.78C21.08 11.03 17.15 8 12.5 8z",
  reply: "M10 9V5l-7 7 7 7v-4.1c5 0 8.5 1.6 11 5.1-1-5-4-10-11-11z",
  snooze: "M7.88 3.39L6.6 1.86 2 5.71l1.29 1.53 4.59-3.85zM22 5.72l-4.6-3.86-1.29 1.53 4.6 3.86L22 5.72zM12 4c-4.97 0-9 4.03-9 9s4.02 9 9 9c4.97 0 9-4.03 9-9s-4.03-9-9-9zm0 16c-3.87 0-7-3.13-7-7s3.13-7 7-7 7 3.13 7 7-3.13 7-7 7zm-3-9h3.63L9 15.2V17h6v-2h-3.63L15 10.8V9H9v2z",
  palette: "M12 3c-4.97 0-9 4.03-9 9s4.03 9 9 9c.83 0 1.5-.67 1.5-1.5 0-.39-.15-.74-.39-1.01-.23-.26-.38-.61-.38-.99 0-.83.67-1.5 1.5-1.5H16c2.76 0 5-2.24 5-5 0-4.42-4.03-8-9-8zm-5.5 9c-.83 0-1.5-.67-1.5-1.5S5.67 9 6.5 9 8 9.67 8 10.5 7.33 12 6.5 12zm3-4C8.67 8 8 7.33 8 6.5S8.67 5 9.5 5s1.5.67 1.5 1.5S10.33 8 9.5 8zm5 0c-.83 0-1.5-.67-1.5-1.5S13.67 5 14.5 5s1.5.67 1.5 1.5S15.33 8 14.5 8zm3 4c-.83 0-1.5-.67-1.5-1.5S16.67 9 17.5 9s1.5.67 1.5 1.5-.67 1.5-1.5 1.5z",
  swipe: "M18.89 6.28L20.56 3H15v5.56l1.98-1.98C18.3 8.07 19 9.96 19 12c0 3.31-2.24 6.1-5.29 6.92l.51 1.93C17.98 19.83 21 16.27 21 12c0-2.24-.83-4.29-2.11-5.72zM3 12c0 4.27 3.02 7.83 6.79 8.85l.51-1.93C7.24 18.1 5 15.31 5 12c0-2.04.7-3.93 2.02-5.42L9 8.56V3H3.44l1.67 3.28C3.83 7.71 3 9.76 3 12z",
  group: "M16 11c1.66 0 2.99-1.34 2.99-3S17.66 5 16 5c-1.66 0-3 1.34-3 3s1.34 3 3 3zm-8 0c1.66 0 2.99-1.34 2.99-3S9.66 5 8 5C6.34 5 5 6.34 5 8s1.34 3 3 3zm0 2c-2.33 0-7 1.17-7 3.5V19h14v-2.5c0-2.33-4.67-3.5-7-3.5zm8 0c-.29 0-.62.02-.97.05 1.16.84 1.97 1.97 1.97 3.45V19h6v-2.5c0-2.33-4.67-3.5-7-3.5z",
  save: "M17 3H5c-1.11 0-2 .9-2 2v14c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V7l-4-4zm-5 16c-1.66 0-3-1.34-3-3s1.34-3 3-3 3 1.34 3 3-1.34 3-3 3zm3-10H5V5h10v4z",
  restart: "M12 5V1L7 6l5 5V7c3.31 0 6 2.69 6 6s-2.69 6-6 6-6-2.69-6-6H4c0 4.42 3.58 8 8 8s8-3.58 8-8-3.58-8-8-8z",
  logout: "M10.09 15.59L11.5 17l5-5-5-5-1.41 1.41L12.67 11H3v2h9.67l-2.58 2.59zM19 3H5c-1.11 0-2 .9-2 2v4h2V5h14v14H5v-4H3v4c0 1.1.89 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2z",
  person: "M12 12c2.21 0 4-1.79 4-4s-1.79-4-4-4-4 1.79-4 4 1.79 4 4 4zm0 2c-2.67 0-8 1.34-8 4v2h16v-2c0-2.66-5.33-4-8-4z",
  photo: "M21 19V5c0-1.1-.9-2-2-2H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2zM8.5 13.5l2.5 3.01L14.5 12l4.5 6H5l3.5-4.5z",
  camera: "M12 15.2a3.2 3.2 0 100-6.4 3.2 3.2 0 000 6.4zM9 2L7.17 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-3.17L15 2H9zm3 15c-2.76 0-5-2.24-5-5s2.24-5 5-5 5 2.24 5 5-2.24 5-5 5z",
  video: "M17 10.5V7c0-.55-.45-1-1-1H4c-.55 0-1 .45-1 1v10c0 .55.45 1 1 1h12c.55 0 1-.45 1-1v-3.5l4 4v-11l-4 4z",
  dialpad: "M12 19c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zM6 1c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0 6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm12-8c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm-6 8c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm-6 0c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2zm0-6c-1.1 0-2 .9-2 2s.9 2 2 2 2-.9 2-2-.9-2-2-2z",
};
function svgIcon(name, size) {
  return `<svg viewBox="0 0 24 24" width="${size || 24}" height="${size || 24}" aria-hidden="true" style="flex:none;fill:currentColor"><path d="${ICONS[name] || ICONS.info}"/></svg>`;
}
function injectTabletStyles() {
  if (document.getElementById("tablet-look-css")) return;
  const s = document.createElement("style");
  s.id = "tablet-look-css";
  s.textContent = `
    .tl-group{background:var(--gm-card,rgba(127,127,127,.12));border-radius:24px;padding:6px 0;margin:8px 12px 14px}
    .tl-row{display:flex;align-items:center;gap:18px;min-height:64px;padding:8px 20px;cursor:pointer;width:100%;box-sizing:border-box;background:none;border:0;color:inherit;text-align:left;font:inherit;border-radius:0}
    .tl-row:hover{background:rgba(127,127,127,.08)}
    .tl-row .tl-ic{color:var(--gm-blue,#1a73e8);display:flex}
    .tl-row .tl-t{font-size:16px;line-height:1.3}
    .tl-row .tl-s{font-size:13px;opacity:.7;margin-top:2px;line-height:1.3}
    .tl-row.danger .tl-t,.tl-row.danger .tl-ic{color:var(--gm-red,#d93025)}
    #settings-body .tl-group .settings-row{display:flex;align-items:center;gap:18px;min-height:56px;padding:8px 20px 8px 62px;margin:0;width:100%;box-sizing:border-box;background:none;border-radius:0;text-align:left;font-size:16px;position:relative}
    #settings-body .tl-group .settings-row[data-ic]::before{content:"";position:absolute;left:20px;top:50%;width:24px;height:24px;margin-top:-12px;background:var(--gm-blue,#1a73e8);-webkit-mask:var(--ic) center/24px no-repeat;mask:var(--ic) center/24px no-repeat}
    #settings-body .tl-group .settings-row.danger[data-ic]::before{background:var(--gm-red,#d93025)}
    #settings-body .tl-group .settings-row[data-sub]::after{content:attr(data-sub);position:absolute;left:62px;right:20px;bottom:8px;font-size:13px;opacity:.7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    #settings-body .tl-group .settings-row[data-sub]{padding-bottom:28px;padding-top:12px;align-items:flex-start;min-height:64px}
    .tl-sectionpage>.settings-heading-row,.tl-sectionpage>.settings-hint,.tl-sectionpage>#deleted-list,.tl-sectionpage>#deleted-selection-toolbar{margin-left:12px;margin-right:12px}
    .tl-sheet-bg{position:fixed;inset:0;z-index:80;background:rgba(0,0,0,.35);display:flex;align-items:flex-start;justify-content:center;padding-top:calc(64px + env(safe-area-inset-top,0px))}
    .tl-sheet{background:var(--gm-page,#fff);color:var(--gm-ink,#202124);border-radius:28px;padding:18px;width:min(520px,calc(100vw - 32px));box-shadow:0 8px 32px rgba(0,0,0,.3)}
    .tl-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:8px}
    .tl-tile{display:flex;flex-direction:column;align-items:center;gap:8px;padding:12px 4px;border:0;background:none;color:inherit;font:inherit;font-size:13px;cursor:pointer;border-radius:16px}
    .tl-tile:hover{background:rgba(127,127,127,.1)}
    .tl-tile span.c{width:56px;height:56px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff}
    .tl-nc{position:fixed;inset:0;z-index:65;overflow:auto;background:var(--gm-page,var(--bg,#fff));color:var(--gm-ink,inherit)}
    .tl-nc header{position:sticky;top:0;background:inherit;display:flex;align-items:center;gap:8px;padding:12px max(12px,env(safe-area-inset-right)) 8px max(12px,env(safe-area-inset-left))}
    .tl-nc .to{display:flex;align-items:center;gap:10px;margin:0 16px 8px;padding:6px 16px;border-radius:28px;background:var(--gm-card,rgba(127,127,127,.12))}
    .tl-nc .to input{flex:1;min-width:0;border:0;background:none;font-size:17px;color:inherit;padding:10px 0;outline:none}
    .tl-nc .chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 16px 8px}
    .tl-nc .chip{display:inline-flex;align-items:center;gap:6px;padding:6px 12px;border-radius:16px;background:var(--gm-blue,#1a73e8);color:#fff;font-size:14px;cursor:pointer}
    .tl-av{width:40px;height:40px;border-radius:50%;display:flex;align-items:center;justify-content:center;color:#fff;font-weight:600;flex:none}
    .tl-nc .hd{font-size:14px;color:var(--gm-blue,#1a73e8);padding:14px 24px 6px}
    .tl-nc .go{position:fixed;right:max(20px,env(safe-area-inset-right));top:calc(12px + env(safe-area-inset-top,0px));padding:10px 20px;border-radius:20px;border:0;background:var(--gm-blue,#1a73e8);color:#fff;font-size:15px;cursor:pointer}
  `;
  document.head.appendChild(s);
}
const iconMask = (name) => `url("data:image/svg+xml,${encodeURIComponent(`<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 24 24'><path d='${ICONS[name]}'/></svg>`)}")`;

let settingsSectionOpen = null;
async function showBlockedList() {
  let o = null;
  try { const r = await fetch(roomUrl("blockedNumbers")); if (r.ok) o = (await r.json()) || {}; } catch (e) { /* offline */ }
  if (!o) { alert("Could not load the list (no internet?)"); return; }
  const nums = Object.keys(o);
  const pick = await showActionSheet(nums.length ? "Blocked - tap one to unblock" : "Blocked numbers", nums.length ? nums.map((n) => ({ label: (displayName(n) || n) + (displayName(n) && displayName(n) !== n ? " · " + n : ""), value: n })) : [{ label: "Nobody is blocked", value: "" }]);
  if (pick && await gmConfirm("Unblock " + (displayName(pick) || pick) + "? (on the flip phone too)")) await toggleBlocked(pick);
}
async function showMutedList() {
  await loadMuted();
  const nums = [...mutedSet];
  const pick = await showActionSheet(nums.length ? "Muted - tap one to unmute" : "Muted conversations", nums.length ? nums.map((n) => ({ label: displayName(n) || n, value: n })) : [{ label: "Nothing is muted", value: "" }]);
  if (pick) await toggleMuted(pick);
}
async function toggleBusyFromWeb() {
  const b = document.getElementById("tl-busy-btn");
  let j = null;
  try { const r = await fetch(roomUrl("busyMode")); j = r.ok ? await r.json() : null; } catch (e) { alert("No connection."); return; }
  const on = !!(j && j.on && (!j.endsAt || j.endsAt > Date.now()));
  let next;
  if (on) {
    if (!await gmConfirm("Turn I'm busy off on every tablet?")) return;
    next = Object.assign({}, j, { on: false, by: "web page", at: Date.now() });
  } else {
    const how = await showActionSheet("Turn on I'm busy", [
      { label: "For 1 hour", value: 3600e3 }, { label: "For 3 hours", value: 3 * 3600e3 }, { label: "Until I turn it off", value: 0 }]);
    if (how === null || how === undefined) return;
    const msg = await gmPrompt("Message people get when they text you:", (j && j.message) || "I'm busy right now and can't answer. I'll get back to you as soon as I can.");
    if (msg === null) return;
    // the same defaults as the tablet (BusyLogic): answer texts and calls, one reply per person per 4 hours
    next = Object.assign({ callMessage: "Sorry I missed your call - I'm busy right now. I'll call you back as soon as I can.", answerCalls: true, scope: 0, windowMs: 4 * 3600e3 }, j || {}, { on: true, endsAt: how ? Date.now() + how : 0, message: msg, by: "web page", at: Date.now() });
  }
  try {
    const r = await fetch(roomUrl("busyMode"), { method: "PUT", body: JSON.stringify(next) });
    if (!r.ok) throw new Error(r.status);
  } catch (e) { alert("Not changed: no connection."); }
  refreshBusyLabel(b);
}

const panelCard = "border-radius:20px;padding:14px 18px;margin:12px 0;background:var(--gm-card,rgba(127,127,127,.12))";
function agoText(t) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 60 ? "just now" : s < 3600 ? Math.round(s / 60) + " min ago" : s < 86400 ? Math.round(s / 3600) + " h ago" : Math.round(s / 86400) + " days ago";
}

// Settings > Sync messages and attachments: the flip phone's history sync (rooms/<room>/syncStatus, start = syncRequest/<kind>).
function openSyncPanel() {
  const p = openPanel("Sync messages and attachments");
  p.body.innerHTML = `<p class="settings-hint">The flip phone sends your whole message history (and, separately, the pictures, videos and voice messages) to the tablets. It runs on the flip; this shows its progress.</p>`;
  const kinds = [["texts", "Messages"], ["media", "Attachments (pictures, videos, voice, contacts)"]];
  const lines = {};
  for (const [kind, title] of kinds) {
    const c = document.createElement("div"); c.style.cssText = panelCard;
    c.innerHTML = `<div style="font-size:17px;font-weight:600"></div><div class="settings-hint" style="margin:6px 0"></div><button class="settings-row" style="border-radius:16px">Sync now</button>`;
    c.firstElementChild.textContent = title;
    lines[kind] = c.children[1];
    c.querySelector("button").onclick = async () => {
      try {
        const r = await fetch(roomUrl(`syncRequest/${kind}`), { method: "PUT", body: JSON.stringify({ at: Date.now(), by: "web" }) });
        alert(r.ok ? "Asked. The flip starts within a minute (not again within 10 minutes of the last one)." : "Not sent: no connection.");
      } catch (e) { alert("Not sent: no connection."); }
    };
    p.body.appendChild(c);
  }
  const states = { building: "preparing", uploading: "sending", waiting: "paused", paused: "paused", done: "done", failed: "stopped", stopped: "stopped" };
  const load = async () => {
    if (!p.alive()) return;
    let s = null;
    try { const r = await fetch(roomUrl("syncStatus")); if (r.ok) s = (await r.json()) || {}; } catch (e) { /* offline */ }
    for (const [kind] of kinds) {
      const x = s && s[kind];
      if (!s) lines[kind].textContent = "Could not reach the database (no internet?)";
      else if (!x) lines[kind].textContent = "Not run yet";
      else {
        const parts = [(states[x.state] || x.state) + (typeof x.percent === "number" && x.state !== "done" ? " " + x.percent + "%" : "")];
        if (x.state === "done" && x.count) parts.push(x.count + " messages");
        if (x.note) parts.push(x.note);
        parts.push("updated " + agoText(x.at || 0));
        lines[kind].textContent = parts.join(" · ");
      }
    }
    setTimeout(load, 3000);
  };
  load();
}

// Settings > Where is the phone?: asks the flip for its location (locate/request), waits for locate/result.
function openLocatePanel() {
  const p = openPanel("Where is the phone?");
  p.body.innerHTML = `<p class="settings-hint">Asks the flip phone where it is, only when you press the button.</p>
    <div style="${panelCard}"><div data-x="h" style="font-size:18px;font-weight:600">Not asked yet</div><div data-x="d" class="settings-hint" style="margin:6px 0"></div><a data-x="map" target="_blank" rel="noopener" style="display:none">Open in Maps</a></div>
    <button data-x="go" class="settings-row" style="border-radius:20px">Locate now</button>`;
  const q = (k) => p.body.querySelector(`[data-x="${k}"]`);
  const show = (res, fromHistory) => {
    if (!res.ok) {
      const r = res.reason || "";
      q("h").textContent = "The phone could not answer";
      q("d").textContent = r === "off" ? "Location requests are switched off on the phone (Settings > Flip Relay > Location requests)."
        : r === "permission" ? "The phone has not allowed Location for Message+ (Settings > Flip Relay > App Permissions)."
        : r === "gps_off" ? "Location is turned off on the phone itself. On the phone: Settings > Location > On, then try again."
        : "The phone could not get a GPS reading (it may be indoors). Try again outside or near a window.";
      q("map").style.display = "none";
      return;
    }
    q("h").textContent = `${Number(res.lat).toFixed(5)}, ${Number(res.lng).toFixed(5)}`;
    q("d").textContent = (res.old ? "Last place the phone remembers, " : fromHistory ? "Last known, " : "Reading taken ") + agoText(res.fixAt || res.ts || 0) + (res.acc ? " · accurate to about " + res.acc + " m" : "");
    q("map").href = `https://www.google.com/maps?q=${res.lat},${res.lng}`;
    q("map").style.display = "";
  };
  fetch(roomUrl("locate/result")).then((r) => r.ok ? r.json() : null).then((res) => { if (res && p.alive()) show(res, true); }).catch(() => {});
  q("go").onclick = async () => {
    const id = Date.now().toString(36), started = Date.now();
    q("go").disabled = true; q("go").textContent = "Locating...";
    q("d").textContent = "Asking the phone... this can take up to a minute.";
    try { await fetch(roomUrl("locate/request"), { method: "PUT", body: JSON.stringify({ id, ts: Date.now() }) }); } catch (e) { /* the wait below reports it */ }
    while (p.alive() && Date.now() - started < 95000) {
      await new Promise((r) => setTimeout(r, 3000));
      try {
        const r = await fetch(roomUrl("locate/result"));
        const res = r.ok ? await r.json() : null;
        if (res && res.id === id) { show(res, false); q("go").disabled = false; q("go").textContent = "Locate now"; return; }
      } catch (e) { /* keep waiting */ }
    }
    if (!p.alive()) return;
    q("go").disabled = false; q("go").textContent = "Locate now";
    q("d").textContent = "No answer. The phone may be off, without data, or out of the app's reach. Try again in a moment.";
  };
}

// Settings > Voicemail: the voicemails the flip relays (rooms/<room>/voicemails/<id>), play, mark heard, delete.
function openVoicemailPanel() {
  const p = openPanel("Voicemail");
  p.ov.classList.add("tl-vm");
  const backBtn = p.ov.querySelector(".tl-panel-top button");
  backBtn.style.display = "none";
  const top = p.ov.querySelector(".tl-panel-top");
  const refresh = document.createElement("button");
  refresh.className = "tl-chat-btn"; refresh.title = "Refresh"; refresh.innerHTML = svgIcon("sync"); refresh.style.color = "var(--gm-blue)"; refresh.style.marginLeft = "auto";
  const vmSearchBtn = tlSearchButton(() => { const q = p.body.querySelector(".tl-vm-search"); q.hidden = !q.hidden; if (q.hidden) { q.value = ""; q.oninput(); } else q.focus(); });
  vmSearchBtn.style.marginLeft = "auto"; refresh.style.marginLeft = "0";
  top.appendChild(vmSearchBtn);
  top.appendChild(refresh);
  top.appendChild(tlMenuButton());
  top.after(tlPanelDock("voicemail", backBtn));
  p.body.innerHTML = `<input class="tl-vm-search" placeholder="Search voicemails: a name, number or date" autocomplete="off" hidden><div class="tl-vm-count"></div><div data-x="list" class="tl-vm-empty">Loading...</div>`;
  p.body.querySelector(".tl-vm-search").oninput = function () {
    const q = this.value.trim().toLowerCase();
    for (const row of p.body.querySelectorAll(".tl-vm-row")) row.hidden = !!q && !q.split(/\s+/).every((t) => !t || (row.dataset.s || "").includes(t));
    for (const g of p.body.querySelectorAll(".tl-vm-group")) { const h = g.previousElementSibling; const any = [...g.children].some((r) => !r.hidden); g.hidden = !any; if (h && h.classList.contains("tl-day")) h.hidden = !any; }
  };
  const list = p.body.querySelector('[data-x="list"]');
  refresh.onclick = async () => {
    try {
      const r = await fetch(roomUrl("voicemailCheck/request"), { method: "PUT", body: JSON.stringify({ id: "w" + Date.now(), at: Date.now(), to: "" }) });
      tlToast(r.ok ? "Asked the phone to check. New ones show up in a minute or two." : "Not sent: no connection.");
      setTimeout(load, 30000);
    } catch (e) { tlToast("Not sent: no connection."); }
  };
  let audio = null;
  p.onClose(() => { if (audio) audio.pause(); });
  const rowFor = (id, v, saved) => {
    const who = v.contactName || displayName(normalizeNumber(v.from)) || v.from || "Unknown";
    const when = new Date(v.timestamp || 0).toLocaleString([], { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " \u2022 " + clockOf(v.durationSec || 0);
    const n = normalizeNumber(v.from);
    const c = document.createElement("div");
    c.className = "tl-vm-row" + (!saved && !v.read ? " new" : "");
    c.dataset.s = [who, v.from || "", String(v.from || "").replace(/\D/g, ""), when, new Date(v.timestamp || 0).toDateString(), (!saved && !v.read) ? "new unread" : "older heard"].join(" ").toLowerCase();
    c.innerHTML = `<div class="line">${gmAvatarHtml(n || v.from)}<div class="col"><div class="nm"></div><div class="dt">${svgIcon("voicemail")}<span></span></div></div><button class="tl-chat-btn" title="Play">${svgIcon("playOutline")}</button></div>`;
    c.querySelector(".nm").textContent = who;
    c.querySelector(".dt span").textContent = when;
    const open = () => {
      if (c.classList.contains("open")) return;
      if (audio) audio.pause();
      for (const x of list.querySelectorAll(".tl-vm-row.open")) { x.classList.remove("open"); const o = x.querySelector(".more"); if (o) o.remove(); }
      c.classList.add("open");
      const more = document.createElement("div");
      more.className = "more";
      more.innerHTML = `<div class="bar"><b></b></div><div class="times"><span>0:00</span><span>${Math.floor((v.durationSec || 0) / 60)}:${String((v.durationSec || 0) % 60).padStart(2, "0")}</span></div>
        <div class="ctl"><button class="play">${svgIcon("play")}</button><button class="spd">1.0\u00d7</button><span style="flex:1"></span><button title="Download" data-a="dl">${svgIcon("download")}</button><button title="Share" data-a="share">${svgIcon("share")}</button><button title="Delete" data-a="del">${svgIcon("trash")}</button></div>
        <button class="act" data-a="call">${svgIcon("call")}<span>Voice call</span></button><button class="act" data-a="msg">${svgIcon("chat")}<span>Send a message</span></button>`;
      c.appendChild(more);
      c.querySelector(".line > button").style.display = "none";
      const a = audio = makeAudio(v.url || "");
      const playBtn = more.querySelector(".play"), fill = more.querySelector(".bar b"), now = more.querySelector(".times span");
      let heard = false;
      playBtn.onclick = () => {
        if (a.paused) a.play().catch(() => tlToast("This voicemail could not be loaded here. Update the Message+ Windows app (Settings > Help), or use the download button."));
        else a.pause();
      };
      a.onplay = () => {
        playBtn.innerHTML = svgIcon("pause");
        if (!saved && !v.read && !heard) { heard = true; v.read = true; c.classList.remove("new"); fetch(roomUrl(`voicemails/${id}/read`), { method: "PUT", body: "true" }).catch(() => {}); voicemailUnread = Math.max(0, voicemailUnread - 1); updateTabs(); }
      };
      a.onpause = () => { playBtn.innerHTML = svgIcon("play"); };
      a.ontimeupdate = () => { const d = a.duration || v.durationSec || 1; fill.style.width = Math.min(100, a.currentTime / d * 100) + "%"; now.textContent = Math.floor(a.currentTime / 60) + ":" + String(Math.floor(a.currentTime % 60)).padStart(2, "0"); };
      more.querySelector(".bar").onclick = (e) => { const r = e.currentTarget.getBoundingClientRect(); if (a.duration) a.currentTime = (e.clientX - r.left) / r.width * a.duration; };
      const speeds = [1, 1.5, 2, 0.75];
      if (a instanceof AmrAudio) more.querySelector(".spd").style.display = "none"; // the speed control needs a normal audio file
      more.querySelector(".spd").onclick = (e) => { const i = (speeds.indexOf(a.playbackRate) + 1) % speeds.length; a.playbackRate = speeds[i]; e.currentTarget.textContent = speeds[i].toFixed(speeds[i] === 0.75 ? 2 : 1) + "\u00d7"; };
      more.querySelector('[data-a="dl"]').onclick = () => { if (v.url) window.open(v.url, "_blank"); };
      more.querySelector('[data-a="share"]').onclick = async () => { try { if (navigator.share) await navigator.share({ title: "Voicemail from " + who, url: v.url }); else { await navigator.clipboard.writeText(v.url); tlToast("Link copied"); } } catch (e) { /* cancelled */ } };
      more.querySelector('[data-a="call"]').onclick = () => { if (n) callNumber(n, who); };
      more.querySelector('[data-a="msg"]').onclick = () => { if (n) { backBtn.click(); openChat(n); } };
      more.querySelector('[data-a="del"]').onclick = async () => {
        if (!await gmConfirm(saved ? "Delete this saved voicemail?" : "Delete this voicemail? It is deleted on the phone too.")) return;
        try {
          if (saved) await fetch(roomUrl(`voicemailArchive/${id}`), { method: "DELETE" });
          else { await fetch(roomUrl(`voicemails/${id}/deleted`), { method: "PUT", body: "true" }); await fetch(roomUrl("voicemailCheck/request"), { method: "PUT", body: JSON.stringify({ id: "d" + Date.now(), at: Date.now() }) }); }
          a.pause(); c.remove();
        } catch (e) { tlToast("Not deleted: no connection."); }
      };
    };
    c.querySelector(".line").onclick = open;
    return c;
  };
  const load = async () => {
    if (!p.alive()) return;
    let o = null, arch = null;
    try { const r = await fetch(roomUrl("voicemails")); if (r.ok) o = (await r.json()) || {}; const r2 = await fetch(roomUrl("voicemailArchive")); if (r2.ok) arch = (await r2.json()) || {}; } catch (e) { /* offline */ }
    if (!o) { list.textContent = "Could not load voicemail (no internet?)"; return; }
    const byTime = (a, b) => (b[1].timestamp || 0) - (a[1].timestamp || 0);
    const box = Object.entries(o).filter(([, v]) => v && !v.deleted && !v.acct).sort(byTime);
    const seen = new Set();
    const savedList = [...Object.entries(arch || {}), ...Object.entries(o).filter(([, v]) => v && !v.deleted && v.acct)].filter(([k, v]) => v && !seen.has(k) && seen.add(k)).sort(byTime);
    p.body.querySelector(".tl-vm-count").textContent = box.length ? box.length + (box.length === 1 ? " voicemail" : " voicemails") : "";
    list.className = "";
    list.innerHTML = box.length || savedList.length ? "" : `<div class="tl-vm-empty">No voicemails</div>`;
    let state = null, group = null;
    for (const [id, v] of box) {
      const s = v.read ? "Older" : "New";
      if (s !== state) {
        state = s;
        const h = document.createElement("div"); h.className = "tl-day"; h.textContent = s; list.appendChild(h);
        group = document.createElement("div"); group.className = "tl-vm-group"; list.appendChild(group);
      }
      group.appendChild(rowFor(id, v, false));
    }
    if (savedList.length) {
      const h = document.createElement("div"); h.className = "tl-vm-saved"; h.innerHTML = "<div>Saved voicemails</div><span>Every voicemail that has ever come in, kept here even after you delete it. These are not part of your voicemail box above.</span>"; list.appendChild(h);
      group = document.createElement("div"); group.className = "tl-vm-group"; list.appendChild(group);
      for (const [id, v] of savedList) group.appendChild(rowFor(id, v, true));
    }
  };
  load();
}

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
  if (!await gmConfirm(`Restore ${numbers.length} conversation${numbers.length === 1 ? "" : "s"}?`)) return;
  for (const number of numbers) {
    for (const item of deletedGroups.get(number) || []) await restoreDeletedMessage(item, false);
  }
  exitDeletedGroupsSelectionMode();
  loadDeletedMessages();
}

async function confirmDeleteSelectedGroups() {
  const numbers = [...selectedDeletedGroups];
  if (numbers.length === 0) return;
  if (!await gmConfirm(`Are you sure you want to delete ${numbers.length} conversation${numbers.length === 1 ? "" : "s"} forever? This can't be undone.`)) return;
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
  if (!await gmConfirm(`Restore all ${groupItems.length} deleted message(s) from ${label}?`)) return;
  for (const item of groupItems) await restoreDeletedMessage(item, false);
  loadDeletedMessages();
}

async function confirmDeleteForeverAllForNumber(number) {
  const groupItems = deletedGroups.get(number) || [];
  if (groupItems.length === 0) return;
  const label = displayName(number) || number;
  if (!await gmConfirm(`Permanently delete all ${groupItems.length} message(s) from ${label}? This can't be undone.`)) return;
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
  if (!await gmConfirm(`Permanently delete ${n} message${n === 1 ? "" : "s"}? This can't be undone.`)) return;
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

// ---------- quick replies: the same ready-made texts as the tablet, plus your own (kept in this browser) ----------
const QUICK_DEFAULTS = ["I'll call you back later", "I'm busy right now", "Can't talk now, what's up?", "I'm on my way"];
const QUICK_KEY = "flip_relay_web_quick_replies";
function quickCustom() { try { return JSON.parse(localStorage.getItem(QUICK_KEY) || "[]"); } catch (e) { return []; } }
function quickReplies() { return QUICK_DEFAULTS.concat(quickCustom()); }
function addQuickReply(t) { const l = quickCustom(); if (!l.includes(t)) l.push(t); try { localStorage.setItem(QUICK_KEY, JSON.stringify(l)); } catch (e) { /* storage blocked */ } }
async function sendQuick(number, text, name) {
  if (undoSendOn() && !(await undoBar(`Sending to ${name}: "${text}"`))) return;
  const keep = currentChatNumber;
  currentChatNumber = number;
  try { await sendOne(text, null, null, null); } finally { currentChatNumber = keep; }
  if (keep) renderChat(keep);
  renderConversationList();
}

let callsTab = 0; // 0 = All, 1 = Contacts, 2 = Not contacts, 3 = Missed
// Tapping a scheduled message's bubble is the only way to cancel it --
// there was previously no way to at all.
async function cancelScheduled(messageId) {
  if (!await gmConfirm("Cancel this scheduled message? It won't be sent.")) return;
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
    el("conv-selection-count").textContent = String(selectedConversationNumbers.size);
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
  if (!await gmConfirm(`Delete ${n} conversation${n === 1 ? "" : "s"}? Messages can be restored later from Settings within 30 days.`)) return;
  exitConversationSelectionMode();
  for (const number of numbers) await softDeleteConversation(number);
}

/** Soft-deletes every message in a conversation, one at a time, via the same trash mechanism as deleting an individual message. */
async function softDeleteConversation(number) {
  const ids = messages.filter((m) => m.number === number && m.direction !== "scheduled").map((m) => m.id);
  for (const id of ids) await softDeleteMessage(id);
}

async function showConversationLongPressMenu(number, forced, sheet) {
  if (!forced && !sheet) {
    if (conversationSelectionMode) toggleConversationSelection(number);
    else enterConversationSelectionMode(number);
    return;
  }
  const pinned = isPinned(number);
  const options = [
    { label: pinned ? "📌 Unpin" : "📌 Pin to top", value: "pin" },
    { label: "🗄️ Archive", value: "archive" },
    { label: mutedSet.has(number) ? "🔔 Unmute" : "🔕 Mute (on every device and the flip)", value: "mute" },
    { label: lockedChats().has(number) ? "🔓 Unlock chat" : "🔒 Lock chat (asks for the app code)", value: "lock" },
    { label: "☑️ Select", value: "select" },
  ];
  if (isMulti(number)) options.splice(2, 0, { label: "✏️ Rename group", value: "rename" });
  else options.push({ label: "🚫 Block/Unblock", value: "block" });
  options.push({ label: "🖼️ Chat theme", value: "theme" });
  const choice = forced || await showActionSheet(displayName(number) || number, options);
  if (choice === "theme") { chatThemeMenu(number); return; }
  if (choice === "archive") {
    const how = await showActionSheet("Archive", [
      { label: "Come back when a new message arrives", value: "back" },
      { label: "Stay archived, even for new messages", value: "stay" },
    ]);
    if (how) { setArchived(number, true, how === "stay"); renderConversationList(); }
    return;
  }
  if (choice === "rename") { const n = await gmPrompt("Name this group:", groupNames[number] || ""); if (n !== null) { setGroupName(number, n.trim()); renderConversationList(); } return; }
  if (choice === "pin") togglePinned(number);
  else if (choice === "mute") toggleMuted(number);
  else if (choice === "lock") toggleChatLock(number);
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
  updateTabs();
}
// "Show groups in Messages" (like the tablet): groups sit in the Chats list and there is no Groups tab
const GROUPS_IN_MSGS_KEY = "flip_relay_web_groups_in_messages";
function groupsInMessages() { try { return localStorage.getItem(GROUPS_IN_MSGS_KEY) === "1"; } catch (e) { return false; } }

// ---------- tabs at the top: Chats, Groups, Calls, Voicemail (the one you are on is lit; no button to switch back off) ----------
let currentTab = "chats";
function goTab(key) {
  if (key === "voicemail") { openVoicemailPanel(); return; } // opens over the list; Back returns to the tab you were on
  if (key === "contacts") { openContactsPanel(); return; }
  currentTab = key;
  if (key === "calls") { onCallsClick(); updateTabs(); return; }
  groupsView = key === "groups";
  showScreen("conversations");
  renderConversationList();
  updateTabs();
}
function filteredConversations() {
  let convos = conversationsByNumber().filter((c) => !archived.has(c.number));
  if (groupsHidden()) convos = convos.filter((c) => !isMulti(c.number));
  else if (!groupsInMessages()) convos = convos.filter((c) => isMulti(c.number) === groupsView); // groups only on their own tab
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
  if (window.flipDesktop) { try { window.flipDesktop.setUnread(conversationsByNumber().filter((c) => c.unread && !archived.has(c.number)).length); } catch (e) { /* not fatal */ } }

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
    const locked = lockedChats().has(number);
    const muteHtml = mutedSet.has(number) ? `<svg class="tl-mute" viewBox="0 0 24 24"><path d="${ICONS.bellOff}"/></svg>` : "";
    item.innerHTML = `
      ${checkHtml}
      ${selected ? `<div class="tl-check">${svgIcon("check", 28)}</div>` : gmAvatarHtml(number)}
      <div class="conversation-item-body">
        <div class="tl-row-top"><div class="name">${pinHtml}${unread ? '<span class="unread-dot">●</span>' : ""}${escapeHtml(displayName(number))}</div>${muteHtml}<div class="time">${formatGm(last.timestamp)}</div></div>
        <div class="preview">${locked ? "Locked chat" : prefix + escapeHtml(preview)}</div>
      </div>
      ${unread && unreadCount > 0 ? `<div class="unread-badge">${unreadCount > 999 ? "999+" : unreadCount}</div>` : ""}
    `;
    const listAv = item.querySelector(".gm-avatar");
    if (listAv && !selected && !conversationSelectionMode) { // tap the picture: that person's (or group's) card, like on the tablet
      listAv.style.cursor = "pointer";
      listAv.addEventListener("click", (e) => { e.stopPropagation(); tlProfileCard(number); });
    }
    item.addEventListener("click", () => {
      if (conversationSelectionMode) toggleConversationSelection(number);
      else openChat(number);
    });
    attachLongPress(item, () => showConversationLongPressMenu(number));
    list.appendChild(item);
  }
}

// ---------- lock a chat: a locked chat asks for the app code before it opens (this browser only) ----------
const chatUnlocked = new Set();
function lockedChatsKey() { return "flip_relay_locked_chats_" + roomId; }
function lockedChats() { try { return new Set(JSON.parse(localStorage.getItem(lockedChatsKey()) || "[]")); } catch (e) { return new Set(); } }
async function toggleChatLock(number) {
  const s = lockedChats();
  if (!s.has(number) && !lockStored()) {
    if (!await gmConfirm("Locking a chat uses the app code, and none is set yet. Set one now?")) return;
    await lockSetNew();
    if (!lockStored()) return;
  }
  if (s.has(number)) {
    const st = lockStored();
    if (st) {
      const r = await lockCard({ title: "Enter your code to unlock this chat", fields: ["Code"], okLabel: "Unlock", extra: [{ label: "Cancel", value: "cancel" }],
        validate: async (v) => ((await lockHash(v[0], st.salt)) === st.hash ? "" : "Wrong code") });
      if (r === "cancel") return;
    }
    s.delete(number);
  } else { s.add(number); chatUnlocked.delete(number); }
  try { localStorage.setItem(lockedChatsKey(), JSON.stringify([...s])); } catch (e) { /* storage blocked */ }
  renderConversationList();
}

function openChat(number) {
  if (lockedChats().has(number) && !chatUnlocked.has(number) && lockStored()) {
    const st = lockStored();
    lockCard({ title: "This chat is locked", text: "Enter your app code to open it.", fields: ["Code"], okLabel: "Open", extra: [{ label: "Cancel", value: "cancel" }],
      validate: async (v) => ((await lockHash(v[0], st.salt)) === st.hash ? "" : "Wrong code") })
      .then((r) => { if (r !== "cancel") { chatUnlocked.add(number); openChat(number); } });
    return;
  }
  currentChatNumber = number;
  el("chat-title").textContent = displayName(number);
  tlChatChrome(number);
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
    .filter((m) => m.number === number && (!chatSearchQ || String(m.body || "").toLowerCase().includes(chatSearchQ)))
    .sort((a, b) => a.timestamp - b.timestamp);

  // like the tablet: a new heading when an hour has passed or the day changed; messages in a run sit close with nearly square joining corners
  const newStretch = (a, b) => b - a > 3600000 || new Date(a).toDateString() !== new Date(b).toDateString();
  const sameRun = (a, b) => !!a && !!b && a.direction === b.direction && a.direction !== "scheduled" && (a.direction === "out" || !isMulti(number) || (a.fromNumber && a.fromNumber === b.fromNumber)) && !newStretch(a.timestamp, b.timestamp);
  const lastOutId = (() => { for (let i = thread.length - 1; i >= 0; i--) if (thread[i].direction === "out") return thread[i].id; return null; })();
  let prevMsg = null, lastShown = 0;
  for (const m of thread) {
    const first = prevMsg === null;
    const needSep = m.direction !== "scheduled" && (first || newStretch(prevMsg.timestamp, m.timestamp));
    const idx = thread.indexOf(m);
    const prevSame = sameRun(prevMsg, m), nextSame = sameRun(m, thread[idx + 1]);
    prevMsg = m;
    if (needSep) {
      const sep = document.createElement("div");
      sep.className = "gm-sep gm-only" + (first ? " first" : "");
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
    row.className = "bubble-row " + (isScheduled ? "out" : m.direction) + (prevSame ? " run-prev" : "") + (nextSame ? " run-next" : "");
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
      const hdrAv = hdr.querySelector(".gm-sender-avatar");
      if (hdrAv && m.fromNumber) { hdrAv.style.cursor = "pointer"; hdrAv.onclick = (ev) => { ev.stopPropagation(); tlProfileCard(normalizeNumber(m.fromNumber) || m.fromNumber); }; }
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
    const isVoice = !m.imageUrl && m.attachmentUrl && (m.attachmentKind === "audio" || m.attachmentType === "audio");
    const attachmentHtml = isVoice ? tlVoiceHtml() : (!m.imageUrl && m.attachmentUrl && m.attachmentKind)
        ? (m.attachmentKind === "video"
            ? `<video class="bubble-video" src="${escapeHtml(m.attachmentUrl)}" controls preload="metadata"></video>`
            : `<a class="bubble-attachment" href="${escapeHtml(m.attachmentUrl)}" target="_blank" rel="noopener">👤 ${escapeHtml(m.attachmentName || "Open contact")}</a>`)
        : "";
    const shownBody = isVoice && /^\s*(🎵\s*)?Audio\s*$/.test(m.body || "") ? "" : m.body;
    let bodyHtml = shownBody ? escapeHtml(shownBody) : "";
    if (chatSearchQ && bodyHtml) { const q = escapeHtml(chatSearchQ).replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); bodyHtml = bodyHtml.replace(new RegExp(q, "gi"), (x) => "<mark>" + x + "</mark>"); }
    const isMedia = !!m.imageUrl || (!!m.attachmentUrl && m.attachmentKind === "video");
    // The circle only appears in selection mode, and never on a scheduled
    // message -- those aren't part of the conversation history to bulk
    // manage the same way, they already have their own tap-to-cancel.
    const showCircle = selectionMode && !isScheduled;
    const circleHtml = showCircle
        ? `<div class="select-circle${selectedMessageIds.has(m.id) ? " checked" : ""}"></div>`
        : "";
    row.innerHTML = `${circleHtml}<div class="bubble${isScheduled ? " scheduled" : ""}${isMedia ? " tl-media" : ""}">${imageHtml}${attachmentHtml}${isMedia && bodyHtml ? '<div class="tl-media-text">' + bodyHtml + "</div>" : bodyHtml}<span class="meta${stuck ? " stuck" : ""}">${meta}</span></div>`;
    { // corners: 20 all round, 4 where a run joins (the sender's side only)
      const b = row.querySelector(".bubble"), big = "20px", small = "4px";
      b.style.borderRadius = isOut || isScheduled
        ? `${big} ${prevSame ? small : big} ${nextSame ? small : big} ${big}`
        : `${prevSame ? small : big} ${big} ${big} ${nextSame ? small : big}`;
      if (isVoice) wireVoice(row, m.attachmentUrl);
    }
    if (stuck) row.classList.add("failed");
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
      t.className = "gm-time gm-only " + (isOut ? "out" : "in") + (stuck ? " stuck" : "") + (row.classList.contains("indent") ? " indent" : "");
      const clock = new Date(m.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      t.textContent = stuck ? "\u25CF Not Sent" : clock + (isOut ? (stillPending ? " \u00B7 Sending..." : m.id === lastOutId ? " \u00B7 Sent" : "") : "");
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

// Same day -> time, this year -> "Jul 14", older -> "Jul 14, 2025" (the tablet's list)
function formatGm(ts) {
  const d = new Date(ts), now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return d.toLocaleDateString([], d.getFullYear() === now.getFullYear() ? { month: "short", day: "numeric" } : { month: "short", day: "numeric", year: "numeric" });
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
function currentTabKey() {
  const pan = document.querySelector(".tl-panel.tl-vm");
  if (pan) return pan.classList.contains("tl-contacts") ? "contacts" : "voicemail";
  if (currentScreenName === "calls") return "calls";
  if (currentScreenName === "conversations") return groupsView ? "groups" : "chats";
  return null;
}
function swipeTo(dx) {
  const cur = currentTabKey();
  if (!cur) return;
  const shown = webScreens().filter((k) => k === cur || screenShown(k));
  const i = shown.indexOf(cur), j = dx < 0 ? i + 1 : i - 1;
  if (i < 0 || j < 0 || j >= shown.length) return;
  const pan = document.querySelector(".tl-panel.tl-vm");
  if (pan) pan.querySelector(".tl-panel-top button").click();
  goTab(shown[j]);
}
(function setupSwipe() {
  let x0 = null, y0 = null;
  document.addEventListener("touchstart", (e) => { x0 = e.touches[0].clientX; y0 = e.touches[0].clientY; }, { passive: true });
  document.addEventListener("touchend", (e) => {
    if (x0 == null || !swipeOn()) { x0 = null; return; }
    const dx = e.changedTouches[0].clientX - x0, dy = e.changedTouches[0].clientY - y0;
    x0 = null;
    if (Math.abs(dx) < 110 || Math.abs(dx) < Math.abs(dy) * 2) return;
    if (selectionMode || conversationSelectionMode) return;
    if (currentScreenName === "calls" && callsTab !== 0) return;
    if (e.target && e.target.closest && e.target.closest("#calls-tabs, input, textarea")) return;
    swipeTo(dx);
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
        await fetch(base + "?auth=" + DATABASE_SECRET + "&x-http-method-override=PATCH", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ approved: !require, name: webDeviceName(), model: webDeviceName(), app: "Web app", firstSeen: now, lastSeen: now }) });
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
  // made once: after the first time its rows live in the Settings sections (organizeSettings), so they must not be made again
  if (!body || document.getElementById("extra-settings") || document.getElementById("show-source-btn")) return;
  const box = document.createElement("div");
  box.id = "extra-settings";
  const mk = (label, fn) => { const b = document.createElement("button"); b.className = "settings-row"; b.textContent = label; b.addEventListener("click", fn); box.appendChild(b); return b; };
  const src = mk("", () => { try { localStorage.setItem(SHOW_SOURCE_KEY, showSourceOn() ? "0" : "1"); } catch (e) { /* blocked */ } src.textContent = "Show where messages were sent from: " + (showSourceOn() ? "On" : "Off"); if (currentChatNumber) renderChat(currentChatNumber); });
  src.textContent = "Show where messages were sent from: " + (showSourceOn() ? "On" : "Off");
  const hg = mk("", () => { try { localStorage.setItem(HIDE_GROUPS_KEY, groupsHidden() ? "0" : "1"); } catch (e) { /* blocked */ } hg.textContent = "Hide group texts (this page only): " + (groupsHidden() ? "On" : "Off"); renderConversationList(); });
  hg.textContent = "Hide group texts (this page only): " + (groupsHidden() ? "On" : "Off");
  const sw = mk("", () => { try { localStorage.setItem(SWIPE_KEY, swipeOn() ? "0" : "1"); } catch (e) { /* blocked */ } sw.textContent = "Swipe between screens: " + (swipeOn() ? "On" : "Off"); });
  sw.textContent = "Swipe between screens: " + (swipeOn() ? "On" : "Off");
  src.id = "show-source-btn"; hg.id = "hide-groups-btn"; sw.id = "swipe-btn";
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
  const [, , , arch, save, restore] = box.children;
  arch.id = "archived-btn"; save.id = "backup-save-btn"; restore.id = "backup-restore-btn";
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
  // Since every page signs in on its own (anonymous sign-in) and the database rules let only a room's own devices in, the database
  // address is not a secret any more: it is built in, and no passphrase is asked for.
  if (!DATABASE_URL) DATABASE_URL = "https://flip-relay-default-rtdb.firebaseio.com";
  if (DATABASE_URL) return;
  if (ENC_CONFIG.indexOf("__") === 0) return; // local/unbuilt copy: nothing encrypted
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(CFG_KEY) || "null"); } catch (e) {}
  if (saved && saved.url) { DATABASE_URL = saved.url; return; }
  await lockCard({
    title: "Enter the site passphrase",
    text: "Asked once on each device. Without it this page cannot reach your messages.",
    fields: ["Passphrase"],
    textKeyboard: true,
    okLabel: "Continue",
    validate: async (v) => {
      try {
        const c = await decryptConfig(v[0].replace(/\s+/g, "").toLowerCase());
        DATABASE_URL = c.url;
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
      i.inputMode = "text"; // letters and numbers (the number-only keyboard made it look like nothing but 123 could be typed)
      i.autocapitalize = "off";
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
    text: "At least 4 letters or numbers. It will be asked every time this app opens.",
    fields: ["New code", "Repeat code"],
    okLabel: "Save",
    extra: opts_cancel(),
    validate: async (v) => {
      if (!/^[A-Za-z0-9]{4,20}$/.test(v[0])) return "Use 4 to 20 letters or numbers.";
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
    // the offer to set a code waits until this page is paired: the very first screen is always the pairing code
    if (!localStorage.getItem(ROOM_KEY)) return;
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

// ====================================================================================================================================
// The web app drawn like the tablet app (see tablet.css): dock, Settings, dialogs, chat header and message box, voice player, Calls.
// ====================================================================================================================================
Object.assign(ICONS, {
  pin: "M16,12V4h1V2H7v2h1v8l-2,2v2h5.2v6h1.6v-6H18v-2l-2,-2z",
  lockOpen: "M12,17c1.1,0 2,-0.9 2,-2s-0.9,-2 -2,-2 -2,0.9 -2,2 0.9,2 2,2zM18,8h-1V6c0,-2.76 -2.24,-5 -5,-5S7,3.24 7,6h1.9c0,-1.71 1.39,-3.1 3.1,-3.1 1.71,0 3.1,1.39 3.1,3.1v2H6c-1.1,0 -2,0.9 -2,2v10c0,1.1 0.9,2 2,2h12c1.1,0 2,-0.9 2,-2V10c0,-1.1 -0.9,-2 -2,-2z",
  edit: "M3,17.25V21h3.75L17.81,9.94l-3.75,-3.75L3,17.25zM20.71,7.04c0.39,-0.39 0.39,-1.02 0,-1.41l-2.34,-2.34c-0.39,-0.39 -1.02,-0.39 -1.41,0l-1.83,1.83 3.75,3.75 1.83,-1.83z",
  copy: "M16,1H4C2.9,1 2,1.9 2,3v14h2V3h12V1zM19,5H8C6.9,5 6,5.9 6,7v14c0,1.1 0.9,2 2,2h11c1.1,0 2,-0.9 2,-2V7c0,-1.1 -0.9,-2 -2,-2zM19,21H8V7h11V21z",
  forward: "M14,9V5l7,7 -7,7v-4.1c-5,0 -8.5,1.6 -11,5.1 1,-5 4,-10 11,-11z",
  chat: "M20,2H4C2.9,2 2,2.9 2,4v18l4,-4h14c1.1,0 2,-0.9 2,-2V4C22,2.9 21.1,2 20,2zM20,16H5.17L4,17.17V4h16V16z",
  call: "M6.62,10.79c1.44,2.83 3.76,5.14 6.59,6.59l2.2,-2.2c0.27,-0.27 0.67,-0.36 1.02,-0.24 1.12,0.37 2.33,0.57 3.57,0.57 0.55,0 1,0.45 1,1V20c0,0.55 -0.45,1 -1,1 -9.39,0 -17,-7.61 -17,-17 0,-0.55 0.45,-1 1,-1h3.5c0.55,0 1,0.45 1,1 0,1.25 0.2,2.45 0.57,3.57 0.11,0.35 0.03,0.74 -0.25,1.02l-2.2,2.2z",
  callMissed: "M19.59,7L12,14.59 6.41,9H11V7H3v8h2v-4.59l7,7 9,-9z",
  callMade: "M9,5v2h6.59L4,18.59 5.41,20 17,8.41V15h2V5z",
  callReceived: "M20,5.41L18.59,4 7,15.59V9H5v10h10v-2H8.41z",
  search: "M15.5,14h-0.79l-0.28,-0.27C15.41,12.59 16,11.11 16,9.5 16,5.91 13.09,3 9.5,3S3,5.91 3,9.5 5.91,16 9.5,16c1.61,0 3.09,-0.59 4.23,-1.57l0.27,0.28v0.79l5,4.99L20.49,19l-4.99,-5zM9.5,14C7.01,14 5,11.99 5,9.5S7.01,5 9.5,5 14,7.01 14,9.5 11.99,14 9.5,14z",
  attach: "M16.5,6v11.5c0,2.21 -1.79,4 -4,4s-4,-1.79 -4,-4V5c0,-1.38 1.12,-2.5 2.5,-2.5s2.5,1.12 2.5,2.5v10.5c0,0.55 -0.45,1 -1,1s-1,-0.45 -1,-1V6H10v9.5c0,1.38 1.12,2.5 2.5,2.5s2.5,-1.12 2.5,-2.5V5c0,-2.21 -1.79,-4 -4,-4S7,2.79 7,5v12.5c0,3.04 2.46,5.5 5.5,5.5s5.5,-2.46 5.5,-5.5V6h-1.5z",
  micWave: "M7,18h2V6H7v12zM11,22h2V2h-2v20zM3,14h2v-4H3v4zM15,18h2V6h-2v12zM19,10v4h2v-4h-2z",
  send: "M2.01,21L23,12 2.01,3 2,10l15,2 -15,2z",
  back: "M20,11H7.83l5.59,-5.59L12,4l-8,8 8,8 1.41,-1.41L7.83,13H20v-2z",
  play: "M8,5v14l11,-7z",
  pause: "M6,19h4V5H6v14zM14,5v14h4V5h-4z",
  check: "M9,16.17L4.83,12l-1.42,1.41L9,19 21,7l-1.41,-1.41z",
  update: "M21,10.12h-6.78l2.74,-2.82c-2.73,-2.7 -7.15,-2.8 -9.88,-0.1 -2.73,2.71 -2.73,7.08 0,9.79s7.15,2.71 9.88,0C18.32,15.65 19,14.08 19,12.1h2c0,1.98 -0.88,4.55 -2.64,6.29 -3.51,3.48 -9.21,3.48 -12.72,0 -3.5,-3.47 -3.53,-9.11 -0.02,-12.58s9.14,-3.47 12.65,0L21,3v7.12z",
});

// a menu row, like GmUi.sheet: a plain icon instead of the emoji at the start of the label
const SHEET_ICONS = { "📌": "pin", "🗄": "archive", "🔕": "bellOff", "🔔": "bell", "🔒": "lock", "🔓": "lockOpen", "☑": "check", "✅": "check", "🚫": "block", "✏": "edit", "ℹ": "info", "📷": "camera", "📸": "camera", "🎥": "video", "🖼": "photo", "👤": "person", "👥": "group", "🗑": "trash", "📋": "copy", "↪": "forward", "➡": "forward", "↩": "reply", "⌨": "dialpad", "💾": "save", "⭐": "star", "⏰": "snooze", "🔍": "search" };
function fillSheetOption(btn, label) {
  const m = /^([\p{Extended_Pictographic}\u2139\u21A9\u21AA\u2611\u2328\u270F\u27A1])\uFE0F?\s+/u.exec(String(label || ""));
  if (!m) { btn.textContent = label; return; }
  const icon = SHEET_ICONS[m[1]] || "info";
  btn.innerHTML = `<span style="display:flex;flex:none;width:24px;height:24px;margin-right:16px">${svgIcon(icon)}</span><span></span>`;
  btn.lastElementChild.textContent = String(label).slice(m[0].length);
}

// ---------- dialogs, like GmUi: rounded card, title 22, text 14, text buttons ----------
function tlDialog(build, wide) {
  return new Promise((resolve) => {
    const dim = document.createElement("div");
    dim.className = "tl-dim";
    const card = document.createElement("div");
    card.className = "tl-dialog" + (wide ? " wide" : "");
    dim.appendChild(card);
    const done = (v) => { dim.remove(); document.removeEventListener("keydown", key, true); resolve(v); };
    let onEnter = null, onEsc = () => done(null);
    const key = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); onEsc(); } else if (e.key === "Enter" && onEnter && !e.shiftKey && !(e.target && e.target.tagName === "TEXTAREA")) { e.preventDefault(); onEnter(); }
    };
    document.addEventListener("keydown", key, true);
    build(card, done, (fn) => { onEnter = fn; }, (fn) => { onEsc = fn; });
    document.body.appendChild(dim);
    const first = card.querySelector("input,textarea");
    if (first) { first.focus(); try { first.select(); } catch (e) { /* not selectable */ } }
  });
}
function tlDialogParts(card, title, text) {
  // a line of its own at the start of the text can be the title
  if (title) { const h = document.createElement("h3"); h.textContent = title; card.appendChild(h); }
  if (text) { const m = document.createElement("div"); m.className = "msg"; m.textContent = text; card.appendChild(m); }
}
function tlButtons(card, list) {
  const b = document.createElement("div");
  b.className = "btns";
  for (const [label, fn] of list) { const x = document.createElement("button"); x.textContent = label; x.onclick = fn; b.appendChild(x); }
  card.appendChild(b);
}
function gmNotice(text, title, extra) {
  return tlDialog((card, done, enter) => {
    tlDialogParts(card, title || "", String(text == null ? "" : text));
    tlButtons(card, [...(extra || []).map(([l, f]) => [l, () => { done(null); f(); }]), ["Close", () => done(null)]]);
    enter(() => done(null));
  }, true);
}
function gmConfirm(text, title, positive) {
  return tlDialog((card, done, enter, esc) => {
    tlDialogParts(card, title || "", String(text == null ? "" : text));
    tlButtons(card, [["Cancel", () => done(false)], [positive || "OK", () => done(true)]]);
    enter(() => done(true)); esc(() => done(false));
  });
}
function gmPrompt(text, value, title, opts) {
  return tlDialog((card, done, enter) => {
    tlDialogParts(card, title || "", title ? String(text || "") : "");
    if (!title && text) { const h = document.createElement("div"); h.className = "msg"; h.style.marginTop = "0"; h.textContent = text; card.appendChild(h); }
    const i = document.createElement(opts && opts.multi ? "textarea" : "input");
    if (opts && opts.multi) i.rows = 3;
    i.value = value == null ? "" : value;
    card.appendChild(i);
    tlButtons(card, [["Cancel", () => done(null)], [(opts && opts.positive) || "OK", () => done(i.value)]]);
    enter(() => done(i.value));
  });
}
window.alert = (t) => { gmNotice(t); };

// a small message at the bottom, like Android's Toast
function tlToast(text) {
  const t = document.createElement("div");
  t.style.cssText = "position:fixed;left:50%;transform:translateX(-50%);bottom:calc(32px + env(safe-area-inset-bottom,0px));z-index:95;padding:10px 16px;border-radius:20px;background:#323232;color:#fff;font-size:14px;max-width:calc(100vw - 32px)";
  t.textContent = text;
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 2600);
}

// ---------- the dock: Chats, Groups, Calls, Voicemail (at the top on the web) ----------
function addTabBars() {
  for (const screen of ["screen-conversations", "screen-calls"]) {
    const sec = document.getElementById(screen);
    if (!sec) continue;
    const old = sec.querySelector(".tl-dock");
    if (old) old.remove();
    const bar = document.createElement("div");
    bar.className = "tl-dock";
    for (const key of webScreens()) {
      const b = document.createElement("button");
      b.className = "tl-dock-item";
      b.dataset.tab = key;
      b.innerHTML = `<span class="tl-dock-pill">${svgIcon(TAB_ICON[key])}</span><span class="tl-dock-label"></span>`;
      b.lastElementChild.textContent = TAB_LABEL[key];
      b.onclick = () => goTab(key);
      bar.appendChild(b);
    }
    const top = sec.querySelector(".topbar");
    if (top) top.after(bar); else sec.prepend(bar);
    const strip = document.getElementById("flip-strip");
    if (strip && strip.parentNode === sec) bar.after(strip);
  }
  updateTabs();
}
function updateTabs() {
  const groupsTab = !groupsHidden() && !groupsInMessages();
  if (!groupsTab && currentTab === "groups") { currentTab = "chats"; groupsView = false; }
  const unreadGroups = groupsTab && conversationsByNumber().some((c) => isMulti(c.number) && c.unread && !archived.has(c.number));
  for (const b of document.querySelectorAll(".tl-dock-item")) {
    b.classList.toggle("on", b.dataset.tab === currentTab);
    if (b.dataset.tab === "groups") { b.hidden = !groupsTab; b.dataset.dot = unreadGroups && currentTab !== "groups" ? "1" : "0"; }
    if (b.dataset.tab === "voicemail") { b.hidden = !vmTabShown(); b.dataset.dot = voicemailUnread > 0 ? "1" : "0"; }
    if (b.dataset.tab === "calls") b.hidden = !callsTabShown();
    if (b.dataset.tab === "contacts") b.hidden = !screenShown("contacts");
    if (b.dataset.tab === "chats") b.hidden = !screenShown("chats");
  }
  document.body.classList.toggle("no-dock", !barShown());
}
let voicemailUnread = 0;
async function pollVoicemailDot() {
  if (!roomId || document.hidden) return;
  try {
    const r = await fetch(roomUrl("voicemails"));
    const o = r.ok ? (await r.json()) || {} : {};
    voicemailUnread = Object.values(o).filter((v) => v && !v.deleted && !v.read).length;
    updateTabs();
  } catch (e) { /* next time */ }
}
setInterval(pollVoicemailDot, 5 * 60000);

// ---------- a row, like SettingsActivity.row(): icon | title + line under it | optional switch ----------
function tlRow(o) {
  const r = document.createElement(o.switchOn === undefined ? "button" : "div");
  r.className = "tl-row" + (o.danger ? " danger" : "");
  r.innerHTML = `<span class="tl-ic">${svgIcon(o.icon || "info")}</span><span class="tl-col"><div class="tl-t"></div>${o.sub ? '<div class="tl-s"></div>' : ""}</span>${o.switchOn === undefined ? "" : `<span class="tl-switch${o.switchOn ? " on" : ""}"></span>`}`;
  r.querySelector(".tl-t").textContent = o.title;
  if (o.sub) r.querySelector(".tl-s").textContent = o.sub;
  if (o.onclick) { r.dataset.click = "1"; r.onclick = o.onclick; }
  return r;
}
// ---------- display size: your own zoom for this page (like the tablet's DPI), saved on this device ----------
const ZOOM_KEY = "flip_relay_web_zoom";
function zoomPct() { try { const v = parseInt(localStorage.getItem(ZOOM_KEY) || "100", 10); return v >= 50 && v <= 250 ? v : 100; } catch (e) { return 100; } }
function applyZoom() { document.documentElement.style.zoom = String(zoomPct() / 100); }
applyZoom();

// ---------- the screens of the bar: Chats, Groups, Calls, Contacts, Voicemail (show, hide, order, and the bar itself) ----------
const TAB_LABEL = { chats: "Chats", groups: "Groups", calls: "Calls", contacts: "Contacts", voicemail: "Voicemail" };
const TAB_ICON = { chats: "forum", groups: "group", calls: "call", contacts: "contacts", voicemail: "voicemail" };
const SCREEN_ORDER_KEY = "flip_relay_web_screen_order", BAR_KEY = "flip_relay_web_bar", CONTACTS_TAB_KEY = "flip_relay_web_contacts_tab", CHATS_TAB_KEY = "flip_relay_web_chats_tab";
function webScreens() {
  const all = Object.keys(TAB_LABEL);
  let saved = [];
  try { saved = JSON.parse(localStorage.getItem(SCREEN_ORDER_KEY) || "[]"); } catch (e) { /* storage blocked */ }
  const out = saved.filter((k, i) => all.includes(k) && saved.indexOf(k) === i);
  for (const k of all) if (!out.includes(k)) out.push(k);
  return out;
}
function saveScreenOrder(o) {
  try { localStorage.setItem(SCREEN_ORDER_KEY, JSON.stringify(o)); } catch (e) { /* storage blocked */ }
  addTabBars(); updateTabs();
}
// Rearrange the bar: hold a screen and drag it where you want it
function openRearrangePanel() {
  const p = openPanel("Rearrange the bar");
  p.body.innerHTML = `<p class="settings-hint">Hold a screen and drag it to a new place. This is also the order you swipe through them.</p><div class="tl-drag-list"></div>`;
  const list = p.body.querySelector(".tl-drag-list");
  for (const key of webScreens()) {
    const r = document.createElement("div");
    r.className = "tl-drag-row"; r.dataset.key = key;
    r.innerHTML = `<span class="ic">${svgIcon(TAB_ICON[key])}</span><span class="nm"></span><span class="grip">\u2261</span>`;
    r.querySelector(".nm").textContent = TAB_LABEL[key];
    if (!screenShown(key)) r.classList.add("off");
    list.appendChild(r);
  }
  let drag = null, timer = null, startY = 0;
  const keys = () => [...list.children].map((c) => c.dataset.key);
  list.addEventListener("pointerdown", (e) => {
    const row = e.target.closest(".tl-drag-row");
    if (!row) return;
    startY = e.clientY;
    const id = e.pointerId;
    timer = setTimeout(() => { drag = row; row.classList.add("dragging"); try { row.setPointerCapture(id); } catch (x) { /* ok */ } }, e.pointerType === "mouse" ? 80 : 300);
  });
  list.addEventListener("pointermove", (e) => {
    if (!drag) { if (timer && Math.abs(e.clientY - startY) > 10) { clearTimeout(timer); timer = null; } return; }
    e.preventDefault();
    for (const other of [...list.children]) {
      if (other === drag) continue;
      const r = other.getBoundingClientRect();
      if (e.clientY > r.top && e.clientY < r.bottom) {
        const down = [...list.children].indexOf(drag) < [...list.children].indexOf(other);
        list.insertBefore(drag, down ? other.nextSibling : other);
        break;
      }
    }
  });
  const end = () => {
    clearTimeout(timer); timer = null;
    if (drag) { drag.classList.remove("dragging"); drag = null; saveScreenOrder(keys()); }
  };
  list.addEventListener("pointerup", end);
  list.addEventListener("pointercancel", end);
}
function prefOn(key, dflt) { try { const v = localStorage.getItem(key); return v === null ? dflt : v !== "0"; } catch (e) { return dflt; } }
function screenShown(key) {
  if (key === "groups") return !groupsHidden() && !groupsInMessages();
  if (key === "calls") return callsTabShown();
  if (key === "voicemail") return vmTabShown();
  if (key === "contacts") return prefOn(CONTACTS_TAB_KEY, true);
  return prefOn(CHATS_TAB_KEY, true);
}
function setScreenShown(key, on) {
  if (key === "groups") { setPref(HIDE_GROUPS_KEY, !on); groupsView = false; renderConversationList(); }
  else if (key === "calls") setPref("flip_relay_web_calls_tab", on);
  else if (key === "voicemail") setPref("flip_relay_web_vm_tab", on);
  else if (key === "contacts") setPref(CONTACTS_TAB_KEY, on);
  else setPref(CHATS_TAB_KEY, on);
}
function barShown() { return prefOn(BAR_KEY, true); }
function screenHint(key) {
  const on = screenShown(key);
  if (key === "groups") return on ? "Shown - group and mass texts have their own tab" : "Hidden - group and mass texts are not shown here or are in the Chats list";
  if (key === "calls") return on ? "Shown - the call log" : "Hidden - not in the bar";
  if (key === "voicemail") return on ? "Shown - voicemail from the flip phone" : "Hidden - not in the bar";
  if (key === "contacts") return on ? "Shown - everyone the flip phone knows by name, A to Z" : "Hidden - not in the bar";
  return on ? "Shown - your conversations" : "Hidden - not in the bar (the page still opens on it)";
}


function setPref(key, on, onVal, offVal) { try { localStorage.setItem(key, on ? (onVal || "1") : (offVal || "0")); } catch (e) { /* storage blocked */ } }
function clickOld(id) { const b = document.getElementById(id); if (b) b.click(); }

// ---------- Settings: the same sections and rows as the tablet ----------
const TL_SECTIONS = [
  ["layout", "tablet", "Layout and screens", "Layout, theme, swipe, and the screens in the bar"],
  ["messages", "archive", "Messages", "Archived, Trash, backup and restore, blocked and muted"],
  ["features", "star", "Messages features", "Undo send, I'm busy, automatic replies, needs a reply"],
  ["notifications", "bell", "Notifications", "New-message notifications on this device"],
  ["privacy", "info", "Privacy", "Lock the app with a code"],
  ["phone", "history", "Flip phone and sync", "Default texting app, sync messages and attachments, where the phone is"],
  ["help", "systemUpdate", "Help and updates", "Reload, crash log"],
  ["layoutpage", "tablet", "Layout", ""],
  ["screens", "group", "Screens and the bar", ""],
];
const TL_MAIN = ["layout", "notifications", "privacy", "phone", "help"];
let settingsFromDrawer = null;
function openSettingsFromDrawer(key) { settingsFromDrawer = key; onSettingsClick(); if (key) openSettingsSection(key); }
function tlSettingsBack() {
  const k = settingsSectionOpen;
  if (k === "layoutpage" || k === "screens") { openSettingsSection("layout"); return true; }
  if (k === "trash") { openSettingsSection("messages"); return true; }
  if (k && k === settingsFromDrawer) { settingsFromDrawer = null; openSettingsSection(null); showScreen("conversations"); return true; }
  return false;
}
function vmTabShown() { try { return localStorage.getItem("flip_relay_web_vm_tab") !== "0"; } catch (e) { return true; } }
function callsTabShown() { try { return localStorage.getItem("flip_relay_web_calls_tab") !== "0"; } catch (e) { return true; } }
function tlRowsFor(key) {
  const redraw = () => openSettingsSection(key);
  const sw = (title, sub, icon, get, set) => tlRow({ title, sub, icon, switchOn: get(), onclick: () => { set(!get()); redraw(); } });
  switch (key) {
    case "layout": return [
      tlRow({ icon: "tablet", title: "Layout", sub: (LAYOUT_LABELS[storedLayout()] || LAYOUT_LABELS.auto) + "  ·  theme", onclick: () => openSettingsSection("layoutpage") }),
      tlRow({ icon: "group", title: "Groups, Calls and Voicemail", sub: "Show or hide each one", onclick: () => openSettingsSection("screens") }),
    ];
    case "screens": {
      const rows = [sw("Show the bar", barShown() ? "On - the bar with Chats, Groups, Calls, Contacts and Voicemail" : "Off - no bar (the tabs are still reachable from the menus)", "tablet", barShown, (v) => { setPref(BAR_KEY, v); updateTabs(); })];
      rows.push(tlRow({ icon: "tablet", title: "Rearrange the bar", sub: "Hold a screen and drag it where you want it (the swipe follows)", onclick: openRearrangePanel }));
      for (const key of webScreens()) {
        const r = sw(TAB_LABEL[key], screenHint(key), TAB_ICON[key], () => screenShown(key), (v) => { setScreenShown(key, v); updateTabs(); });
        rows.push(r);
      }
      rows.push(sw("Show groups in Messages", groupsInMessages() ? "On - group texts are in the Chats list" : "Off - group texts have their own Groups tab", "group", groupsInMessages, (v) => { setPref(GROUPS_IN_MSGS_KEY, v); groupsView = false; currentTab = "chats"; renderConversationList(); updateTabs(); }));
      return rows;
    }
    case "layoutpage": return [
      ...(zoomPct() !== 100 ? [tlRow({ icon: "restart", title: "Reset display size to default", sub: "Back to 100%", onclick: () => { try { localStorage.removeItem(ZOOM_KEY); } catch (e) { /* storage blocked */ } applyZoom(); redraw(); } })] : []),
      tlRow({ icon: "tablet", title: "Display size", sub: zoomPct() + "%  ·  tap to type your own (50 to 250, 100 is normal)", onclick: async () => {
        const t = await gmPrompt("", String(zoomPct()), "Display size in percent", { positive: "Apply" });
        if (t === null || t === undefined) return;
        const v = parseInt(String(t).trim() || "100", 10);
        if (!(v >= 50 && v <= 250)) { gmNotice("Type a number from 50 to 250."); return; }
        try { localStorage.setItem(ZOOM_KEY, String(v)); } catch (e) { /* storage blocked */ }
        applyZoom(); redraw();
      } }),
      tlRow({ icon: "tablet", title: "Layout", sub: (LAYOUT_LABELS[storedLayout()] || LAYOUT_LABELS.auto) + "  ·  side by side, or one screen at a time", onclick: async () => { clickOld("layout-btn"); } }),
      tlRow({ icon: "palette", title: "Theme", sub: { light: "Light", dark: "Dark" }[themeMode()] || "System default", onclick: async () => {
        const m = await showActionSheet("Theme", [{ label: "System default", value: "system" }, { label: "Light", value: "light" }, { label: "Dark", value: "dark" }]);
        if (m) { try { localStorage.setItem(THEME_KEY, m); } catch (e) { /* storage blocked */ } applyTheme(); redraw(); }
      } }),
      sw("Swipe between screens", "Swipe left and right to move between Chats, Groups and Calls", "swipe", swipeOn, (v) => setPref(SWIPE_KEY, v)),
      sw("Show where messages were sent from", "An icon beside each sent message: the phone or this page", "info", showSourceOn, (v) => { setPref(SHOW_SOURCE_KEY, v); if (currentChatNumber) renderChat(currentChatNumber); }),
    ];
    case "messages": return [
      tlRow({ icon: "doneAll", title: "Mark all as read", sub: "Every conversation, here and on the flip phone", onclick: () => clickOld("mark-all-read-btn") }),
      tlRow({ icon: "archive", title: "Archived", sub: "Conversations you put away", onclick: () => clickOld("archived-btn") }),
      tlRow({ icon: "trash", title: "Trash", sub: "Chats deleted in the last 30 days", onclick: () => openSettingsSection("trash") }),
      tlRow({ icon: "call", title: "Default calling app", sub: defaultCallApp() === "ask" ? "Ask every time" : (CALL_APPS.find((a) => a.id === defaultCallApp()) || {}).label, onclick: async () => {
        const c = await showActionSheet("Default calling app", [{ label: "Ask every time", value: "ask" }, ...CALL_APPS.map((a) => ({ label: a.label, value: a.id }))]);
        if (c) { try { if (c === "ask") localStorage.removeItem(CALL_APP_KEY); else localStorage.setItem(CALL_APP_KEY, c); } catch (e) { /* storage blocked */ } redraw(); }
      } }),
      tlRow({ icon: "save", title: "Backup and restore", sub: "Save this page's settings to a file, or set it up again from one", onclick: async () => {
        const c = await showActionSheet("Backup and restore", [{ label: "Save to a file", value: "s" }, { label: "Restore from a file", value: "r" }]);
        if (c === "s") clickOld("backup-save-btn"); else if (c === "r") clickOld("backup-restore-btn");
      } }),
      tlRow({ icon: "block", title: "Blocked numbers", sub: "Block a number, see who is blocked, unblock (same list as the flip phone)", onclick: showBlockedList }),
      tlRow({ icon: "bellOff", title: "Muted conversations", sub: "See every muted conversation and unmute (same as the flip phone)", onclick: showMutedList }),
    ];
    case "features": {
      const busy = tlRow({ icon: "snooze", title: "I'm busy", sub: "Checking...", onclick: toggleBusyFromWeb });
      busy.id = "tl-busy-btn";
      refreshBusyRow(busy);
      return [
        sw("Undo send", "A message waits 5 seconds with an Undo button before it goes out", "undo", undoSendOn, (v) => setPref(UNDO_KEY, v, "on", "off")),
        busy,
        tlRow({ icon: "reply", title: "Automatic replies", sub: "A message for one person: when they text, when you decline their call, when you miss it", onclick: openAutoRepliesPanel }),
        tlRow({ icon: "reply", title: "Needs a reply", sub: "Conversations whose last message is waiting for you", onclick: showNeedsReply }),
        tlRow({ icon: "reply", title: "Quick replies", sub: "The ready-made texts under each call: " + quickReplies().length + " saved", onclick: manageQuickReplies }),
      ];
    }
    case "notifications": {
      const perm = !("Notification" in window) ? "Not available on this device" : Notification.permission === "granted" ? "On (only while this page or the desktop app is running; muted chats stay quiet)" : Notification.permission === "denied" ? "Blocked. Allow them in the browser's site settings" : "Off. Tap to allow";
      return [tlRow({ icon: "bell", title: "Notification settings", sub: perm, onclick: async () => {
        if (!("Notification" in window)) return;
        if (Notification.permission === "default") { await Notification.requestPermission(); redraw(); }
        else gmNotice(Notification.permission === "granted" ? "Notifications are on. To turn them off, use the browser's site settings (the icon left of the address)." : "Notifications are blocked for this page. Allow them in the browser's site settings (the icon left of the address).");
      } })];
    }
    case "privacy": return [tlRow({ icon: "lock", title: "Lock the app", sub: lockStored() ? "On. Tap to change or remove the code" : "Off. Tap to set a code", onclick: async () => { clickOld("app-lock-btn"); setTimeout(redraw, 400); } })];
    case "phone": {
      const def = tlRow({ icon: "info", title: "Flip phone: default texting app", sub: "Checking..." });
      const info = tlRow({ icon: "phone", title: "Flip phone: app build and number", sub: "Checking..." });
      (async () => {
        try {
          const ps = await (await fetch(roomUrl("phoneState"))).json();
          def.querySelector(".tl-s").textContent = ps ? (ps.defaultSms ? "Yes - Message+" : "NO - " + (ps.app || "another app") + " is the default") : "Not reported yet";
          if (ps && !ps.defaultSms) def.querySelector(".tl-s").style.color = "var(--gm-red)";
          const b = await (await fetch(roomUrl("builds"))).json();
          const phone = b && Object.values(b).find((x) => x && x.k === "phone");
          info.querySelector(".tl-s").textContent = phone ? "Message+ build " + phone.b : "Not reported yet";
        } catch (e) { /* no connection: the lines stay as they are */ }
      })();
      return [
        tlRow({ icon: "place", title: "Where is the phone?", sub: "Ask the phone for its location, only when you press Locate", onclick: openLocatePanel }),
        def, info,
        tlRow({ icon: "sync", title: "Sync messages and attachments", sub: "Progress from the flip phone, and Sync now", onclick: openSyncPanel }),
        tlRow({ icon: "history", title: "Sync log", sub: "Recent syncs from the phone", onclick: () => clickOld("sync-log-btn") }),
        tlRow({ icon: "phone", title: "Flip phone buttons", sub: "Which home-screen buttons open Message+, one switch each, and troubleshooting", onclick: openPhoneButtons }),
        tlRow({ icon: "voicemail", title: "Voicemail", sub: "Play, delete, check for new voicemail", onclick: openVoicemailPanel }),
      ];
    }
    case "help": return [
      tlRow({ icon: "restart", title: "Restart the app", sub: "Reloads the page, if something does not update", onclick: () => location.reload() }),
      tlRow({ icon: "info", title: "Crash log", sub: "Flip phone and tablets: why one closed by itself, if it ever did", onclick: openCrashLog }),
      ...(window.flipDesktop ? (window.flipDesktop.version ? [] : [tlRow({ icon: "update", title: "Update the Windows app", sub: "A newer Message+ for Windows is out: voicemail plays inside the app, you can pick WhatsApp or Skype to call with. Download and run it, it replaces this one", onclick: () => window.open("https://github.com/avrohomgolo-coder/flip-relay-web/releases/latest", "_blank") })])
        : [tlRow({ icon: "tablet", title: "Desktop app for Windows", sub: "Its own window, starts with Windows, and notifications even with the window closed", onclick: () => window.open("https://github.com/avrohomgolo-coder/flip-relay-web/releases/latest", "_blank") })]),
      tlRow({ icon: "update", title: "Version", sub: "The web app is always the newest version; it updates by itself when it reloads" }),
    ];
  }
  return [];
}
function organizeSettings() {
  const body = el("settings-body");
  if (!body || body.dataset.tl === "1") return;
  body.dataset.tl = "1";
  const old = document.createElement("div");
  old.id = "tl-old";
  const trash = document.createElement("div");
  trash.id = "tl-trash";
  trash.hidden = true;
  for (const n of [...body.children]) (n.matches(".settings-heading-row,.settings-hint,#deleted-selection-toolbar,#deleted-list,#deleted-empty-state") ? trash : old).appendChild(n);
  const main = document.createElement("div");
  main.id = "tl-settings-main";
  const page = document.createElement("div");
  page.id = "tl-settings-page";
  body.append(old, main, page, trash);
}
function openSettingsSection(key) {
  settingsSectionOpen = key;
  const main = el("tl-settings-main"), page = el("tl-settings-page"), trash = el("tl-trash");
  if (!main) return;
  main.hidden = !!key; page.hidden = !key || key === "trash"; trash.hidden = key !== "trash";
  const h = document.querySelector("#screen-settings .topbar h2");
  const title = key === "trash" ? "Trash" : key ? (TL_SECTIONS.find((s) => s[0] === key) || [])[2] : "Messages settings";
  if (h) h.textContent = title;
  if (!key) {
    main.innerHTML = "";
    const q = document.createElement("input");
    q.id = "tl-search";
    q.placeholder = "Search settings";
    q.autocomplete = "off";
    main.appendChild(q);
    const results = document.createElement("div");
    const normal = document.createElement("div");
    const list = document.createElement("div");
    list.className = "tl-group";
    for (const [k, icon, t, sub] of TL_SECTIONS) if (TL_MAIN.includes(k)) list.appendChild(tlRow({ icon, title: t, sub, onclick: () => openSettingsSection(k) }));
    normal.appendChild(list);
    const ah = document.createElement("div");
    ah.className = "tl-heading";
    ah.textContent = "Account";
    normal.appendChild(ah);
    const acct = document.createElement("div");
    acct.className = "tl-group";
    acct.appendChild(tlRow({ icon: "logout", title: "Disconnect this page", sub: "You'll need the pairing code again to reconnect", danger: true, onclick: () => clickOld("disconnect-btn") }));
    normal.appendChild(acct);
    main.append(results, normal);
    q.oninput = () => {
      const s = q.value.trim().toLowerCase();
      results.innerHTML = "";
      normal.hidden = !!s;
      if (!s) return;
      const g = document.createElement("div");
      g.className = "tl-group";
      for (const [k, , t] of TL_SECTIONS) for (const r of tlRowsFor(k)) {
        const title2 = r.querySelector(".tl-t").textContent, sub2 = r.querySelector(".tl-s") ? r.querySelector(".tl-s").textContent : "";
        if (!(title2 + " " + sub2).toLowerCase().includes(s) || !r.onclick) continue;
        const click = r.onclick;
        const hit = tlRow({ icon: "search", title: title2, sub: "In " + t + (sub2 ? "  ·  " + sub2 : ""), onclick: () => { openSettingsSection(k); if (!r.querySelector(".tl-switch")) click(); } });
        g.appendChild(hit);
      }
      if (!g.children.length) g.appendChild(tlRow({ icon: "info", title: `No setting matches "${q.value.trim()}"`, sub: "Try another word, for example busy, sync, blocked, theme" }));
      results.appendChild(g);
    };
  } else if (key !== "trash") {
    page.innerHTML = "";
    const g = document.createElement("div");
    g.className = "tl-group";
    for (const r of tlRowsFor(key)) g.appendChild(r);
    page.appendChild(g);
  }
  el("settings-body").scrollTop = 0;
}
async function refreshBusyRow(row) {
  try {
    const r = await fetch(roomUrl("busyMode"));
    const j = r.ok ? await r.json() : null;
    const on = !!(j && j.on && (!j.endsAt || j.endsAt > Date.now()));
    const until = on && j.endsAt ? " until " + new Date(j.endsAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    row.querySelector(".tl-s").textContent = on ? "On" + until + ". Texts are answered automatically by the tablets" : "Off. One switch that texts back whoever writes or calls while you are busy";
  } catch (e) { row.querySelector(".tl-s").textContent = "Could not check (no connection)"; }
}
function refreshBusyLabel() { const b = document.getElementById("tl-busy-btn"); if (b) refreshBusyRow(b); }

async function manageQuickReplies() {
  const mine = quickCustom();
  const c = await showActionSheet("Quick replies", [{ label: "Add your own reply", value: "+" }, ...mine.map((t) => ({ label: "Remove: " + t, value: t }))]);
  if (c === "+") { const t = await gmPrompt("", "", "New quick reply", { positive: "Save" }); if (t && t.trim()) addQuickReply(t.trim()); }
  else if (c) { try { localStorage.setItem(QUICK_KEY, JSON.stringify(mine.filter((x) => x !== c))); } catch (e) { /* storage blocked */ } }
  if (settingsSectionOpen === "features") openSettingsSection("features");
}

// ---------- full-page screens ----------
function openPanel(title) {
  const ov = document.createElement("div");
  ov.className = "tl-panel";
  ov.innerHTML = `<div class="tl-panel-top"><button class="icon-btn tl-back" title="Back" style="margin:0">${svgIcon("back")}</button><h2></h2></div><div class="tl-panel-body"></div>`;
  ov.querySelector("h2").textContent = title;
  document.body.appendChild(ov);
  let alive = true; const closers = [];
  ov.querySelector("button").onclick = () => { alive = false; closers.forEach((f) => f()); ov.remove(); };
  return { ov, body: ov.lastElementChild, alive: () => alive, onClose: (f) => closers.push(f) };
}

// Automatic replies: the same list as the tablet (rooms/<room>/personRules/<number>); the tablets that have the feature on send them
async function openAutoRepliesPanel() {
  const p = openPanel("Automatic replies");
  const load = async () => {
    let o = null;
    try { const r = await fetch(roomUrl("personRules")); if (r.ok) o = (await r.json()) || {}; } catch (e) { /* offline */ }
    p.body.innerHTML = `<p class="settings-hint">A message for one person: when they text you, when you decline their call, when you miss it. The tablets send them; a tablet with the feature switched off does not.</p>`;
    if (!o) { p.body.append("Could not load the list (no internet?)"); return; }
    const g = document.createElement("div");
    g.className = "tl-group";
    g.appendChild(tlRow({ icon: "reply", title: "Add a person", onclick: async () => {
      const people = conversationsByNumber().filter((c) => !isMulti(c.number)).slice(0, 60);
      const n = await showActionSheet("Who?", [{ label: "Type a number", value: "#" }, ...people.map((c) => ({ label: displayName(c.number) || c.number, value: c.number }))]);
      if (!n) return;
      let num = n;
      if (n === "#") { const t = await gmPrompt("", "", "Phone number"); num = t && normalizeNumber(t); if (!num) return; }
      editAutoReply(num, o[String(num).replace(/\D/g, "")] || {}, load);
    } }));
    for (const [k, r] of Object.entries(o)) {
      if (!r || !(r.t || r.d || r.m)) continue;
      const num = r.n || k;
      const parts = [r.t ? "when they text" : "", r.d ? "declined call" : "", r.m ? "missed call" : ""].filter(Boolean).join(", ");
      g.appendChild(tlRow({ icon: "person", title: displayName(normalizeNumber(num)) || num, sub: parts, onclick: () => editAutoReply(num, r, load) }));
    }
    p.body.appendChild(g);
  };
  load();
}
async function editAutoReply(number, r, reload) {
  const p = openPanel(displayName(normalizeNumber(number)) || number);
  const cur = { t: !!r.t, tt: r.tt || "", te: r.te || 5 * 3600e3, d: !!r.d, dt: r.dt || "", m: !!r.m, mt: r.mt || "" };
  const draw = () => {
    p.body.innerHTML = "";
    const g = document.createElement("div");
    g.className = "tl-group";
    const add = (flag, field, title, sub) => {
      g.appendChild(tlRow({ icon: "reply", title, sub: cur[flag] ? (cur[field] || "(no message yet)") : sub, switchOn: cur[flag], onclick: async () => {
        if (cur[flag]) { cur[flag] = false; draw(); return; }
        const t = await gmPrompt("", cur[field], title, { multi: true, positive: "Turn on" });
        if (t !== null && t.trim()) { cur[field] = t.trim(); cur[flag] = true; draw(); }
      } }));
    };
    add("t", "tt", "When they text", "Off. At most one reply every " + Math.round(cur.te / 3600e3) + " hours");
    add("d", "dt", "When you decline their call", "Off");
    add("m", "mt", "When you miss their call", "Off");
    p.body.appendChild(g);
    const save = tlRow({ icon: "check", title: "Save", onclick: async () => {
      const key = String(normalizeNumber(number) || number).replace(/\D/g, "");
      try {
        const res = await fetch(roomUrl("personRules/" + key), { method: "PUT", body: JSON.stringify({ n: normalizeNumber(number) || number, ...cur }) });
        if (!res.ok) throw new Error(res.status);
        p.ov.querySelector("button").click();
        reload();
      } catch (e) { gmNotice("Not saved: no connection."); }
    } });
    const sg = document.createElement("div");
    sg.className = "tl-group";
    sg.appendChild(save);
    p.body.appendChild(sg);
  };
  draw();
}

// Crash log: what the flip phone and the tablets reported
async function openCrashLog() {
  const p = openPanel("Crash log");
  p.body.textContent = "Loading...";
  const out = [];
  for (const [path, who] of [["phoneCrashes", "Flip phone"], ["tabletCrashes", "Tablet"]]) {
    try {
      const r = await fetch(roomUrl(path) + "&orderBy=%22$key%22&limitToLast=15");
      const o = r.ok ? (await r.json()) || {} : {};
      for (const [k, v] of Object.entries(o)) out.push({ at: (v && (v.at || v.time || v.timestamp)) || parseInt(k, 10) || 0, who, text: typeof v === "string" ? v : (v && (v.text || v.trace || v.stack || v.note)) || JSON.stringify(v) });
    } catch (e) { /* skip */ }
  }
  out.sort((a, b) => b.at - a.at);
  p.body.innerHTML = out.length ? "" : `<p class="settings-hint">Nothing reported.</p>`;
  for (const c of out) {
    const card = document.createElement("div");
    card.className = "tl-card";
    card.innerHTML = `<div class="tl-t" style="font-size:16px"></div><pre style="white-space:pre-wrap;overflow-wrap:anywhere;font-size:12px;margin:8px 0 0"></pre>`;
    card.firstElementChild.textContent = c.who + (c.at ? " · " + new Date(c.at).toLocaleString() : "");
    card.lastElementChild.textContent = String(c.text).slice(0, 3000);
    p.body.appendChild(card);
  }
}

// ---------- the chat's top bar and message box ----------
function setupTabletChrome() {
  // back arrows as the tablet's icon
  for (const b of document.querySelectorAll(".topbar .icon-btn")) {
    if (b.textContent.trim() === "←") { b.innerHTML = svgIcon("back"); b.classList.add("tl-back"); }
  }
  const gear = el("gm-settings-btn");
  if (gear && !gear.querySelector("img")) {
    gear.innerHTML = '<img src="app-icon.png" alt="Message+ menu">';
    gear.title = "Message+ menu";
    gear.addEventListener("click", (e) => { e.stopImmediatePropagation(); openTabletMenu(); }, { capture: true });
  }
  setupSelectionBar();
  const callsTop = document.querySelector("#screen-calls .topbar");
  if (callsTop && !callsTop.querySelector(".tl-menu-btn")) {
    const rf = document.getElementById("calls-refresh-btn");
    const sb = tlSearchButton(() => {
      if (!document.getElementById("calls-search")) renderCallsList();
      const box = document.getElementById("calls-search");
      box.hidden = !box.hidden;
      if (box.hidden) { box.value = ""; callsQuery = ""; renderCallsList(); } else box.focus();
    });
    sb.style.marginLeft = "auto";
    if (rf) rf.before(sb); else callsTop.appendChild(sb);
    callsTop.appendChild(tlMenuButton());
  }
  for (const b of document.querySelectorAll("#screen-calls .topbar button")) {
    if (b.textContent.trim() === "\u21bb" || b.textContent.trim() === "↻") { b.innerHTML = svgIcon("sync"); b.classList.add("tl-chat-btn"); b.style.color = "var(--gm-blue)"; b.style.marginLeft = "auto"; }
  }
  const input = el("compose-input"), attach = el("attach-btn"), send = el("send-btn");
  if (!input || document.querySelector(".tl-bar")) return;
  const bar = document.createElement("div");
  bar.className = "tl-bar";
  input.parentNode.insertBefore(bar, input);
  attach.innerHTML = svgIcon("attach");
  bar.append(attach, input);
  for (const [icon, title, fn] of [["person", "Contact", () => attachContact()], ["camera", "Camera", () => attachFrom("camera")], ["photo", "Gallery", () => attachFrom("gallery")]]) {
    const b = document.createElement("button");
    b.className = "tl-bar-ic";
    b.type = "button";
    b.title = title;
    b.innerHTML = svgIcon(icon);
    b.onclick = fn;
    bar.appendChild(b);
  }
  input.placeholder = input.placeholder || "Text message";
  const grow = () => { input.style.height = "48px"; input.style.height = Math.min(110, Math.max(48, input.scrollHeight)) + "px"; updateSendIcon(); };
  input.addEventListener("input", grow);
  send.addEventListener("click", () => setTimeout(grow, 0));
  setInterval(updateSendIcon, 800);
  updateSendIcon();
}
function updateSendIcon() {
  const send = el("send-btn"), input = el("compose-input");
  if (!send || !input) return;
  const hasIt = input.value.trim().length > 0 || (typeof stagedAttachments !== "undefined" && stagedAttachments.length > 0) || !!pendingAttachmentFile;
  const want = hasIt ? "send" : "micWave";
  if (send.dataset.icon !== want) { send.dataset.icon = want; send.innerHTML = svgIcon(want, 26); send.title = hasIt ? "Send (hold to schedule)" : "Record a voice message"; }
}
async function attachFrom(pick) {
  const live = pick === "camera";
  const picked = await pickFile({ accept: pick === "gallery" ? "image/*,video/*" : "image/*", capture: live ? "environment" : null, multiple: !live });
  const files = Array.isArray(picked) ? picked : (picked ? [picked] : []);
  for (const file of files) {
    if (file.size > 60 * 1024 * 1024) { gmNotice(file.name + " is too large to send (over 60MB) and was left out."); continue; }
    setPendingAttachment(file, (file.type || "").startsWith("video/") ? "video" : "photo", null);
  }
}
let chatSearchQ = "";
function tlChatChrome(number) {
  const title = el("chat-title");
  if (!title) return;
  const top = title.closest(".topbar");
  const block = title.parentElement;
  block.style.flex = "1 1 0"; block.style.minWidth = "0";
  let av = top.querySelector(".tl-chat-avatar");
  if (!av) { av = document.createElement("div"); av.className = "tl-chat-avatar"; top.insertBefore(av, block); }
  av.innerHTML = gmAvatarHtml(number);
  av.style.cursor = "pointer";
  av.onclick = () => tlProfileCard(number);
  block.style.cursor = "pointer";
  block.onclick = () => tlProfileCard(number);
  applyChatTheme(number);
  let box = top.querySelector(".tl-chat-btns");
  if (!box) { box = document.createElement("div"); box.className = "tl-chat-btns"; box.style.cssText = "display:flex;flex:none"; block.after(box); }
  box.innerHTML = "";
  const btn = (icon, t, fn) => { const b = document.createElement("button"); b.className = "tl-chat-btn"; b.title = t; b.innerHTML = svgIcon(icon); b.onclick = fn; box.appendChild(b); };
  btn("search", "Search conversation", () => toggleChatSearch());
  // nobody calls from a computer: the call button offers the quick replies (holding it does the same on the tablet)
  if (!isMulti(number)) btn("call", "Quick replies", () => quickReplySheet(number));
  closeChatSearch();
}
async function quickReplySheet(number) {
  const name = displayName(number) || number;
  const c = await showActionSheet("Quick replies — " + name, [...quickReplies().map((t) => ({ label: t, value: t })), { label: "Add your own reply", value: "\u0000add" }]);
  if (c === "\u0000add") { const t = await gmPrompt("", "", "New quick reply", { positive: "Save" }); if (t && t.trim()) addQuickReply(t.trim()); return; }
  if (c) sendQuick(number, c, name);
}
// Chat theme: a photo, faint and see-through, behind a chat's messages (kept on this device, like the tablet)
function chatThemeKey(number) { return "flip_relay_web_theme_" + roomId + "_" + number; }
function applyChatTheme(number) {
  const list = el("message-list");
  let url = null;
  try { url = localStorage.getItem(chatThemeKey(number)); } catch (e) { /* storage blocked */ }
  if (!url) { list.style.backgroundImage = ""; return; }
  const dark = document.body.classList.contains("theme-dark") || (!document.body.classList.contains("theme-light") && matchMedia("(prefers-color-scheme: dark)").matches);
  const veil = dark ? "rgba(30,32,39,.72)" : "rgba(249,249,255,.72)";
  list.style.backgroundImage = `linear-gradient(${veil},${veil}),url("${url}")`;
  list.style.backgroundSize = "cover";
  list.style.backgroundPosition = "center";
}
async function chatThemeMenu(number) {
  const c = await showActionSheet("Chat theme", [{ label: "Choose a photo", value: "pick" }, { label: "No photo", value: "none" }]);
  if (c === "none") { try { localStorage.removeItem(chatThemeKey(number)); } catch (e) { /* storage blocked */ } applyChatTheme(number); return; }
  if (c !== "pick") return;
  const f = await pickFile({ accept: "image/*" });
  const file = Array.isArray(f) ? f[0] : f;
  if (!file) return;
  const img = await createImageBitmap(file);
  const scale = Math.min(1, 1000 / Math.max(img.width, img.height));
  const cv = document.createElement("canvas");
  cv.width = Math.round(img.width * scale); cv.height = Math.round(img.height * scale);
  cv.getContext("2d").drawImage(img, 0, 0, cv.width, cv.height);
  try { localStorage.setItem(chatThemeKey(number), cv.toDataURL("image/jpeg", 0.75)); } catch (e) { gmNotice("That photo could not be saved on this device."); return; }
  applyChatTheme(number);
}

function closeChatSearch() {
  const s = document.getElementById("tl-chat-search"), g = document.getElementById("tl-chat-gallery");
  if (s) s.remove();
  if (g) g.remove();
  chatSearchQ = "";
  const t = el("chat-title"), list = el("message-list");
  if (t) t.closest(".topbar").hidden = false;
  if (list) list.hidden = false;
}
function toggleChatSearch() {
  if (document.getElementById("tl-chat-search")) { closeChatSearch(); if (currentChatNumber) renderChat(currentChatNumber); return; }
  const top = el("chat-title").closest(".topbar"), list = el("message-list");
  const s = document.createElement("div");
  s.id = "tl-chat-search";
  s.innerHTML = `<div class="pill"><button class="tl-chat-btn" title="Back">${svgIcon("back")}</button><input placeholder="Search conversation" autocomplete="off"><button class="tl-chat-btn" title="Clear">${svgIcon("close")}</button></div><div class="chips"></div>`;
  top.after(s);
  top.hidden = true;
  const g = document.createElement("div");
  g.id = "tl-chat-gallery";
  list.before(g);
  const mine = messages.filter((m) => m.number === currentChatNumber && m.direction !== "scheduled");
  const images = mine.filter((m) => m.imageUrl), videos = mine.filter((m) => m.attachmentKind === "video" && m.attachmentUrl);
  const phones = [...new Set(mine.flatMap((m) => String(m.body || "").match(/\+?\d[\d\s().-]{8,}\d/g) || []))];
  let only = null;
  const draw = () => {
    g.innerHTML = "";
    const sec = (key, title, fill) => {
      if (only && only !== key) return;
      const h = document.createElement("div"); h.className = "tl-gal-h"; h.textContent = title; g.appendChild(h);
      const b = document.createElement("div"); b.className = key === "phones" ? "tl-gal-list" : "tl-gal"; g.appendChild(b); fill(b);
    };
    if (images.length) sec("images", "Images", (b) => { for (const m of images.slice().reverse()) { const i = document.createElement("img"); i.loading = "lazy"; i.src = m.imageUrl; i.onclick = () => window.open(m.imageUrl, "_blank"); b.appendChild(i); } });
    if (videos.length) sec("videos", "Videos", (b) => { for (const m of videos.slice().reverse()) { const v = document.createElement("div"); v.className = "tl-gal-v"; v.innerHTML = svgIcon("play"); v.onclick = () => window.open(m.attachmentUrl, "_blank"); b.appendChild(v); } });
    if (phones.length) sec("phones", "Phone numbers", (b) => { for (const n of phones) b.appendChild(tlRow({ icon: "phone", title: n })); });
  };
  const chips = s.querySelector(".chips");
  for (const [key, label] of [["images", "Images"], ["videos", "Videos"], ["phones", "Phone numbers"]]) {
    const c = document.createElement("button");
    c.className = "tl-chip";
    c.textContent = label;
    c.onclick = () => { only = only === key ? null : key; for (const x of chips.children) x.classList.toggle("on", x === c && !!only); draw(); };
    chips.appendChild(c);
  }
  const i = s.querySelector("input");
  const apply = () => {
    chatSearchQ = i.value.trim().toLowerCase();
    g.hidden = !!chatSearchQ; chips.hidden = !!chatSearchQ; list.hidden = !chatSearchQ;
    if (chatSearchQ) renderChat(currentChatNumber);
  };
  i.oninput = apply;
  i.onkeydown = (e) => { if (e.key === "Escape") toggleChatSearch(); };
  const btns = s.querySelectorAll(".pill button");
  btns[0].onclick = () => toggleChatSearch();
  btns[1].onclick = () => { i.value = ""; apply(); i.focus(); };
  draw(); apply(); i.focus();
}

// The dock on a page that opens over the list (Voicemail, Contacts)
function tlPanelDock(tab, backBtn) {
  const dock = document.querySelector("#screen-conversations .tl-dock").cloneNode(true);
  for (const b of dock.querySelectorAll(".tl-dock-item")) {
    b.classList.toggle("on", b.dataset.tab === tab);
    b.onclick = () => { if (b.dataset.tab !== tab) { backBtn.click(); goTab(b.dataset.tab); } };
  }
  return dock;
}

// The Contacts tab, like Google Voice's: everyone the flip phone knows by name, A to Z. A web page cannot read a device's contacts.
function webContacts() {
  const byNumber = new Map(), seenNames = new Set(); // one row per person, even when a person has two numbers
  const add = (number, name) => {
    const n = normalizeNumber(number);
    if (!n || isMulti(n) || !name || /^[\d+\s()-]+$/.test(name) || byNumber.has(n) || seenNames.has(name.toLowerCase())) return;
    seenNames.add(name.toLowerCase());
    byNumber.set(n, name);
  };
  for (const m of messages) if (m.contactName) add(m.number, m.contactName);
  for (const c of allCalls) if (c.contactName) add(c.number, c.contactName);
  return [...byNumber.entries()].map(([number, name]) => ({ number, name })).sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
}
function openContactsPanel() {
  const p = openPanel("Contacts");
  p.ov.classList.add("tl-vm", "tl-contacts");
  const backBtn = p.ov.querySelector(".tl-panel-top button");
  backBtn.style.display = "none";
  const cTop = p.ov.querySelector(".tl-panel-top");
  const cSearch = () => p.body.querySelector(".tl-contacts-search");
  const cb = tlSearchButton(() => { const q = cSearch(); q.hidden = !q.hidden; if (q.hidden) { q.value = ""; q.oninput(); } else q.focus(); });
  cb.style.marginLeft = "auto";
  cTop.appendChild(cb);
  cTop.appendChild(tlMenuButton());
  cTop.after(tlPanelDock("contacts", backBtn));
  p.body.innerHTML = `<input class="tl-contacts-search" placeholder="Search contacts" autocomplete="off" hidden><div class="tl-contacts-list"></div>`;
  const q = p.body.querySelector("input"), list = p.body.querySelector(".tl-contacts-list");
  const everyone = webContacts();
  const draw = () => {
    const s = q.value.trim().toLowerCase(), digits = s.replace(/\D/g, "");
    const shown = everyone.filter((c) => !s || c.name.toLowerCase().includes(s) || (digits && c.number.includes(digits)));
    list.innerHTML = shown.length ? "" : `<div class="tl-vm-empty">${s ? "No contacts match" : "No contacts yet. Names show up here as the flip phone sends them."}</div>`;
    for (const c of shown) {
      const row = document.createElement("div");
      row.className = "tl-contact";
      row.innerHTML = `${gmMiniAvatar(c.name, "gm-avatar")}<div class="nm"></div>`;
      row.querySelector(".nm").textContent = c.name;
      row.onclick = () => tlProfileCard(c.number, c.name);
      list.appendChild(row);
    }
  };
  q.oninput = draw;
  draw();
}

function tlSearchButton(toggle) {
  const b = document.createElement("button");
  b.className = "tl-chat-btn tl-search-btn"; b.title = "Search"; b.type = "button";
  b.innerHTML = svgIcon("search");
  b.onclick = toggle;
  return b;
}

// ---------- Call: which app to call with (Settings > Messages > Default calling app) ----------
const CALL_APP_KEY = "flip_relay_web_call_app";
function e164(n) { let d = String(n).replace(/\D/g, ""); if (d.length === 10) d = "1" + d; return "+" + d; }
const CALL_APPS = [
  { id: "phone", label: "Phone (this computer's calling app)", url: (n) => "tel:" + e164(n) },
  { id: "whatsapp", label: "WhatsApp", url: (n) => "whatsapp://send?phone=" + e164(n).slice(1) },
  { id: "skype", label: "Skype", url: (n) => "skype:" + e164(n) + "?call" },
  { id: "teams", label: "Microsoft Teams", url: (n) => "msteams://teams.microsoft.com/l/call/0/0?users=4:" + e164(n) },
  { id: "voice", label: "Google Voice (opens in your browser)", url: (n) => "https://voice.google.com/u/0/calls?a=nc," + encodeURIComponent(e164(n)) },
];
function defaultCallApp() { try { const v = localStorage.getItem(CALL_APP_KEY); return CALL_APPS.some((a) => a.id === v) ? v : "ask"; } catch (e) { return "ask"; } }
function openAppLink(url) {
  if (window.flipDesktop) { window.open(url, "_blank"); return; } // the Windows app hands it to the right program
  const a = document.createElement("a");
  a.href = url; a.rel = "noopener"; if (/^https?:/i.test(url)) a.target = "_blank";
  document.body.appendChild(a); a.click(); a.remove();
}
async function callNumber(number, name) {
  const n = normalizeNumber(number) || number;
  if (!n) return;
  let id = defaultCallApp();
  if (id === "ask") {
    const opts = CALL_APPS.map((a) => ({ label: a.label, value: a.id }));
    opts.push({ label: "Copy the number", value: "copy" });
    id = await showActionSheet("Call " + (name || tlPrettyNumber(n)) + " with", opts);
    if (!id) return;
  }
  if (id === "copy") { try { await navigator.clipboard.writeText(tlPrettyNumber(n)); tlToast("Number copied"); } catch (e) { gmNotice(tlPrettyNumber(n)); } return; }
  const app = CALL_APPS.find((a) => a.id === id);
  if (app) openAppLink(app.url(n));
}

function tlMenuButton() {
  const b = document.createElement("button");
  b.className = "tl-chat-btn tl-menu-btn"; b.title = "Message+ menu";
  b.innerHTML = '<img src="app-icon.png" alt="Message+ menu">';
  b.onclick = () => openTabletMenu();
  return b;
}

// The red Message+ button: status of this page and the flip, and the way to Messages, Features and Settings
function openTabletMenu() {
  const f = lastFlip || {};
  const net = f.network && f.network.wifi ? "Wi-Fi" : f.network && f.network.cellular ? "Mobile data" : "No Wi-Fi or data";
  const okLine = (on) => `<span class="${on ? "ok" : "bad"}">${on ? "Connected to Firebase" : "Not connected"}</span>`;
  const dim = document.createElement("div");
  dim.className = "tl-dim tl-menu-dim";
  dim.innerHTML = `<div class="tl-menu">
    <div class="head"><img src="app-icon.png" alt=""><div class="col"><div class="t">Message+</div><div class="s">Paired with your flip phone</div></div><button class="tl-chat-btn" title="Close">${svgIcon("close")}</button></div>
    <div class="card stat">
      <div class="st"><span class="ic">${svgIcon("tablet")}</span><div class="col"><div>This page</div>${okLine(navigator.onLine)}</div><i class="${navigator.onLine ? "on" : ""}"></i></div>
      <div class="st"><span class="ic">${svgIcon("call")}</span><div class="col"><div>Flip phone</div>${okLine(!!f.connected)}</div><i class="${f.connected ? "on" : ""}"></i></div>
      ${f.connected ? `<div class="info">${escapeHtml(net)}${f.batteryPercent != null ? `<span class="batt"><b style="width:${Math.max(0, Math.min(100, f.batteryPercent))}%"></b><em>${f.batteryPercent}</em></span>` : ""}</div>` : ""}
    </div>
    <div class="card items"></div></div>`;
  const close = () => dim.remove();
  dim.onclick = (e) => { if (e.target === dim) close(); };
  dim.querySelector(".head button").onclick = close;
  const items = dim.querySelector(".items");
  for (const [icon, label, key] of [["archive", "Messages", "messages"], ["star", "Messages features", "features"], ["gear", "Messages settings", null]]) {
    const b = document.createElement("button");
    b.innerHTML = `<span class="ic">${svgIcon(icon)}</span><span></span>`;
    b.lastElementChild.textContent = label;
    b.onclick = () => { close(); openSettingsFromDrawer(key); };
    items.appendChild(b);
  }
  document.body.appendChild(dim);
}

// Selection bar on the list: pin, mute, archive, delete, more
async function tlSelectionAct(choice) {
  const nums = Array.from(selectedConversationNumbers);
  if (choice === "archive") {
    const how = await showActionSheet("Archive", [{ label: "Come back when a new message arrives", value: "back" }, { label: "Stay archived, even for new messages", value: "stay" }]);
    if (!how) return;
    exitConversationSelectionMode();
    for (const n of nums) setArchived(n, true, how === "stay");
    renderConversationList();
    return;
  }
  exitConversationSelectionMode();
  for (const n of nums) await showConversationLongPressMenu(n, choice);
}
async function tlSelectionMore() {
  const nums = Array.from(selectedConversationNumbers), one = nums.length === 1 ? nums[0] : null;
  const o = [];
  if (one) o.push({ label: "Automatic replies", value: "auto" });
  o.push({ label: one && lockedChats().has(one) ? "Unlock chat" : "Lock chat", value: "lock" });
  if (one && isMulti(one)) o.push({ label: "Rename group", value: "rename" });
  if (!one || !isMulti(one)) o.push({ label: "Block", value: "block" });
  if (one) o.push({ label: "Chat theme", value: "theme" });
  o.push({ label: "Select all", value: "all" });
  const c = await showActionSheet(one ? displayName(one) || one : nums.length + " selected", o);
  if (!c) return;
  if (c === "all") { toggleSelectAllConversations(); return; }
  if (c === "auto") { exitConversationSelectionMode(); openAutoRepliesPanel(); return; }
  tlSelectionAct(c);
}
function setupSelectionBar() {
  const bar = el("conv-selection-toolbar");
  if (!bar || bar.dataset.tl) return;
  bar.dataset.tl = "1";
  el("conv-selection-cancel-btn").innerHTML = svgIcon("close");
  const del = el("conv-selection-delete-btn");
  del.innerHTML = svgIcon("trash");
  const mk = (icon, title, fn) => { const b = document.createElement("button"); b.className = "icon-btn"; b.title = title; b.innerHTML = svgIcon(icon); b.onclick = fn; return b; };
  del.before(mk("pin", "Pin", () => tlSelectionAct("pin")), mk("bellOff", "Mute", () => tlSelectionAct("mute")), mk("archive", "Archive", () => tlSelectionAct("archive")));
  del.after(mk("more", "More", tlSelectionMore));
  el("conv-select-all-btn").style.display = "none";
}

// Holding a message: the tablet's blurred screen with the reactions on top and the menu under the bubble
function tlMessageMenu(m) {
  const dim = document.createElement("div");
  dim.className = "tl-mm " + (m.direction === "out" ? "out" : "in");
  dim.innerHTML = `<div class="emojis"></div><div class="col"><div class="copy"></div><div class="menu"></div></div>`;
  const close = () => dim.remove();
  dim.onclick = (e) => { if (e.target === dim || e.target.classList.contains("col")) close(); };
  dim.querySelector(".copy").textContent = m.body || (m.imageUrl ? "Picture" : m.attachmentKind === "audio" ? "Voice message" : m.attachmentUrl ? "Attachment" : "");
  const pending = m.direction === "out" && String(m.id).startsWith("local-");
  const react = (e) => {
    close();
    const snippet = String(m.body || "").slice(0, 60);
    sendQuick(m.number, e + " to \u201c" + snippet + "\u201d", displayName(m.number) || m.number);
  };
  const emojis = dim.querySelector(".emojis");
  if (m.body && !pending) {
    for (const e of ["\u{1F44D}", "\u2764\uFE0F", "\u{1F602}", "\u{1F62E}", "\u{1F622}", "\u{1F621}", "\u{1F44E}"]) {
      const b = document.createElement("button"); b.textContent = e; b.onclick = () => react(e); emojis.appendChild(b);
    }
  } else emojis.style.visibility = "hidden";
  const menu = dim.querySelector(".menu");
  const item = (icon, label, fn) => { const b = document.createElement("button"); b.innerHTML = `<span class="ic">${svgIcon(icon)}</span><span></span>`; b.lastElementChild.textContent = label; b.onclick = () => { close(); fn(); }; menu.appendChild(b); };
  if (m.body) item("forward", "Forward", () => startForward(m.body));
  if (m.body) item("copy", "Copy", async () => { try { await navigator.clipboard.writeText(m.body); } catch (e) { logDebug("Copy failed: " + e); } });
  if (m.imageUrl || m.attachmentUrl) item("download", "Save", () => saveMessageMedia(m));
  item("trash", "Delete", async () => {
    if (pending) { if (await gmConfirm("Delete this message? It hasn't gone through yet.")) deletePending(m.id); return; }
    if (await gmConfirm("It stays in the trash for 30 days and can be restored.", "Delete this message?", "Delete")) softDeleteMessage(m.id);
  });
  item("checklist", "Select more", () => enterSelectionMode(m.id));
  item("info", "Info", () => showMessageInfo(m));
  document.body.appendChild(dim);
}

// A person's sheet, like Google Voice: it comes up from the bottom with the big picture, the name, the number and the buttons. A group lists everyone in it.
function tlPrettyNumber(n) {
  let d = String(n).replace(/\D/g, "");
  if (d.length === 11 && d[0] === "1") d = d.slice(1);
  return d.length === 10 ? `(${d.slice(0, 3)}) ${d.slice(3, 6)}-${d.slice(6)}` : n;
}
function tlProfileCard(number, knownName) {
  const group = isMulti(number);
  const name = knownName || displayName(number) || number;
  const members = group ? number.slice(2).split(",").filter(Boolean) : [];
  const dim = document.createElement("div");
  dim.className = "tl-dim tl-profile";
  dim.innerHTML = `<div class="box"><div class="big">${gmAvatarHtml(number)}</div><div class="sheet"><div class="t"></div><div class="s"></div><div class="acts"></div><div class="people"></div></div></div>`;
  const close = () => dim.remove();
  dim.onclick = (e) => { if (e.target === dim || e.target.classList.contains("box")) close(); };
  dim.querySelector(".t").textContent = name;
  dim.querySelector(".s").textContent = group ? members.length + " people" : name !== number ? tlPrettyNumber(number) : "";
  const acts = dim.querySelector(".acts");
  const add = (icon, title, fn) => { const b = document.createElement("button"); b.title = title; b.innerHTML = `<span class="circle">${svgIcon(icon)}</span><span></span>`; b.lastElementChild.textContent = title; b.onclick = () => { close(); fn(); }; acts.appendChild(b); };
  add("chat", "Message", () => { const panel = document.querySelector(".tl-contacts .tl-panel-top button"); if (panel) panel.click(); if (currentChatNumber !== number || currentScreenName !== "chat") openChat(number); });
  if (!group) {
    add("call", "Call", () => { callNumber(number, name); });
    add("reply", "Quick replies", () => quickReplySheet(number));
  }
  add("info", "Info", () => showConversationLongPressMenu(number, null, true));
  const people = dim.querySelector(".people");
  if (members.length) { const hd = document.createElement("div"); hd.className = "hd"; hd.textContent = "People in this conversation"; people.appendChild(hd); }
  for (const m of members) {
    const who = displayName(m) || m;
    const r = document.createElement("div");
    r.className = "tl-contact";
    r.innerHTML = `${gmAvatarHtml(m)}<div class="col"><div class="nm"></div><div class="no"></div></div>`;
    r.querySelector(".nm").textContent = who;
    r.querySelector(".no").textContent = who !== m ? tlPrettyNumber(m) : "";
    r.onclick = () => { close(); tlProfileCard(m); };
    people.appendChild(r);
  }
  document.body.appendChild(dim);
}

// ---------- a voice message or voicemail player ----------
const PLAY_SVG = () => svgIcon("play"), PAUSE_SVG = () => svgIcon("pause");
let tlVoicePlaying = null;
function clockOf(sec) { const s = Math.max(0, Math.round(sec || 0)); return String(Math.floor(s / 60)).padStart(2, "0") + ":" + String(s % 60).padStart(2, "0"); }
// AMR (the flip phone's voicemail and voice messages) is not something a browser plays by itself: the bundled decoder (vendor/BenzAMRRecorder.min.js,
// MIT) turns it into sound inside the page. Nothing is downloaded or converted by hand.
const amrBlobUrls = new Set();
let amrLibPromise = null;
function loadAmrLib() {
  if (window.BenzAMRRecorder) return Promise.resolve();
  if (!amrLibPromise) amrLibPromise = new Promise((res, rej) => {
    const sc = document.createElement("script");
    sc.src = "vendor/BenzAMRRecorder.min.js";
    sc.onload = () => res();
    sc.onerror = () => { amrLibPromise = null; rej(new Error("the sound decoder did not load")); };
    document.head.appendChild(sc);
  });
  return amrLibPromise;
}
function isAmrUrl(u) { return amrBlobUrls.has(u) || /\.amr(\?|#|$)/i.test(String(u || "")); }
class AmrAudio extends EventTarget {
  constructor(url) { super(); this.url = url; this.rec = null; this.paused = true; this.playbackRate = 1; this._init = null; this._timer = null; }
  get duration() { try { return this.rec ? this.rec.getDuration() : NaN; } catch (e) { return NaN; } }
  get currentTime() { try { return this.rec ? this.rec.getCurrentPosition() : 0; } catch (e) { return 0; } }
  set currentTime(t) { try { if (this.rec) this.rec.setPosition(t); } catch (e) { /* not ready yet */ } }
  _tick(on) { clearInterval(this._timer); if (on) this._timer = setInterval(() => { if (this.ontimeupdate) this.ontimeupdate(); }, 200); }
  _load() {
    if (this._init) return this._init;
    this._init = loadAmrLib().then(async () => {
      const r = new window.BenzAMRRecorder();
      const started = () => { this.paused = false; this._tick(true); if (this.onplay) this.onplay(); };
      r.onPlay(started);
      r.onResume(started);
      r.onPause(() => { this.paused = true; this._tick(false); if (this.onpause) this.onpause(); });
      r.onStop(() => { this.paused = true; this._tick(false); });
      r.onEnded(() => { this.paused = true; this._tick(false); if (this.onended) this.onended(); });
      await r.initWithUrl(this.url);
      this.rec = r;
      if (this.onloadedmetadata) this.onloadedmetadata();
    }).catch((e) => { this._init = null; if (this.onerror) this.onerror(e); throw e; });
    return this._init;
  }
  play() { return this._load().then(() => { if (this.rec.isPaused()) this.rec.resume(); else this.rec.play(); }); }
  pause() { if (this.rec) this.rec.pause(); }
}
function makeAudio(url) { return isAmrUrl(url) ? new AmrAudio(url) : new Audio(url); }

// ---------- recording a voice message (AMR, the same as the tablet's) ----------
let voiceRec = null;
async function startVoiceRecording() {
  if (voiceRec || !currentChatNumber) return;
  try { await loadAmrLib(); } catch (e) { gmNotice("Voice recording could not start: " + e.message); return; }
  if (!window.BenzAMRRecorder.isRecordSupported()) { gmNotice("This browser cannot record sound."); return; }
  const r = new window.BenzAMRRecorder();
  try { await r.initWithRecord(); } catch (e) { gmNotice("Allow the microphone to record a voice message."); return; }
  r.startRecord();
  voiceRec = r;
  const t0 = Date.now();
  const bar = document.createElement("div");
  bar.id = "tl-rec";
  bar.innerHTML = '<span class="dot"></span><span class="t">0:00</span><span class="msg">Recording a voice message</span><button class="x" type="button">Cancel</button><button class="ok" type="button">Attach</button>';
  (document.querySelector("#screen-chat .composer") || el("compose-input")).before(bar);
  const timer = setInterval(() => {
    const sec = Math.floor((Date.now() - t0) / 1000);
    bar.querySelector(".t").textContent = Math.floor(sec / 60) + ":" + String(sec % 60).padStart(2, "0");
    if (sec >= 180) bar.querySelector(".ok").click(); // three minutes is plenty
  }, 300);
  const end = () => { clearInterval(timer); bar.remove(); voiceRec = null; try { r.destroy(); } catch (e) { /* already gone */ } };
  bar.querySelector(".x").onclick = () => { try { r.cancelRecord(); } catch (e) { /* nothing recorded */ } end(); };
  bar.querySelector(".ok").onclick = async () => {
    try {
      await r.finishRecord();
      const blob = r.getBlob();
      if (blob && blob.size > 200) setPendingAttachment(new File([blob], "voice.amr", { type: "audio/amr" }), "audio", "Voice message");
      else gmNotice("Nothing was recorded.");
    } catch (e) { gmNotice("The recording did not work."); }
    end();
  };
}

function tlVoiceHtml() {
  return `<div class="tl-voice"><button class="tl-voice-play" type="button" title="Play">${PLAY_SVG()}</button><div class="tl-voice-track"><div class="tl-voice-fill"></div></div><span class="tl-voice-time">00:00</span></div>`;
}
function wireVoice(root, url, onFirstPlay) {
  const box = root.querySelector(".tl-voice");
  if (!box) return;
  const btn = box.querySelector(".tl-voice-play"), fill = box.querySelector(".tl-voice-fill"), time = box.querySelector(".tl-voice-time"), track = box.querySelector(".tl-voice-track");
  let a = null, started = false;
  const make = () => {
    if (a) return a;
    a = makeAudio(url);
    a.preload = "metadata";
    a.onloadedmetadata = () => { if (isFinite(a.duration)) time.textContent = clockOf(a.duration); };
    a.ontimeupdate = () => { if (a.duration) { fill.style.width = (100 * a.currentTime / a.duration) + "%"; time.textContent = clockOf(a.currentTime); } };
    a.onended = () => { btn.innerHTML = PLAY_SVG(); fill.style.width = "0"; time.textContent = clockOf(a.duration); tlVoicePlaying = null; };
    a.onerror = () => { btn.innerHTML = PLAY_SVG(); tlToast("This recording is in a format this page cannot play. Listen to it on the flip phone."); };
    return a;
  };
  btn.onclick = (e) => {
    e.stopPropagation();
    const au = make();
    if (!au.paused) { au.pause(); btn.innerHTML = PLAY_SVG(); return; }
    if (tlVoicePlaying && tlVoicePlaying !== au) { tlVoicePlaying.pause(); tlVoicePlaying.dispatchEvent(new Event("tlstop")); }
    tlVoicePlaying = au;
    au.addEventListener("tlstop", () => { btn.innerHTML = PLAY_SVG(); });
    au.play().then(() => { btn.innerHTML = PAUSE_SVG(); if (!started) { started = true; if (onFirstPlay) onFirstPlay(); } }).catch(() => { /* onerror says it */ });
  };
  track.onclick = (e) => {
    e.stopPropagation();
    const au = make();
    const f = (e.clientX - track.getBoundingClientRect().left) / track.clientWidth;
    if (au.duration) au.currentTime = Math.max(0, Math.min(1, f)) * au.duration;
  };
}

// ---------- Calls, like the tablet's list: day headings, picture, name, arrow + time; with Message and quick replies on each ----------
function callDay(ts) {
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()) - new Date(d.getFullYear(), d.getMonth(), d.getDate())) / 86400000);
  return days === 0 ? "Today" : days === 1 ? "Yesterday" : d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
}
let selectedCallKey = null;
let callsQuery = "";
// every word typed must be found in the call's name, number, kind (Missed, Received, Dialed) or date (Oct 28, Tuesday, 3:15 PM)
function callMatches(c) {
  if (!callsQuery) return true;
  const d = new Date(c.timestamp || 0);
  const kind = c.type === "missed" ? "missed" : c.type === "outgoing" ? "dialed outgoing called" : c.type === "incoming" ? "received answered incoming" : "declined rejected blocked";
  const hay = [c.contactName || "", c.number || "", String(c.number || "").replace(/\D/g, ""), tlPrettyNumber(c.number || ""), kind,
    d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }), d.toLocaleDateString([], { weekday: "short", month: "short", day: "numeric" }),
    d.toLocaleDateString(), d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }), callDay(c.timestamp || 0)].join(" ").toLowerCase();
  return callsQuery.split(/\s+/).every((t) => !t || hay.includes(t));
}
function callWords(c) { return c.type === "missed" ? "Missed call" : c.type === "rejected" || c.type === "blocked" ? "Declined call" : c.type === "outgoing" ? "Dialed call" : "Received call"; }
function callKey(c) { return (c.timestamp || 0) + "|" + c.number; }
function callIconHtml(c) {
  const missed = c.type === "missed", declined = c.type === "rejected" || c.type === "blocked";
  const color = missed ? "var(--gm-red)" : declined ? "#e37400" : c.type === "outgoing" ? "var(--gm-blue)" : "#1e8e3e";
  const icon = declined ? "block" : missed ? "callMissed" : c.type === "outgoing" ? "callMade" : "callReceived";
  return `<span style="color:${color};display:flex">${svgIcon(icon)}</span>`;
}
function callDetailInto(box, call) {
  const n = normalizeNumber(call.number), name = call.contactName || displayName(n) || call.number;
  const mine = allCalls.filter((c) => normalizeNumber(c.number) === n).sort((a, b) => (b.timestamp || 0) - (a.timestamp || 0));
  const inN = mine.filter((c) => c.type === "incoming").length, outN = mine.filter((c) => c.type === "outgoing").length, talked = mine.reduce((t, c) => t + (c.duration || 0), 0);
  const d = new Date(call.timestamp || 0);
  const longDay = (x) => x.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric" });
  const info = (k, v) => `<div class="k">${escapeHtml(k)}</div><div class="v">${escapeHtml(v)}</div>`;
  const answered = call.type === "incoming" || call.type === "outgoing";
  box.innerHTML = `<div class="who">${call.contactName ? gmMiniAvatar(call.contactName, "gm-avatar") : gmAvatarHtml(n || call.number)}<div class="col"><div class="nm"></div><div class="no"></div></div></div>
    <div class="acts"></div>
    <div class="tl-day">This call</div>
    ${info("Type", callWords(call))}${info("Date", d.toLocaleDateString([], { weekday: "long", month: "long", day: "numeric", year: "numeric" }))}${info("Time", d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit", second: "2-digit" }))}${answered ? info("Length", call.duration ? formatCallDuration(call.duration) : "Not connected") : ""}
    <div class="tl-day">History \u00b7 ${mine.length} ${mine.length === 1 ? "call" : "calls"}</div>
    <div class="sum">${inN} received, ${outN} dialed, ${mine.length - inN - outN} missed or declined${talked ? " \u00b7 " + escapeHtml(formatCallDuration(talked)) + " talked" : ""}</div>
    <div class="hist"></div>`;
  box.querySelector(".nm").textContent = name;
  box.querySelector(".no").textContent = call.number;
  const acts = box.querySelector(".acts");
  const act = (icon, label, fn) => { const b = document.createElement("button"); b.innerHTML = `<span class="circle">${svgIcon(icon)}</span><span></span>`; b.lastElementChild.textContent = label; b.onclick = fn; acts.appendChild(b); };
  if (n) {
    act("call", "Call", () => { callNumber(n, name); });
    act("chat", "Message", () => openChat(n));
    act("reply", "Quick replies", () => quickReplySheet(n));
  }
  const hist = box.querySelector(".hist");
  let day = "", card = null;
  for (const c of mine) {
    const h = c.timestamp ? longDay(new Date(c.timestamp)) : "";
    if (h !== day || !card) {
      day = h;
      const t = document.createElement("div"); t.className = "hd"; t.textContent = h; hist.appendChild(t);
      card = document.createElement("div"); card.className = "hcard"; hist.appendChild(card);
    }
    const r = document.createElement("div");
    r.className = "hrow" + (callKey(c) === callKey(call) ? " on" : "");
    r.innerHTML = `<div class="tm"></div><div class="ty">${callIconHtml(c)}<span></span></div>`;
    r.querySelector(".tm").textContent = new Date(c.timestamp || 0).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    r.querySelector(".ty > span:last-child").textContent = callWords(c) + (c.duration ? ", " + formatCallDuration(c.duration) : "");
    card.appendChild(r);
  }
}
function showCallDetail(call) {
  selectedCallKey = callKey(call);
  for (const r of document.querySelectorAll("#calls-list .tl-call")) r.classList.toggle("on", r.dataset.key === selectedCallKey);
  if (document.body.classList.contains("gm-tablet")) { callDetailInto(el("tl-call-detail"), call); return; }
  const p = openPanel("Call info");
  const box = document.createElement("div");
  box.className = "tl-call-detail";
  p.body.appendChild(box);
  callDetailInto(box, call);
}
function renderCallsList() {
  const list = el("calls-list");
  let wrap = document.getElementById("tl-calls-wrap");
  if (!wrap) {
    wrap = document.createElement("div"); wrap.id = "tl-calls-wrap";
    const left = document.createElement("div"); left.id = "tl-calls-left";
    const detail = document.createElement("div"); detail.id = "tl-call-detail"; detail.className = "tl-call-detail";
    list.parentNode.insertBefore(wrap, list);
    const tabs = document.createElement("div"); tabs.id = "calls-tabs";
    left.append(tabs, list, el("calls-empty-state"));
    wrap.append(left, detail);
  }
  list.innerHTML = "";
  let box = document.getElementById("calls-search");
  if (!box) {
    box = document.createElement("input");
    box.id = "calls-search"; box.placeholder = "Search calls: a name, number, date or Missed"; box.autocomplete = "off"; box.hidden = !callsQuery;
    box.oninput = () => { callsQuery = box.value.trim().toLowerCase(); renderCallsList(); };
    document.getElementById("calls-tabs").before(box);
  }
  const bar = document.getElementById("calls-tabs");
  bar.innerHTML = "";
  [["All", 0], ["Missed", 3], ["Received", 4], ["Dialed", 5], ["Contacts", 1], ["Not contacts", 2]].forEach(([label, i]) => {
    const b = document.createElement("button");
    b.className = "tl-chip" + (i === callsTab ? " on" : "");
    b.textContent = label;
    b.addEventListener("click", () => { callsTab = i; renderCallsList(); });
    bar.appendChild(b);
  });
  const isDeclined = (c) => c.type === "rejected" || c.type === "blocked";
  const shown = allCalls.filter(callMatches).filter((c) => callsTab === 0 || (callsTab === 1 && c.contactName) || (callsTab === 2 && !c.contactName) || (callsTab === 3 && (c.type === "missed" || isDeclined(c))) || (callsTab === 4 && c.type === "incoming") || (callsTab === 5 && c.type === "outgoing"));
  el("calls-empty-state").classList.toggle("hidden", shown.length > 0);
  let last = "";
  for (const call of shown) {
    const h = call.timestamp ? callDay(call.timestamp) : "";
    if (h && h !== last) { last = h; const d = document.createElement("div"); d.className = "tl-day"; d.textContent = h; list.appendChild(d); }
    const n = normalizeNumber(call.number);
    const when = call.timestamp ? new Date(call.timestamp).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "";
    const row = document.createElement("div");
    row.className = "tl-call";
    row.dataset.key = callKey(call);
    const detail = call.type === "missed" ? "Missed \u00b7 " + when : isDeclined(call) ? "Declined \u00b7 " + when : when + (call.duration ? " \u00b7 " + formatCallDuration(call.duration) : "");
    row.innerHTML = `${call.contactName ? gmMiniAvatar(call.contactName, "gm-avatar") : gmAvatarHtml(n || call.number)}<div class="tl-col"><div class="nm"></div><div class="dt">${callIconHtml(call)}<span></span></div></div>`;
    row.querySelector(".nm").textContent = call.contactName || call.number;
    row.querySelector(".dt > span:last-child").textContent = detail;
    if (n) {
      for (const [icon, t, fn] of [["chat", "Message", () => openChat(n)], ["call", "Call", () => { callNumber(n, call.contactName || call.number); }]]) {
        const b = document.createElement("button");
        b.className = "tl-call-btn"; b.title = t; b.innerHTML = svgIcon(icon);
        b.addEventListener("click", (e) => { e.stopPropagation(); fn(); });
        row.appendChild(b);
      }
    }
    row.addEventListener("click", () => showCallDetail(call));
    list.appendChild(row);
  }
  if (document.body.classList.contains("gm-tablet") && shown.length) {
    showCallDetail(shown.find((c) => callKey(c) === selectedCallKey) || shown[0]);
  }
}

configGate().then(lockGate).then(() => { init(); applyTheme(); addLockSettingsButton(); addThemeSettingsButton(); });

