// AIM — UI controller. Wires buddy list, chat panes, and polling.

import { Client } from "./client.js";
import { Sounds } from "./sounds.js";
import { Realtime } from "./realtime.js";
import { Presence } from "./presence.js";

const USER_COLORS = ["--user-1","--user-2","--user-3","--user-4","--user-5","--user-6","--user-7","--user-8"];
const STATUS_LABELS = { available: "Available", away: "Away", invisible: "Invisible" };
const STATUS_COLORS = { available: "#2ecc40", away: "#f1c40f", invisible: "#888" };

const state = {
  me: null,
  rooms: [],
  roomMeta: {},
  motd: null,
  serverName: "AIM Server",
  activeRoom: null,
  openRooms: new Set(),
  roomState: {},
  online: [],
};

function $(sel, root = document) { return root.querySelector(sel); }
function $$(sel, root = document) { return [...root.querySelectorAll(sel)]; }

function userColor(name) {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return `var(${USER_COLORS[h % USER_COLORS.length]})`;
}

function hhmm(iso) {
  try {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  } catch { return ""; }
}

function escapeHtml(s) {
  return String(s)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightMentions(text) {
  return escapeHtml(text).replace(
    /(^|[\s(])@([A-Za-z0-9_][A-Za-z0-9_-]{0,38})/g,
    (_, prefix, name) => `${prefix}<span class="mention">@${name}</span>`,
  );
}

function messageKey(m) {
  return `${m.sha}:${m.path}`;
}

function getFocusableElements(panel) {
  const sel =
    'button:not([disabled]), [href], input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
  return [...panel.querySelectorAll(sel)].filter((el) => {
    if (el.getAttribute("aria-hidden") === "true" || el.hasAttribute("disabled")) return false;
    return el.offsetParent !== null || el === document.activeElement;
  });
}

export async function bootChat() {
  if (!Client.getToken()) {
    location.href = "/";
    return;
  }
  try {
    const me = await Client.me();
    state.me = me;
    state.rooms = me.rooms;
    state.roomMeta = me.room_meta || {};
    state.motd = me.motd;
    state.serverName = me.server_name;
  } catch (e) {
    console.error("auth failed", e);
    Client.clearToken();
    location.href = "/";
    return;
  }

  renderBuddyList();
  renderEmptyChat();
  Sounds.signon();
  await Presence.start();
  renderStatusPill();
  await startRealtime();
  setupComposeHandlers();
  setupToolbar();
  initBuddySectionToggles();
}

async function startRealtime() {
  for (const room of state.rooms) {
    Realtime.subscribe(room, () => refreshRoom(room));
  }
  Realtime.subscribeGlobal((pulse) => {
    state.online = pulse.online || [];
    renderOnlineList();
  });
  await Realtime.init(state.me.realtime);
}

function renderBuddyList() {
  $("#serverName").textContent = state.serverName;
  $("#meName").textContent = state.me.name;
  $("#meName").setAttribute("title", state.me.name);
  $("#meRole").textContent = state.me.role;
  if (state.motd) {
    $("#motd").textContent = state.motd;
    $("#motd").classList.remove("hidden");
  }

  const roomList = $("#roomList");
  roomList.innerHTML = "";
  for (const room of state.rooms) {
    const li = document.createElement("li");
    const dot = document.createElement("span");
    dot.className = "dot";
    const label = document.createElement("span");
    label.className = "buddy-list-text";
    label.textContent = "#" + room;
    li.appendChild(dot);
    li.appendChild(label);
    li.dataset.room = room;
    li.title = "#" + room;
    li.addEventListener("dblclick", () => openRoom(room));
    li.addEventListener("click", () => openRoom(room));
    roomList.appendChild(li);
  }

  // "+ New Room" button visible only if the user has the capability.
  const roomsToolbar = $("#roomsToolbar");
  if (roomsToolbar && state.me.can?.create_rooms && !$("#newRoomBtn")) {
    const btn = document.createElement("button");
    btn.id = "newRoomBtn";
    btn.className = "section-action";
    btn.type = "button";
    btn.title = "Create a new room";
    btn.setAttribute("aria-label", "Create a new room");
    btn.textContent = "+";
    btn.addEventListener("click", (e) => {
      e.stopPropagation();
      openNewRoomDialog();
    });
    roomsToolbar.appendChild(btn);
  }

  renderOnlineList();
}

function canEditTopic(room) {
  const me = state.me;
  if (!me || !me.can) return false;
  if (me.can.set_topics === "any") return true;
  if (me.can.set_topics === "own_rooms_only") {
    const meta = state.roomMeta?.[room];
    return Boolean(meta && meta.created_by === me.name);
  }
  return false;
}

function renderOnlineList() {
  const list = $("#onlineList");
  if (!list) return;
  const myName = state.me?.name;
  const others = state.online
    .filter((u) => u.name !== myName)
    .sort((a, b) => a.name.localeCompare(b.name));
  const total = others.length;
  const header = $("#onlineHeader");
  if (header) header.textContent = `Online Buddies (${total})`;

  list.innerHTML = "";
  if (total === 0) {
    const li = document.createElement("li");
    li.innerHTML = `<span class="help" style="font-style:italic">no one else is online</span>`;
    list.appendChild(li);
    return;
  }
  for (const u of others) {
    const li = document.createElement("li");
    const color = STATUS_COLORS[u.status] || "#888";
    const dot = document.createElement("span");
    dot.className = "dot";
    dot.style.background = color;
    const label = document.createElement("span");
    label.className = "buddy-list-text";
    label.textContent = u.name;
    li.appendChild(dot);
    li.appendChild(label);
    li.title = `${u.name} (${u.status})`;
    list.appendChild(li);
  }
}

function renderStatusPill() {
  const pill = $("#statusPill");
  if (!pill) return;
  const label = pill.querySelector(".label");
  const dot = pill.querySelector(".dot");
  const status = Presence.status;
  const text = STATUS_LABELS[status] || "Available";
  if (label) label.textContent = text;
  if (dot) dot.style.background = STATUS_COLORS[status] || STATUS_COLORS.available;
  pill.setAttribute("aria-label", `Your status is ${text}. Activate to change.`);
}

function initBuddySectionToggles() {
  document.querySelectorAll(".buddy-section-header").forEach((btn) => {
    const section = btn.closest(".buddy-section");
    if (!section) return;
    const sync = () => {
      btn.setAttribute("aria-expanded", section.classList.contains("collapsed") ? "false" : "true");
    };
    btn.addEventListener("click", (e) => {
      if (e.target.closest(".section-action")) return;
      section.classList.toggle("collapsed");
      sync();
    });
    sync();
  });
}

function renderEmptyChat() {
  $("#chatPane .window-body").innerHTML = `
    <div class="chat-empty">
      <div style="text-align:center">
        <div class="aim-brand" style="justify-content:center">
          <img src="img/logo.png" alt="AIM"/>
        </div>
        <p>Select a room from the Buddy List to open it. Double-click also works.</p>
      </div>
    </div>`;
  $("#chatPane .title-bar-text").textContent = "AIM";
}

function openRoom(room) {
  state.activeRoom = room;
  state.openRooms.add(room);
  if (!state.roomState[room]) {
    state.roomState[room] = {
      messages: [],
      lastSinceIso: null,
      pins: [],
      pinIndex: new Set(),
      topic: null,
    };
  }
  $$("#roomList li").forEach((li) =>
    li.classList.toggle("active", li.dataset.room === room),
  );
  renderChatWindow();
  refreshRoom(room, { initial: true });
  refreshPins(room);
}

function renderChatWindow() {
  const room = state.activeRoom;
  if (!room) return renderEmptyChat();
  const editTopicBtn = canEditTopic(room)
    ? `<button type="button" id="editTopicBtn" title="Edit room topic" aria-label="Edit room topic">📋 Topic</button><span class="sep"></span>`
    : "";
  const body = $("#chatPane .window-body");
  body.innerHTML = `
    <div class="topic-bar hidden" id="topicBar"></div>
    <button type="button" class="pin-bar hidden" id="pinBar" disabled aria-label="Pinned messages">📌</button>
    <div class="transcript" id="transcript" role="region" aria-label="Room messages"></div>
    <div class="compose-toolbar">
      <button type="button" title="Bold (display only — not sent)" aria-label="Bold, cosmetic only"><b>B</b></button>
      <button type="button" title="Italic (display only — not sent)" aria-label="Italic, cosmetic only"><i>I</i></button>
      <button type="button" title="Underline (display only — not sent)" aria-label="Underline, cosmetic only"><u>U</u></button>
      <span class="sep"></span>
      <button type="button" title="Color (display only — not sent)" style="color:#c00" aria-label="Text color, cosmetic only">A</button>
      <span class="sep"></span>
      <button type="button" id="searchBtn" title="Search this room" aria-label="Search messages in this room">🔍</button>
      <span class="sep"></span>
      ${editTopicBtn}
      <span class="spacer" style="flex:1"></span>
    </div>
    <div class="compose">
      <textarea id="composer" placeholder="Type your message..." aria-label="Message text"></textarea>
      <button type="button" id="sendBtn">Send</button>
    </div>`;
  $("#chatPane .title-bar-text").textContent = `${room} — Chat`;

  $("#transcript").addEventListener("click", onTranscriptStarClick);
  $("#pinBar").addEventListener("click", openPinsOverview);

  $("#sendBtn").addEventListener("click", sendMessage);
  $("#composer").addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  });
  $("#searchBtn").addEventListener("click", openSearchDialog);
  const etb = $("#editTopicBtn");
  if (etb) etb.addEventListener("click", openEditTopicDialog);
  renderTopicBar();
  renderTranscript({ full: true });
}

