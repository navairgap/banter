/* banter client v2 — Discord-style UI.
 * Renders everything with DOM APIs + textContent, so user input can never
 * inject markup. URLs are linkified by building <a> nodes with textContent
 * and an http(s)-only regex — never innerHTML. */

const $ = (id) => document.getElementById(id);

const joinScreen = $("join-screen");
const chatScreen = $("chat-screen");
const joinForm = $("join-form");
const chatForm = $("chat-form");
const nameInput = $("name-input");
const roomInput = $("room-input");
const roomOptions = $("room-options");
const joinHint = $("join-hint");
const roomNameEl = $("room-name");
const connDot = $("conn-dot");
const connLabel = $("conn-label");
const meAvatar = $("me-avatar");
const meName = $("me-name");
const meStatus = $("me-status");
const onlineCount = $("online-count");
const membersCount = $("members-count");
const railRoomsEl = $("rail-rooms");
const railHome = $("rail-home");
const roomListEl = $("room-list");
const userListEl = $("user-list");
const introName = $("intro-name");
const introName2 = $("intro-name-2");
const messagesEl = $("messages");
const typingBar = $("typing-bar");
const typingText = $("typing-text");
const msgInput = $("msg-input");
const sendBtn = $("send-btn");
const charCount = $("char-count");
const jumpPill = $("jump-pill");
const sidebar = $("sidebar");
const roomDialog = $("room-dialog");
const roomDialogForm = $("room-dialog-form");
const roomDialogInput = $("room-dialog-input");
const toastsEl = $("toasts");

const MAX_DOM_MESSAGES = 350;       // trim old nodes so long sessions stay light
const TYPING_IDLE_MS = 2500;        // stop the indicator after this much silence
const NEAR_BOTTOM_PX = 80;          // "at the bottom" tolerance for autoscroll
const REVEALED_LINK_TRAILING = /[.,;:!?)\]}'"]+$/; // punctuation that is not part of a URL

let socket = null;
let myName = "";
let myRoom = "lobby";
let desired = { name: "", room: "lobby" }; // what the server should see (re)joined
let typingUsers = new Map(); // name -> timeout id
let typingActive = false;
let typingStopTimer = null;
let unseen = 0;
let baseTitle = document.title;
let lastAuthor = null;       // message grouping: consecutive same-author messages
let lastWasMessage = false;  //   collapse their avatar/header

const timeFmt = new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" });
const fmtTime = (ts) => {
  const d = new Date(ts);
  return Number.isFinite(d.getTime()) ? timeFmt.format(d) : "";
};

/* ---------- helpers ---------- */

function avatarColor(name) {
  let h = 0;
  for (const ch of name) h = (h * 31 + ch.charCodeAt(0)) >>> 0;
  return `hsl(${h % 360} 45% 45%)`;
}

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text; // XSS-safe by construction
  return node;
}

function makeAvatar(name) {
  const av = el("div", "avatar", name.slice(0, 2).toUpperCase());
  av.style.background = avatarColor(name);
  return av;
}

function toast(text) {
  const node = el("div", "toast", text);
  toastsEl.appendChild(node);
  setTimeout(() => node.classList.add("gone"), 2800);
  setTimeout(() => node.remove(), 3300);
}

function isNearBottom() {
  return messagesEl.scrollHeight - messagesEl.scrollTop - messagesEl.clientHeight < NEAR_BOTTOM_PX;
}

function scrollToBottom(smooth) {
  messagesEl.scrollTo({ top: messagesEl.scrollHeight, behavior: smooth ? "smooth" : "auto" });
}

function hideJumpPill() {
  unseen = 0;
  updateTitle();
  jumpPill.classList.add("hidden");
}

jumpPill.addEventListener("click", () => {
  hideJumpPill();
  scrollToBottom(true);
});

messagesEl.addEventListener("scroll", () => {
  if (isNearBottom()) hideJumpPill();
});

function updateTitle() {
  document.title = unseen > 0 ? `(${unseen}) ${baseTitle}` : baseTitle;
}

function updateCharCounter() {
  const remaining = msgInput.maxLength - msgInput.value.length;
  charCount.textContent = remaining < 100 ? String(remaining) : "";
}

/* ---------- rendering ---------- */