function renderTopicBar() {
  const room = state.activeRoom;
  if (!room) return;
  const bar = $("#topicBar");
  if (!bar) return;
  const topic = state.roomState[room]?.topic;
  if (!topic) {
    bar.classList.add("hidden");
    bar.innerHTML = "";
    return;
  }
  bar.classList.remove("hidden");
  bar.innerHTML = `
    <div class="topic-label">📋 Room topic</div>
    <div class="topic-body">${escapeHtml(topic).replace(/\n/g, "<br>")}</div>`;
}

function buildMessageElement(m, st) {
  const div = document.createElement("div");
  div.className = "msg";
  div.dataset.msgKey = messageKey(m);
  div.dataset.sha = m.sha;
  if (m.author === state.me.name) div.classList.add("own");
  const pinned = st.pinIndex.has(m.sha) ? "pinned" : "";
  const replyCount = st.replyCounts?.get(m.sha) ?? 0;
  div.innerHTML = `
      <span class="author" style="color:${userColor(m.author)}">${escapeHtml(m.author)}</span>
      <span class="body">${highlightMentions(m.text)}</span>
      <span class="ts">${hhmm(m.sent_at)}</span>
      ${m.edited_at ? '<span class="edited">(edited)</span>' : ""}
      <button type="button" class="reply-btn" data-sha="${String(m.sha)}" title="Reply in thread" aria-label="Reply in thread">↩</button>
      <button type="button" class="star ${pinned}" data-sha="${String(m.sha)}" title="Pin or unpin this message" aria-label="Pin or unpin message" aria-pressed="${st.pinIndex.has(m.sha) ? "true" : "false"}">★</button>
      <button type="button" class="thread-badge${replyCount === 0 ? " hidden" : ""}" data-sha="${String(m.sha)}" title="Open thread" aria-label="Open thread">💬 <span class="thread-count">${replyCount}</span></button>`;
  return div;
}

function computeReplyCounts(messages) {
  const m = new Map();
  for (const msg of messages) {
    if (msg.reply_to) {
      m.set(msg.reply_to, (m.get(msg.reply_to) ?? 0) + 1);
    }
  }
  return m;
}

function syncThreadBadgesInTranscript() {
  const t = $("#transcript");
  if (!t) return;
  const room = state.activeRoom;
  const st = state.roomState[room];
  if (!st) return;
  const counts = st.replyCounts ?? new Map();
  t.querySelectorAll(".msg").forEach((row) => {
    const sha = row.dataset.sha;
    if (!sha) return;
    const badge = row.querySelector(".thread-badge");
    if (!badge) return;
    const n = counts.get(sha) ?? 0;
    badge.classList.toggle("hidden", n === 0);
    const countEl = badge.querySelector(".thread-count");
    if (countEl) countEl.textContent = String(n);
  });
}

function syncPinStarsInTranscript() {
  const t = $("#transcript");
  if (!t) return;
  const room = state.activeRoom;
  const st = state.roomState[room];
  if (!st) return;
  t.querySelectorAll(".star").forEach((star) => {
    const sha = star.dataset.sha;
    if (!sha) return;
    const on = st.pinIndex.has(sha);
    star.classList.toggle("pinned", on);
    star.setAttribute("aria-pressed", on ? "true" : "false");
  });
}

function renderTranscript(opts = {}) {
  const full = opts.full === true;
  const room = state.activeRoom;
  if (!room) return;
  const st = state.roomState[room];
  const t = $("#transcript");
  if (!t) return;

  // Recompute reply-counts from all messages (incl. replies), then render
  // ONLY top-level messages (those without reply_to) in the main transcript.
  // Replies appear inside the thread modal.
  st.replyCounts = computeReplyCounts(st.messages);
  const topLevel = st.messages.filter((m) => !m.reply_to);

  if (full) {
    t.innerHTML = "";
    const frag = document.createDocumentFragment();
    for (const m of topLevel) frag.appendChild(buildMessageElement(m, st));
    t.appendChild(frag);
  } else {
    const keysInDom = new Set([...t.querySelectorAll(".msg")].map((r) => r.dataset.msgKey));
    for (const m of topLevel) {
      const k = messageKey(m);
      if (!keysInDom.has(k)) {
        t.appendChild(buildMessageElement(m, st));
        keysInDom.add(k);
        continue;
      }
      const row = [...t.children].find((r) => r.dataset.msgKey === k);
      if (!row) continue;
      const body = row.querySelector(".body");
      const nextHtml = highlightMentions(m.text);
      if (body && body.innerHTML !== nextHtml) body.innerHTML = nextHtml;
      if (m.edited_at && !row.querySelector(".edited")) {
        const ts = row.querySelector(".ts");
        if (ts) {
          const ed = document.createElement("span");
          ed.className = "edited";
          ed.textContent = "(edited)";
          ts.after(ed);
        }
      }
    }
    syncPinStarsInTranscript();
    syncThreadBadgesInTranscript();
  }
  t.scrollTop = t.scrollHeight;
}

function onTranscriptStarClick(e) {
  const t = e.currentTarget;
  const star = e.target.closest(".star");
  if (star && t.contains(star)) {
    e.preventDefault();
    togglePinForSha(star.dataset.sha);
    return;
  }
  const reply = e.target.closest(".reply-btn");
  if (reply && t.contains(reply)) {
    e.preventDefault();
    openThreadDialog(reply.dataset.sha);
    return;
  }
  const badge = e.target.closest(".thread-badge");
  if (badge && t.contains(badge)) {
    e.preventDefault();
    openThreadDialog(badge.dataset.sha);
    return;
  }
}