/** Append text with http(s) URLs turned into safe <a> nodes. */
function appendFormattedText(parent, text) {
  let last = 0;
  for (const match of text.matchAll(/https?:\/\/[^\s<>"']+/g)) {
    const raw = match[0];
    const trailing = raw.match(REVEALED_LINK_TRAILING);
    const url = trailing ? raw.slice(0, raw.length - trailing[0].length) : raw;
    if (match.index > last) parent.append(text.slice(last, match.index));
    const a = document.createElement("a");
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer nofollow";
    a.textContent = url;
    parent.append(a);
    if (trailing) parent.append(trailing[0]);
    last = match.index + raw.length;
  }
  if (last < text.length) parent.append(text.slice(last));
}

function trimOldMessages() {
  while (messagesEl.childElementCount > MAX_DOM_MESSAGES) {
    messagesEl.firstElementChild.remove();
  }
}

function addMessage({ user, text, ts }) {
  if (typeof user !== "string" || typeof text !== "string") return; // defensive
  const own = user === myName;
  const wasNearBottom = isNearBottom();
  const grouped = lastWasMessage && user === lastAuthor;
  const wrap = el("div", "msg" + (grouped ? " grouped" : " group-start"));

  // Discord-style grouping: repeat messages from the same author drop the
  // avatar and header; the avatar slot stays (hidden) for indentation.
  const av = makeAvatar(user);
  if (grouped) av.style.visibility = "hidden";
  const body = el("div", "msg-body");
  if (!grouped) {
    const header = el("div", "msg-header");
    header.append(el("span", "name", user), el("span", "time", fmtTime(ts)));
    body.appendChild(header);
  } else {
    wrap.appendChild(el("span", "gutter-time", fmtTime(ts)));
  }
  const textEl = el("div", "msg-text");
  appendFormattedText(textEl, text);
  body.appendChild(textEl);
  wrap.append(av, body);

  messagesEl.appendChild(wrap);
  trimOldMessages();
  if (wasNearBottom) scrollToBottom();

  lastAuthor = user;
  lastWasMessage = true;

  if (document.hidden && !own) {
    unseen += 1;
    updateTitle();
  } else if (!wasNearBottom && !own) {
    unseen += 1;
    updateTitle();
    jumpPill.classList.remove("hidden");
  }
}

function addSystem(text, ts) {
  const wasNearBottom = isNearBottom();
  lastAuthor = null;
  lastWasMessage = false;
  const line = el("div", "system");
  line.append(el("span", "", text), el("span", "time", fmtTime(ts)));
  messagesEl.appendChild(line);
  trimOldMessages();
  if (wasNearBottom) scrollToBottom();
}

function clearMessages() {
  messagesEl.replaceChildren();
  lastAuthor = null;
  lastWasMessage = false;
  hideJumpPill();
}

function renderUsers(list) {
  lastUsers = list; // cached so acks can re-render with fresh identity
  userListEl.replaceChildren();
  for (const name of list) {
    const li = el("li");
    const av = makeAvatar(name);
    const label = el("span", "", name === myName ? name + " (you)" : name);
    li.append(av, label);
    userListEl.appendChild(li);
  }
  membersCount.textContent = String(list.length);
  onlineCount.textContent = list.length ? `${list.length} online` : "";
}

function renderRooms(list) {
  lastRooms = list;
  railRoomsEl.replaceChildren();
  roomListEl.replaceChildren();
  roomOptions.replaceChildren();
  for (const entry of list) {
    // rail icon (quick switcher)
    const item = el("button", "rail-item" + (entry.name === myRoom ? " active" : ""),
      entry.name.slice(0, 2));
    item.type = "button";
    item.title = entry.name;
    item.style.setProperty("--room-color", avatarColor(entry.name));
    item.addEventListener("click", () => switchRoom(entry.name));
    railRoomsEl.appendChild(item);

    // channel entry
    const li = el("li", entry.name === myRoom ? "active" : "", entry.name);
    li.addEventListener("click", () => switchRoom(entry.name));
    roomListEl.appendChild(li);

    const opt = el("option");
    opt.value = entry.name;
    roomOptions.appendChild(opt);
  }
}

let lastUsers = [];   // last rosters from the server…
let lastRooms = [];   // …kept so acks can re-render with fresh identity

/* Broadcasts can arrive just before the join ack that updates myName/
 * myRoom — re-render from the cached rosters once the ack lands. */
function refreshRosters() {
  if (lastUsers.length) renderUsers(lastUsers);
  if (lastRooms.length) renderRooms(lastRooms);
}

function updateTypingBar() {
  const names = [...typingUsers.keys()].filter((n) => n !== myName);
  if (!names.length) {
    typingBar.classList.add("hidden");
    return;
  }
  typingBar.classList.remove("hidden");
  typingText.textContent =
    names.length === 1
      ? `${names[0]} is typing...`
      : `${names.slice(0, 2).join(", ")}${names.length > 2 ? ` +${names.length - 2}` : ""} are typing...`;
}

/* ---------- socket ---------- */

function setConnected(on) {
  connDot.className = "conn-dot " + (on ? "online" : "offline");
  connDot.title = on ? "connected" : "disconnected";
  connLabel.textContent = on ? "Online" : "Offline — reconnecting…";
  meStatus.classList.toggle("online", on);
  msgInput.disabled = !on;
  sendBtn.disabled = !on;
  if (!on) {
    stopTyping();
    typingUsers.clear();
    updateTypingBar();
  }
}

function syncIdentity() {
  meAvatar.textContent = myName.slice(0, 2).toUpperCase();
  meAvatar.style.background = avatarColor(myName);
  meName.textContent = myName;
  roomNameEl.textContent = myRoom;
  introName.textContent = myRoom;
  introName2.textContent = myRoom;
}

function connect(name, room, isInitial) {
  desired = { name, room };
  socket = io();

  socket.on("connect", () => {
    setConnected(true);
    // Always re-join the *current* desired room — not the one from the very
    // first login — so a reconnect never silently moves rooms.
    socket.emit("join", desired, (res) => {
      if (!res || !res.ok) {
        if (isInitial) {
          chatScreen.classList.add("hidden");
          joinScreen.classList.remove("hidden");
          joinHint.textContent = (res && res.error) || "could not join";
        } else {
          toast((res && res.error) || "could not join room");
        }
        return;
      }
      myName = res.name;
      myRoom = res.room;
      desired = { name: myName, room: myRoom };
      syncIdentity();
      clearMessages();
      typingUsers.clear();
      updateTypingBar();
      refreshRosters();
      if (isInitial) {
        msgInput.focus();
      }
    });
  });

  socket.on("disconnect", () => setConnected(false));

  socket.on("message", (m) => addMessage(m));

  socket.on("system", (s) => addSystem(s.text, s.ts));

  socket.on("users", renderUsers);

  socket.on("rooms", renderRooms);

  socket.on("typing", ({ user, isTyping }) => {
    if (typeof user !== "string") return;
    clearTimeout(typingUsers.get(user));
    typingUsers.delete(user);
    if (isTyping) {
      typingUsers.set(
        user,
        setTimeout(() => {
          typingUsers.delete(user);
          updateTypingBar();
        }, 3000)
      );
    }
    updateTypingBar();
  });
}

function switchRoom(room) {
  if (!socket || room === myRoom) return;
  socket.emit("join", { name: myName, room }, (res) => {
    if (!res || !res.ok) {
      toast((res && res.error) || "could not join room");
      return;
    }
    myName = res.name;   // server may rename on collision — stay in sync
    myRoom = res.room;
    desired = { name: myName, room: myRoom };
    syncIdentity();
    clearMessages();
    typingUsers.clear();
    updateTypingBar();
    refreshRosters();
    sidebar.classList.remove("open");
    msgInput.focus();
  });
}

/* ---------- typing (throttled: one event per burst, not per keystroke) ---------- */

function stopTyping() {
  clearTimeout(typingStopTimer);
  typingStopTimer = null;
  // Only signal while actually connected — emits on a dropped socket would
  // buffer and flush a stale "stopped typing" after reconnecting.
  if (typingActive && socket && socket.connected) socket.emit("typing", false);
  typingActive = false;
}

function autoSizeInput() {
  msgInput.style.height = "auto";
  msgInput.style.height = Math.min(msgInput.scrollHeight, 160) + "px";
}

msgInput.addEventListener("input", () => {
  autoSizeInput();
  updateCharCounter();
  if (!socket) return;
  if (!typingActive && msgInput.value.length > 0) {
    typingActive = true;
    socket.emit("typing", true);
  }
  clearTimeout(typingStopTimer);
  if (msgInput.value.length === 0) {
    stopTyping();
  } else {
    typingStopTimer = setTimeout(stopTyping, TYPING_IDLE_MS);
  }
});

/* ---------- events ---------- */

joinForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const name = nameInput.value.trim();
  if (!name) {
    joinHint.textContent = "Pick a nickname first.";
    return;
  }
  joinHint.textContent = "";
  joinScreen.classList.add("hidden");
  chatScreen.classList.remove("hidden");
  connect(name, roomInput.value.trim() || "lobby", true);
});

chatForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = msgInput.value.trim();
  if (!text || !socket) return;
  socket.emit("message", text, (res) => {
    if (res && !res.ok) toast(res.error);
  });
  msgInput.value = "";
  autoSizeInput();
  updateCharCounter();
  stopTyping();
  msgInput.focus();
});

// Enter sends, Shift+Enter adds a line (never during IME composition)
msgInput.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    chatForm.requestSubmit();
  }
});

$("leave-btn").addEventListener("click", () => location.reload());

$("sidebar-toggle").addEventListener("click", () =>
  sidebar.classList.toggle("open")
);

railHome.addEventListener("click", () => switchRoom("lobby"));

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && sidebar.classList.contains("open") &&
      !roomDialog.open) {
    sidebar.classList.remove("open");
  }
});

/* ---------- new room dialog ---------- */

function openRoomDialog() {
  roomDialogInput.value = "";
  roomDialog.showModal();
  roomDialogInput.focus();
}

$("new-room-btn").addEventListener("click", openRoomDialog);
$("input-plus").addEventListener("click", openRoomDialog);

$("room-dialog-cancel").addEventListener("click", () => roomDialog.close());

roomDialog.addEventListener("cancel", () => roomDialogInput.value = "");

roomDialogForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const room = roomDialogInput.value.trim();
  if (!room || !socket) return;
  socket.emit("new room", room, (res) => {
    if (res && res.ok) {
      roomDialog.close();
      switchRoom(res.room);
    } else {
      toast((res && res.error) || "could not create room");
    }
  });
});

document.addEventListener("visibilitychange", () => {
  if (!document.hidden) {
    unseen = 0; // back on the tab — the pill stays until they scroll down
    updateTitle();
  }
});

nameInput.focus();