async function togglePinForSha(sha) {
  if (!sha) return;
  const room = state.activeRoom;
  const st = state.roomState[room];
  try {
    if (st.pinIndex.has(sha)) {
      await Client.unpin(room, sha);
    } else {
      await Client.pin(room, sha);
    }
    await refreshPins(room);
  } catch (err) {
    alert("Pin operation failed: " + err.message);
  }
}

function openPinsOverview() {
  const room = state.activeRoom;
  const st = state.roomState[room];
  if (!st?.pins?.length) return;
  const items = st.pins
    .map((p) => {
      const who = p.author ? escapeHtml(p.author) : "—";
      const when = p.sent_at ? escapeHtml(hhmm(p.sent_at)) : "";
      const snippet = escapeHtml((p.text || "").slice(0, 200));
      const tail = (p.text || "").length > 200 ? "…" : "";
      return `<li class="help" style="margin-bottom:8px"><strong>${who}</strong> <span class="ts">${when}</span><div>${snippet}${tail}</div></li>`;
    })
    .join("");
  const { dismiss, overlay } = showModal(`
    <div class="title-bar">
      <div class="title-bar-text">Pinned in ${escapeHtml(room)}</div>
      <div class="title-bar-controls">
        <button type="button" class="modal-close" aria-label="Close"></button>
      </div>
    </div>
    <div class="window-body">
      <p class="help">${st.pins.length} pinned message${st.pins.length === 1 ? "" : "s"}.</p>
      <ol style="margin:8px 0;padding-left:20px;max-height:50vh;overflow-y:auto">${items}</ol>
      <div class="actions">
        <button type="button" class="modal-close">Close</button>
      </div>
    </div>`);
  overlay.querySelectorAll(".modal-close").forEach((b) => b.addEventListener("click", dismiss));
}

async function refreshRoom(room, { initial = false } = {}) {
  const st = state.roomState[room];
  try {
    const opts = {};
    if (st.lastSinceIso) opts.since = st.lastSinceIso;
    const res = await Client.readRoom(room, opts);

    if (typeof res.topic !== "undefined") {
      if (st.topic !== res.topic) {
        st.topic = res.topic;
        if (room === state.activeRoom) renderTopicBar();
      }
    }

    const newMessages = res.messages || [];
    if (newMessages.length > 0) {
      const existingShas = new Set(st.messages.map((m) => m.sha + ":" + m.path));
      for (const m of newMessages) {
        const k = m.sha + ":" + m.path;
        if (!existingShas.has(k)) st.messages.push(m);
      }
      st.messages.sort((a, b) => a.sent_at.localeCompare(b.sent_at));
      const last = st.messages[st.messages.length - 1];
      if (last) {
        const lastDate = new Date(last.sent_at);
        lastDate.setSeconds(lastDate.getSeconds() + 1);
        st.lastSinceIso = lastDate.toISOString();
      }
      if (!initial && room === state.activeRoom) Sounds.message();
      if (room === state.activeRoom) renderTranscript();
    }
  } catch (e) {
    console.error(`refreshRoom(${room}) failed:`, e);
  }
}

async function refreshPins(room) {
  try {
    const res = await Client.listPins(room);
    const st = state.roomState[room];
    st.pins = res.pins || [];
    st.pinIndex = new Set(st.pins.map((p) => p.sha));
    if (room === state.activeRoom) {
      const bar = $("#pinBar");
      if (bar) {
        if (st.pins.length === 0) {
          bar.classList.add("hidden");
          bar.disabled = true;
          bar.textContent = "📌";
          bar.removeAttribute("aria-label");
        } else {
          bar.classList.remove("hidden");
          bar.disabled = false;
          bar.textContent = `📌 ${st.pins.length} pinned — open list`;
          bar.setAttribute(
            "aria-label",
            `${st.pins.length} pinned message${st.pins.length === 1 ? "" : "s"} in this room. Open to read.`,
          );
        }
      }
      syncPinStarsInTranscript();
    }
  } catch (e) {
    console.error("refreshPins failed:", e);
  }
}

async function sendMessage() {
  const composer = $("#composer");
  const text = composer.value.trim();
  if (!text) return;
  const room = state.activeRoom;
  const sendBtn = $("#sendBtn");
  sendBtn.disabled = true;
  composer.disabled = true;
  try {
    Sounds.send();
    await Client.send(room, text, crypto.randomUUID());
    composer.value = "";
    await refreshRoom(room);
  } catch (e) {
    Sounds.error();
    alert("Failed to send: " + e.message);
  } finally {
    sendBtn.disabled = false;
    composer.disabled = false;
    composer.focus();
  }
}

function setupComposeHandlers() {
  // Placeholder for future toolbar handlers
}

function syncMuteButtonUi() {
  const btn = $("#muteBtn");
  if (!btn) return;
  const muted = Sounds.isMuted();
  btn.textContent = muted ? "🔇" : "🔊";
  btn.setAttribute("aria-label", muted ? "Sound muted. Activate to turn sound on." : "Sound on. Activate to mute.");
}

function setupToolbar() {
  $("#signoffBtn").addEventListener("click", async () => {
    Sounds.signoff();
    Realtime.stop();
    await Presence.stop();
    Client.clearToken();
    setTimeout(() => (location.href = "/"), 400);
  });
  $("#muteBtn").addEventListener("click", () => {
    Sounds.toggle();
    syncMuteButtonUi();
  });
  syncMuteButtonUi();

  $("#statusPill").addEventListener("click", () => {
    const cycle = ["available", "away", "invisible"];
    const next = cycle[(cycle.indexOf(Presence.status) + 1) % cycle.length];
    Presence.setStatus(next);
    renderStatusPill();
  });

  const adminBtn = $("#adminBtn");
  if (adminBtn && state.me.role === "admin") {
    adminBtn.classList.remove("hidden");
    adminBtn.addEventListener("click", openAdminDialog);
  }
}

function openSearchDialog() {
  const q = prompt("Search messages in this room:");
  if (!q) return;
  Client.search(q, state.activeRoom).then((res) => {
    const list = (res.results || [])
      .map((r) => `[${hhmm(r.sent_at)}] ${r.author}: ${r.text}`)
      .join("\n");
    alert(list || "No matches found.");
  }).catch((e) => alert("Search failed: " + e.message));
}

// ---------- Modal helper ----------

function showModal(innerHtml) {
  const overlay = document.createElement("div");
  overlay.className = "modal-overlay";
  overlay.innerHTML = `<div class="window aim-modal" role="dialog" aria-modal="true">${innerHtml}</div>`;
  document.body.appendChild(overlay);
  const panel = overlay.querySelector(".aim-modal");
  const prevActive = document.activeElement;

  function onKeyDown(e) {
    if (e.key === "Escape") {
      e.preventDefault();
      dismiss();
      return;
    }
    if (e.key !== "Tab") return;
    const nodes = getFocusableElements(panel);
    if (nodes.length === 0) return;
    const first = nodes[0];
    const last = nodes[nodes.length - 1];
    if (e.shiftKey) {
      if (document.activeElement === first) {
        e.preventDefault();
        last.focus();
      }
    } else if (document.activeElement === last) {
      e.preventDefault();
      first.focus();
    }
  }

  function onOverlayClick(e) {
    if (e.target === overlay) dismiss();
  }

  function dismiss() {
    overlay.removeEventListener("keydown", onKeyDown);
    overlay.removeEventListener("click", onOverlayClick);
    overlay.remove();
    if (prevActive && typeof prevActive.focus === "function") prevActive.focus();
  }

  overlay.addEventListener("keydown", onKeyDown);
  overlay.addEventListener("click", onOverlayClick);

  requestAnimationFrame(() => {
    const nodes = getFocusableElements(panel);
    const focusEl = panel.querySelector("[autofocus]") || nodes[0] || panel;
    if (focusEl && typeof focusEl.focus === "function") focusEl.focus();
  });

  return { overlay, dismiss, panel };
}

function openNewRoomDialog() {
  const { overlay, dismiss } = showModal(`
    <div class="title-bar">
      <div class="title-bar-text">Create new room</div>
      <div class="title-bar-controls">
        <button type="button" class="modal-close" aria-label="Close"></button>
      </div>
    </div>
    <div class="window-body">
      <p class="help">Room names: lowercase, alphanumeric, dashes or underscores. Max 32 chars.</p>
      <div class="field-row" style="margin-top:8px">
        <label for="newRoomName">Room name:</label>
        <input id="newRoomName" type="text" placeholder="support" autofocus />
      </div>
      <div class="field-row" style="display:block; margin-top:8px">
        <label for="newRoomTopic" style="display:block; margin-bottom:4px">Topic (optional):</label>
        <textarea id="newRoomTopic" rows="5" style="width:100%; box-sizing:border-box;"
          placeholder="Markdown. Visible to all readers; agents will treat it as instructions for this room."></textarea>
      </div>
      <div id="newRoomError" class="help hidden" style="color:#c00; margin-top:6px"></div>
      <div class="actions">
        <button class="modal-close" type="button">Cancel</button>
        <button id="newRoomSubmit" type="button">Create</button>
      </div>
    </div>`);

  overlay.querySelectorAll(".modal-close").forEach((b) => b.addEventListener("click", dismiss));
  const nameInput = overlay.querySelector("#newRoomName");
  const topicInput = overlay.querySelector("#newRoomTopic");
  const errBox = overlay.querySelector("#newRoomError");
  const submit = overlay.querySelector("#newRoomSubmit");

  submit.addEventListener("click", async () => {
    const name = nameInput.value.trim().toLowerCase();
    const topic = topicInput.value.trim();
    if (!name) {
      errBox.textContent = "Room name is required.";
      errBox.classList.remove("hidden");
      return;
    }
    submit.disabled = true;
    try {
      const res = await Client.createRoom(name, topic || undefined);
      state.rooms = res.rooms;
      state.roomMeta = res.room_meta || state.roomMeta;
      renderBuddyList();
      dismiss();
      openRoom(res.room || name);
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
      submit.disabled = false;
    }
  });

  nameInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter") submit.click();
  });
}

function openEditTopicDialog() {
  const room = state.activeRoom;
  if (!room) return;
  const current = state.roomState[room]?.topic || "";
  const { overlay, dismiss } = showModal(`
    <div class="title-bar">
      <div class="title-bar-text">Edit topic — ${escapeHtml(room)}</div>
      <div class="title-bar-controls">
        <button type="button" class="modal-close" aria-label="Close"></button>
      </div>
    </div>
    <div class="window-body">
      <p class="help">The topic appears above messages and is included in every agent read. Markdown allowed.</p>
      <div class="field-row" style="display:block">
        <label for="topicInput" class="sr-only">Room topic (markdown)</label>
        <textarea id="topicInput" rows="10" style="width:100%; box-sizing:border-box; font-family:Consolas,monospace; font-size:12px;">${escapeHtml(current)}</textarea>
      </div>
      <div id="topicError" class="help hidden" style="color:#c00; margin-top:6px"></div>
      <div class="actions">
        <button class="modal-close" type="button">Cancel</button>
        <button id="topicSubmit" type="button">Save topic</button>
      </div>
    </div>`);

  overlay.querySelectorAll(".modal-close").forEach((b) => b.addEventListener("click", dismiss));
  const input = overlay.querySelector("#topicInput");
  const errBox = overlay.querySelector("#topicError");
  const submit = overlay.querySelector("#topicSubmit");

  submit.addEventListener("click", async () => {
    submit.disabled = true;
    try {
      await Client.setTopic(room, input.value);
      const st = state.roomState[room];
      if (st) st.topic = input.value;
      renderTopicBar();
      dismiss();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
      submit.disabled = false;
    }
  });
}

// ---------- Threads ----------

function openThreadDialog(parentSha) {
  const room = state.activeRoom;
  if (!room || !parentSha) return;
  const st = state.roomState[room];
  const parent = st?.messages.find((m) => m.sha === parentSha);
  const titlePreview = parent ? parent.text.replace(/\s+/g, " ").slice(0, 60) : parentSha.slice(0, 12);

  const { overlay, dismiss } = showModal(`
    <div class="title-bar">
      <div class="title-bar-text">Thread — ${escapeHtml(titlePreview)}</div>
      <div class="title-bar-controls">
        <button type="button" class="modal-close" aria-label="Close"></button>
      </div>
    </div>
    <div class="window-body thread-body">
      <div class="thread-parent" id="threadParent">
        ${parent ? renderThreadMessageHtml(parent, true) : "<p class='help'>Parent message not loaded — fetching…</p>"}
      </div>
      <div class="thread-replies" id="threadReplies">
        <p class="help">Loading replies…</p>
      </div>
      <div class="compose">
        <textarea id="threadComposer" placeholder="Reply in thread…" rows="2"></textarea>
        <button type="button" id="threadSendBtn">Send</button>
      </div>
      <div id="threadError" class="help hidden" style="color:#c00; margin-top:4px"></div>
    </div>`);

  overlay.querySelectorAll(".modal-close").forEach((b) => b.addEventListener("click", dismiss));
  const repliesEl = overlay.querySelector("#threadReplies");
  const parentEl = overlay.querySelector("#threadParent");
  const composer = overlay.querySelector("#threadComposer");
  const sendBtn = overlay.querySelector("#threadSendBtn");
  const errBox = overlay.querySelector("#threadError");

  if (state.me.role === "read-only") {
    composer.disabled = true;
    sendBtn.disabled = true;
    composer.placeholder = "Read-only token — can't reply.";
  }

  let lastFetched = null;
  const refresh = async () => {
    try {
      const res = await Client.getThread(room, parentSha);
      lastFetched = res;
      if (res.parent && parentEl) parentEl.innerHTML = renderThreadMessageHtml(res.parent, true);
      if (!res.replies.length) {
        repliesEl.innerHTML = `<p class="help" style="font-style:italic">No replies yet. Be the first.</p>`;
      } else {
        repliesEl.innerHTML = res.replies.map((m) => renderThreadMessageHtml(m, false)).join("");
      }
    } catch (e) {
      repliesEl.innerHTML = `<p class="help" style="color:#c00">Couldn't load thread: ${escapeHtml(e.message)}</p>`;
    }
  };

  sendBtn.addEventListener("click", async () => {
    const text = composer.value.trim();
    if (!text) return;
    sendBtn.disabled = true;
    composer.disabled = true;
    try {
      Sounds.send();
      await Client.send(room, text, crypto.randomUUID(), parentSha);
      composer.value = "";
      await refresh();
      // also refresh the main room so the badge count updates
      refreshRoom(room).catch(() => {});
    } catch (e) {
      Sounds.error();
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    } finally {
      sendBtn.disabled = false;
      composer.disabled = false;
      composer.focus();
    }
  });

  composer.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  refresh();
}

function renderThreadMessageHtml(m, isParent) {
  const color = userColor(m.author);
  const cls = isParent ? "thread-msg thread-msg-parent" : "thread-msg";
  return `
    <div class="${cls}">
      <span class="author" style="color:${color}">${escapeHtml(m.author)}</span>
      <span class="body">${highlightMentions(m.text)}</span>
      <span class="ts">${hhmm(m.sent_at)}</span>
      ${m.edited_at ? '<span class="edited">(edited)</span>' : ""}
    </div>`;
}

// ---------- Admin: user management ----------

const ROLE_DESCRIPTIONS = {
  admin: "Full powers. Can mint tokens, create rooms, edit any topic.",
  moderator: "Can create rooms and edit topics for rooms they create.",
  member: "Standard read/write user. Can pin messages.",
  "read-only": "Can read messages but not send, pin, or edit.",
};

function fmtDate(iso) {
  try { return new Date(iso).toLocaleString(); } catch { return iso; }
}

function openAdminDialog() {
  const { overlay, dismiss } = showModal(`
    <div class="title-bar">
      <div class="title-bar-text">⚙️ User management</div>
      <div class="title-bar-controls">
        <button type="button" class="modal-close" aria-label="Close"></button>
      </div>
    </div>
    <div class="window-body admin-panel">
      <fieldset>
        <legend>Create new user</legend>
        <div class="field-row" style="margin-top:6px">
          <label for="adminNewName">Screen name:</label>
          <input id="adminNewName" type="text" placeholder="claude" autocomplete="off" />
        </div>
        <div class="field-row" style="margin-top:6px">
          <label for="adminNewRole">Role:</label>
          <select id="adminNewRole">
            <option value="member">member</option>
            <option value="moderator">moderator</option>
            <option value="admin">admin</option>
            <option value="read-only">read-only</option>
          </select>
        </div>
        <p class="help" id="adminRoleHelp" style="margin-top:4px"></p>
        <div id="adminCreateError" class="help hidden" style="color:#c00; margin-top:4px"></div>
        <div class="actions">
          <button type="button" id="adminCreateBtn">Mint token</button>
        </div>
      </fieldset>

      <div id="adminTokenReveal" class="token-reveal hidden">
        <strong>New token for <span id="adminRevealName"></span>:</strong>
        <div class="token-display">
          <code id="adminRevealToken"></code>
          <button type="button" id="adminCopyToken">Copy</button>
        </div>
        <p class="help" style="color:#a06; margin-top:4px">
          ⚠ This token cannot be retrieved later. Save it now and hand it to the user.
        </p>
      </div>

      <fieldset style="margin-top:10px">
        <legend>Existing users <button type="button" id="adminRefreshBtn" class="section-action" title="Refresh">↻</button></legend>
        <div id="adminTokenList" class="token-list">
          <p class="help">Loading…</p>
        </div>
      </fieldset>

      <div class="actions" style="margin-top:8px">
        <button type="button" class="modal-close">Done</button>
      </div>
    </div>`);

  overlay.querySelectorAll(".modal-close").forEach((b) => b.addEventListener("click", dismiss));
  const nameInput = overlay.querySelector("#adminNewName");
  const roleSelect = overlay.querySelector("#adminNewRole");
  const roleHelp = overlay.querySelector("#adminRoleHelp");
  const createBtn = overlay.querySelector("#adminCreateBtn");
  const errBox = overlay.querySelector("#adminCreateError");
  const reveal = overlay.querySelector("#adminTokenReveal");
  const revealName = overlay.querySelector("#adminRevealName");
  const revealToken = overlay.querySelector("#adminRevealToken");
  const copyBtn = overlay.querySelector("#adminCopyToken");
  const listBox = overlay.querySelector("#adminTokenList");
  const refreshBtn = overlay.querySelector("#adminRefreshBtn");

  const syncRoleHelp = () => { roleHelp.textContent = ROLE_DESCRIPTIONS[roleSelect.value] || ""; };
  roleSelect.addEventListener("change", syncRoleHelp);
  syncRoleHelp();

  createBtn.addEventListener("click", async () => {
    const name = nameInput.value.trim();
    const role = roleSelect.value;
    if (!name) {
      errBox.textContent = "Screen name is required.";
      errBox.classList.remove("hidden");
      return;
    }
    errBox.classList.add("hidden");
    createBtn.disabled = true;
    try {
      const res = await Client.adminCreateToken(name, role);
      revealName.textContent = name;
      revealToken.textContent = res.token;
      reveal.classList.remove("hidden");
      nameInput.value = "";
      await loadTokenList();
    } catch (e) {
      errBox.textContent = e.message;
      errBox.classList.remove("hidden");
    } finally {
      createBtn.disabled = false;
    }
  });

  copyBtn.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(revealToken.textContent);
      const orig = copyBtn.textContent;
      copyBtn.textContent = "Copied!";
      setTimeout(() => (copyBtn.textContent = orig), 1500);
    } catch {
      const range = document.createRange();
      range.selectNodeContents(revealToken);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }
  });

  refreshBtn.addEventListener("click", loadTokenList);

  async function loadTokenList() {
    listBox.innerHTML = `<p class="help">Loading…</p>`;
    try {
      const res = await Client.adminListTokens();
      const tokens = res.tokens || [];
      if (tokens.length === 0) {
        listBox.innerHTML = `<p class="help">No tokens yet.</p>`;
        return;
      }
      tokens.sort((a, b) => (a.created_at || "").localeCompare(b.created_at || ""));
      listBox.innerHTML = `
        <table class="token-table">
          <thead>
            <tr><th>Name</th><th>Role</th><th>Token</th><th>Created</th><th></th></tr>
          </thead>
          <tbody>
            ${tokens.map((t) => `
              <tr>
                <td>${escapeHtml(t.name)}</td>
                <td>${escapeHtml(t.role)}</td>
                <td><code>${escapeHtml(t.token_preview)}</code></td>
                <td class="help">${escapeHtml(fmtDate(t.created_at))}</td>
                <td><button type="button" class="revoke-btn" data-preview="${escapeHtml(t.token_preview)}" data-name="${escapeHtml(t.name)}">Revoke</button></td>
              </tr>`).join("")}
          </tbody>
        </table>
        <p class="help" style="margin-top:6px">
          Revoking removes all active tokens for that screen name. If a name has multiple tokens, the confirm dialog will say so.
        </p>`;
      listBox.querySelectorAll(".revoke-btn").forEach((b) => {
        b.addEventListener("click", () => promptRevoke(b.dataset.name, b.dataset.preview, b));
      });
    } catch (e) {
      listBox.innerHTML = `<p class="help" style="color:#c00">Failed to load: ${escapeHtml(e.message)}</p>`;
    }
  }

  async function promptRevoke(name, _preview, btn) {
    // If multiple tokens share this name (rare), revoke-by-name will take all
    // of them. We surface that in the confirm message so it's not a surprise.
    const nameCells = listBox.querySelectorAll("tr td:first-child");
    let matchCount = 0;
    nameCells.forEach((td) => { if (td.textContent === name) matchCount += 1; });

    const msg = matchCount > 1
      ? `'${name}' has ${matchCount} active tokens. Revoke ALL of them? They'll be signed out on next request.`
      : `Revoke ${name}'s token? They'll be signed out on next request.`;
    if (!confirm(msg)) return;

    btn.disabled = true;
    try {
      await Client.adminRevokeByName(name);
      await loadTokenList();
    } catch (e) {
      alert("Revoke failed: " + e.message);
      btn.disabled = false;
    }
  }

  loadTokenList();
}

const SIGNON_STATUS_TIPS = [
  "Powered by git",
  "Every message is a commit.",
  "Your token stays in this browser.",
  "Humans and bots share the same rooms.",
  "Pins are git tags.",
  "Rooms are folders in the repo.",
];

function formatSignonError(err) {
  const status = err && typeof err.status === "number" ? err.status : null;
  const msg = err && err.message ? String(err.message) : "Something went wrong.";
  if (status === 401 || /\b401\b/.test(msg)) {
    return "That token didn\u2019t work — paste the full aim_\u2026 string or ask your admin for a new one.";
  }
  if (status === 403 || /\b403\b/.test(msg)) {
    return "This account can\u2019t sign on right now — check with your admin.";
  }
  if (/failed to fetch|networkerror|load failed|net::/i.test(msg)) {
    return "Couldn\u2019t reach the server — check your connection and try again.";
  }
  return `Couldn\u2019t sign on — ${msg}`;
}

function nudgeTokenField(input) {
  input.classList.remove("signon-input-nudge");
  // reflow so repeated errors re-trigger CSS animation when supported
  void input.offsetWidth;
  input.classList.add("signon-input-nudge");
  window.setTimeout(() => input.classList.remove("signon-input-nudge"), 650);
}

function startSignonStatusTicker(el) {
  if (!el) return null;
  const tips = [...SIGNON_STATUS_TIPS];
  let i = Math.floor(Math.random() * tips.length);
  el.textContent = tips[i];
  return window.setInterval(() => {
    i = (i + 1) % tips.length;
    el.textContent = tips[i];
  }, 7200);
}

// Sign-on page handler
export function bootSignOn() {
  const tickerEl = $("#signonTicker");
  startSignonStatusTicker(tickerEl);

  const form = $("#signonForm");
  const submitBtn = $("#signonSubmitBtn");
  const helpBtn = $("#helpBtn");
  const tokenInput = $("#tokenInput");
  const errEl = $("#signonError");
  const defaultSubmitLabel = submitBtn ? submitBtn.textContent : "Sign On";

  if (Client.getToken()) {
    Client.me()
      .then(() => (location.href = "/chat"))
      .catch(() => Client.clearToken());
  }

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const token = tokenInput.value.trim();
    if (!token) return;

    errEl.classList.add("hidden");
    errEl.textContent = "";
    Client.setToken(token);
    form.classList.add("signon-form--busy");
    submitBtn.disabled = true;
    submitBtn.setAttribute("aria-busy", "true");
    if (helpBtn) helpBtn.disabled = true;
    submitBtn.textContent = "Connecting\u2026";

    try {
      await Client.me();
      submitBtn.textContent = "Signed on!";
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      location.href = "/chat";
      return;
    } catch (err) {
      Client.clearToken();
      errEl.textContent = formatSignonError(err);
      errEl.classList.remove("hidden");
      nudgeTokenField(tokenInput);
      tokenInput.focus();
    }
    form.classList.remove("signon-form--busy");
    submitBtn.disabled = false;
    submitBtn.removeAttribute("aria-busy");
    if (helpBtn) helpBtn.disabled = false;
    submitBtn.textContent = defaultSubmitLabel;
  });
}
