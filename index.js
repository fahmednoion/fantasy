require("dotenv").config();
const { io } = require("socket.io-client");
const fetch = (...args) => import("node-fetch").then(({ default: f }) => f(...args));
const fs = require("fs");
const path = require("path");
const express = require("express");

const app = express();
const PORT = process.env.PORT || 3000;

app.get("/", (req, res) => {
  res.json({
    status: "online",
    bot: process.env.MIG66_USERNAME,
    uptime: process.uptime()
  });
});

app.get("/health", (req, res) => {
  res.status(200).send("OK");
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`🌐 Web service listening on port ${PORT}`);
});

// ── Save token to .env ────────────────────────────────────────
function saveTokenToEnv(newToken) {
  try {
    const envPath = path.join(__dirname, ".env");
    let content = fs.existsSync(envPath) ? fs.readFileSync(envPath, "utf8") : "";
    if (content.includes("MIG66_TOKEN=")) {
      content = content.replace(/MIG66_TOKEN=.*/g, `MIG66_TOKEN=${newToken}`);
    } else {
      content += `\nMIG66_TOKEN=${newToken}`;
    }
    fs.writeFileSync(envPath, content, "utf8");
    console.log(`[.env] ✅ Token saved (${newToken.slice(0, 20)}...)`);
  } catch (e) {
    console.error(`[.env] ❌ Could not save token: ${e.message}`);
  }
}

const API_BASE = "https://dashboard.mig66.com";
const TRIGGER = (process.env.TRIGGER_KEYWORD || `@${process.env.MIG66_USERNAME}`).toLowerCase();

const PARENT_USERNAMES = new Set(
  (process.env.PARENT_USERNAMES || process.env.PARENT_USERNAME || "faysal")
    .split(",")
    .map((u) => u.trim().toLowerCase())
    .filter(Boolean)
);

const isParent = (u) => PARENT_USERNAMES.has((u || "").toLowerCase());

// ── Room List Management ─────────────────────────────────────
const ROOM_LIST = new Map([
  ["Dhaka", 50],
  ["Bangladesh", 1],
  ["India", 2],
  ["Nepal", 3],
  ["Philippine", 4],
  ["Indonesia", 5],
  ["Savages", 46],
]);

function addRoom(roomName, roomId) {
  ROOM_LIST.set(roomName.trim(), Number(roomId));
}

function removeRoom(roomName) {
  ROOM_LIST.delete(roomName.trim());
}

function listRooms() {
  return [...ROOM_LIST.entries()].map(([name, id]) => `${name}=${id}`).join(", ");
}

// ══════════════════════════════════════════════════════════════
//  BOT ACCOUNT
// ══════════════════════════════════════════════════════════════
class BotAccount {
  constructor({ username, password, token, isMain = false }) {
    this.username = username;
    this.password = password;
    this.token = token || null;
    this.isMain = isMain;
    this.userId = null;
    this.socket = null;
    this.joinedRooms = new Set();
    this.voucherOn = true;
    this.awOn = true;
    this.autoReplyOn = true;
    this.awTemplate = process.env.AW_MESSAGE || "Wc {username} 🎉 Welcome!";
    this.balance = null;
    this.isConnected = false;
    this.reconnTimer = null;
    this.processed = new Set();
    this.startTime = Date.now();
  }

  log(msg) {
    console.log(`[${this.username}] ${msg}`);
  }

  // ── Login ─────────────────────────────────────────────────
  async login() {
    if (this.token && !this.isTokenExpired()) {
      try {
        const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
        this.userId = String(p.id || "");
        const exp = new Date(p.exp * 1000).toLocaleString();
        this.log(`✓ Token valid — user: ${p.username}, ID: ${this.userId}, expires: ${exp}`);
        return true;
      } catch (_) {}
    }

    if (!this.password) {
      this.log("❌ No password set and token is missing/expired. Add MIG66_PASSWORD to .env");
      return false;
    }

    this.log("Logging in with password...");
    try {
      const resp = await fetch(`${API_BASE}/api/auth/login`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://web.mig66.com",
          Referer: "https://web.mig66.com/",
          "User-Agent":
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
          Accept: "application/json, text/plain, */*",
          "Accept-Language": "en-US,en;q=0.9",
          "sec-fetch-dest": "empty",
          "sec-fetch-mode": "cors",
          "sec-fetch-site": "same-site",
        },
        body: JSON.stringify({
          username: this.username,
          password: this.password,
          remember_me: true,
          login_offline: false,
          device_info: "Flutter Web",
        }),
      });
      const data = await resp.json();
      this.token = data?.token || data?.data?.token;
      if (!this.token) {
        this.log(`❌ Login failed (${resp.status}): ${JSON.stringify(data).slice(0, 100)}`);
        return false;
      }
      const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
      this.userId = String(p.id || "");
      this.log(`✓ Logged in — ID: ${this.userId}`);
      if (this.isMain) saveTokenToEnv(this.token);
      return true;
    } catch (e) {
      this.log(`❌ Login error: ${e.message}`);
      return false;
    }
  }

  // ── Token expiry check ────────────────────────────────────
  isTokenExpired() {
    if (!this.token) return true;
    try {
      const p = JSON.parse(Buffer.from(this.token.split(".")[1], "base64").toString());
      const exp = p.exp * 1000;
      return Date.now() > exp - 60 * 60 * 1000;
    } catch (_) {
      return false;
    }
  }

  // ── Authenticated HTTP helper ─────────────────────────────
  async api(method, path, body) {
    const opts = {
      method,
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${this.token}` },
    };
    if (body) opts.body = JSON.stringify(body);
    const resp = await fetch(`${API_BASE}${path}`, opts);
    const text = await resp.text();
    try {
      return { status: resp.status, data: JSON.parse(text) };
    } catch (_) {
      return { status: resp.status, data: text };
    }
  }

  // ── Messaging ─────────────────────────────────────────────
  sendRoom(roomId, text) {
    if (!this.socket?.connected) return;
    this.socket.emit("send_message", {
      room_id: Number(roomId),
      content: text,
      msg_type: "text",
      client_msg_id: `bot_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
    });
    this.log(`→ Room ${roomId}: "${text.slice(0, 80)}"`);
  }

  sendPrivate(toUsername, text) {
    if (!this.socket?.connected) return;
    this.socket.emit("private_message", { to_username: toUsername, content: text });
    this.log(`→ PM @${toUsername}: "${text.slice(0, 80)}"`);
  }

  // ── Room control ──────────────────────────────────────────
  joinRoom(roomId) {
    roomId = Number(roomId);
    this.socket.emit("join_room", { room_id: roomId, is_manual: true });
    this.joinedRooms.add(roomId);
    this.log(`+ Joining room ${roomId}`);
  }

  leaveRoom(roomId) {
    roomId = Number(roomId);
    this.socket.emit("leave_room", { room_id: roomId });
    this.joinedRooms.delete(roomId);
    this.log(`- Left room ${roomId}`);
  }

  leaveAll() {
    for (const r of this.joinedRooms) this.socket.emit("leave_room", { room_id: r });
    const count = this.joinedRooms.size;
    this.joinedRooms.clear();
    return count;
  }

  // ── Friend actions ────────────────────────────────────────
  async sendFriendRequest(username) {
    const r = await this.api("POST", "/api/friends/request", { username });
    this.log(`Friend request → @${username}: ${r.status}`);
    return r;
  }

  async acceptFriendRequest(requestId) {
    const r = await this.api("POST", "/api/friends/accept", { request_id: Number(requestId) });
    this.log(`Accept friend #${requestId}: ${r.status}`);
    return r;
  }

  async getFriendRequests() {
    return await this.api("GET", "/api/friends/requests");
  }

  // ── Voucher auto-pick ─────────────────────────────────────
  tryPickVoucher(content, roomId) {
    if (!this.voucherOn) return false;
    if (!content.toLowerCase().includes("pick") || !content.toLowerCase().includes("code")) return false;
    const match = content.match(/\[code\]\s+(\d{4,10})/i);
    if (match) {
      const code = match[1];
      this.log(`🎁 VOUCHER in room ${roomId}! Code: ${code}`);
      this.sendRoom(roomId, `/pick ${code}`);
      return true;
    }
    return false;
  }

  // ── Auto-welcome ──────────────────────────────────────────
  handleUserJoined(data) {
    if (!this.awOn) return;
    if (!this.joinedRooms.has(Number(data.room_id))) return;
    if ((data.username || "").toLowerCase() === this.username.toLowerCase()) return;

    const welcomeMsg = this.awTemplate.replace("{username}", data.username);
    this.log(`👋 Welcoming @${data.username} in room ${data.room_id}`);
    setTimeout(() => this.sendRoom(data.room_id, welcomeMsg), 800);
  }

  // ── Status text ───────────────────────────────────────────
  statusText() {
    const rooms = this.joinedRooms.size > 0 ? [...this.joinedRooms].join(", ") : "none";
    const bal = this.balance !== null ? `${this.balance} cents` : "unknown";
    const uptime = ((Date.now() - this.startTime) / 1000).toFixed(0);
    return (
      `👤 @${this.username}\n` +
      `  Connection  : ${this.isConnected ? "🟢 Online" : "🔴 Offline"}\n` +
      `  Active rooms: [${rooms}]\n` +
      `  Voucher pick: ${this.voucherOn ? "🟢 ON" : "🔴 OFF"}\n` +
      `  Auto-welcome: ${this.awOn ? `🟢 ON — "${this.awTemplate}"` : "🔴 OFF"}\n` +
      `  Auto-reply  : ${this.autoReplyOn ? "🟢 ON" : "🔴 OFF"}\n` +
      `  Balance     : ${bal}\n` +
      `  Uptime      : ${formatUptime(uptime)}`
    );
  }

  // ── Handle incoming private message ───────────────────────
  async handlePrivate(data) {
    const senderId = String(data.sender_id || "");
    const senderName = String(data.sender_name || "");
    const content = String(data.content || "").trim();
    if (!content) return;
    if (this.userId && senderId === this.userId) return;
    if (senderName.toLowerCase() === this.username.toLowerCase()) return;

    // Handle AI trigger "/a"
    if (content.toLowerCase().startsWith("/a ") && this.autoReplyOn) {
      const question = content.slice(3).trim();
      this.log(`🤖 AI Query from @${senderName}: "${question}"`);
      let reply;
      try {
        reply = await getAIReply(question);
      } catch (e) {
        reply = "Sorry, couldn't answer right now!";
        console.error("[AI]", e.message);
      }
      this.sendPrivate(senderName, reply);
      return;
    }

    if (isParent(senderName) && content.startsWith("|")) {
      await handleParentCommand(content, senderName, this);
      return;
    }

    if (this.autoReplyOn) {
      const question = content.replace(new RegExp(TRIGGER, "gi"), "").trim() || content;
      const key = `pvt:${senderId}:${question.slice(0, 80)}`;
      if (this.processed.has(key)) return;
      this.processed.add(key);
      if (this.processed.size > 500) this.processed.delete(this.processed.values().next().value);

      this.log(`💬 PM from @${senderName}: "${question}"`);
      let reply;
      try {
        reply = await getAIReply(question);
      } catch (e) {
        reply = "Sorry, couldn't answer right now!";
        console.error("[AI]", e.message);
      }
      this.sendPrivate(senderName, reply);
    }
  }

  // ── Handle incoming room message ───────────────────────────
  async handleRoom(data) {
    const senderId = String(data.sender_id || "");
    const senderName = String(data.username || "");
    const content = String(data.content || "").trim();
    const roomId = data.room_id;
    if (!content) return;
    if (this.userId && senderId === this.userId) return;
    if (senderName.toLowerCase() === this.username.toLowerCase()) return;

    // Handle AI trigger "/a"
    if (content.toLowerCase().startsWith("/a ") && this.autoReplyOn) {
      const question = content.slice(3).trim();
      this.log(`🤖 AI Query from @${senderName} in room ${roomId}: "${question}"`);
      let reply;
      try {
        reply = await getAIReply(question);
      } catch (e) {
        reply = "Sorry, couldn't answer right now!";
        console.error("[AI]", e.message);
      }
      this.sendRoom(roomId, `@${senderName} ${reply}`);
      return;
    }

    if (this.tryPickVoucher(content, roomId)) return;

    if (this.autoReplyOn && content.toLowerCase().includes(TRIGGER)) {
      const question = content.replace(new RegExp(TRIGGER, "gi"), "").trim() || content;
      const key = `room:${senderId}:${question.slice(0, 80)}`;
      if (this.processed.has(key)) return;
      this.processed.add(key);
      if (this.processed.size > 500) this.processed.delete(this.processed.values().next().value);

      this.log(`📢 Room @${senderName}: "${question}"`);
      let reply;
      try {
        reply = await getAIReply(question);
      } catch (e) {
        reply = "Sorry, couldn't answer right now!";
        console.error("[AI]", e.message);
      }
      this.sendRoom(roomId, `@${senderName} ${reply}`);
    }
  }

  // ── Connect socket ─────────────────────────────────────────
  connect(defaultRoom) {
    if (this.reconnTimer) {
      clearTimeout(this.reconnTimer);
      this.reconnTimer = null;
    }
    this.log("Connecting...");

    this.socket = io(API_BASE, {
      auth: { token: this.token },
      transports: ["websocket", "polling"],
      reconnection: false,
    });

    this.socket.on("connect", async () => {
      this.isConnected = true;
      this.log(`✓ Connected! SID: ${this.socket.id}`);
      await new Promise((r) => setTimeout(r, 400));
      const rooms = this.joinedRooms.size > 0 ? [...this.joinedRooms] : [defaultRoom];
      this.joinedRooms.clear();
      for (const r of rooms) this.joinRoom(r);
    });

    this.socket.on("room_joined", (d) => {
      this.joinedRooms.add(Number(d?.room_id));
      this.log(`✓ Joined room ${d?.room_id} (${d?.members?.length} members)`);
    });

    this.socket.on("user_joined_room", (d) => this.handleUserJoined(d));
    this.socket.on("balance_update", (d) => {
      this.balance = d?.balance_cents;
    });
    this.socket.on("private_message", (d) => this.handlePrivate(d).catch(console.error));
    this.socket.on("new_message", (d) => this.handleRoom(d).catch(console.error));
    this.socket.on("private_message_sent", (d) =>
      this.log(`✓ PM delivered: "${String(d?.content || "").slice(0, 60)}"`)
    );

    this.socket.on("disconnect", (reason) => {
      this.isConnected = false;
      this.log(`! Disconnected: ${reason}`);
      if (reason === "io client disconnect") return;
      const delay = 5000;
      this.log(`Reconnecting in ${delay / 1000}s...`);
      this.reconnTimer = setTimeout(async () => {
        if (this.isTokenExpired()) {
          this.log("⚠️  Token expired — re-logging in...");
          this.token = null;
          const ok = await this.login();
          if (!ok) {
            this.log("❌ Re-login failed. Retrying in 30s...");
            this.reconnTimer = setTimeout(() => this.connect(defaultRoom), 30000);
            return;
          }
        }
        this.connect(defaultRoom);
      }, delay);
    });

    this.socket.on("connect_error", (e) => {
      this.isConnected = false;
      this.log(`! Connect error: ${e.message} — retry in 8s`);
      this.reconnTimer = setTimeout(() => this.connect(defaultRoom), 8000);
    });

    if (process.env.DEBUG === "true") {
      this.socket.onAny((event, data) => {
        const SKIP = [
          "room_count_update",
          "private_user_typing",
          "user_joined",
          "user_left",
          "user_left_room",
          "user_joined_room",
          "room_joined",
          "new_message",
          "private_message",
          "private_message_sent",
          "system_message",
          "uno_state",
          "balance_update",
          "connect",
          "disconnect",
        ];
        if (!SKIP.includes(event))
          this.log(`[evt] "${event}": ${JSON.stringify(data).slice(0, 150)}`);
      });
    }
  }

  disconnect() {
    if (this.reconnTimer) clearTimeout(this.reconnTimer);
    if (this.socket) this.socket.disconnect();
    this.isConnected = false;
  }
}

// ══════════════════════════════════════════════════════════════
//  MULTI-ACCOUNT MANAGER
// ══════════════════════════════════════════════════════════════
const accounts = new Map();

// ── Parent command handler ─────────────────────────────────────
async function handleParentCommand(content, senderName, callerAccount) {
  const cmd = content.trim();
  const reply = (text) => callerAccount.sendPrivate(senderName, text);
  console.log(`\n[👑] Parent @${senderName} → @${callerAccount.username}: "${cmd}"`);

  // Resolve optional target account: |cmd @firefox ...
  let target = callerAccount;
  const acctMatch = cmd.match(/^\|\w+\s+@(\w+)/);
  if (acctMatch) {
    const acctName = acctMatch[1].toLowerCase();
    if (accounts.has(acctName)) target = accounts.get(acctName);
    else {
      reply(`❌ Unknown account @${acctName}`);
      return;
    }
  }

  // ── Room List Management ────────────────────────────────────
  const addRoomMatch = cmd.match(/^\|addroom\s+(.+)/i);
  if (addRoomMatch) {
    const roomsToAdd = addRoomMatch[1].split(",");
    for (const room of roomsToAdd) {
      const [name, id] = room.split(/[:=]/).map((s) => s.trim());
      if (!name || !id) {
        reply(`❌ Invalid room format: "${room}". Use "Name=ID" or "Name:ID".`);
        return;
      }
      addRoom(name, id);
      reply(`✅ Added room: ${name}=${id}`);
    }
    return;
  }

  const removeRoomMatch = cmd.match(/^\|removeroom\s+(.+)/i);
  if (removeRoomMatch) {
    const roomsToRemove = removeRoomMatch[1].split(",");
    for (const room of roomsToRemove) {
      const [name] = room.split(/[:=]/).map((s) => s.trim());
      if (!name) {
        reply(`❌ Invalid room format: "${room}". Use "Name" or "Name=ID".`);
        return;
      }
      if (ROOM_LIST.has(name)) {
        removeRoom(name);
        reply(`✅ Removed room: ${name}`);
      } else {
        reply(`❌ Room "${name}" not found.`);
      }
    }
    return;
  }

  if (/^\|listroom/i.test(cmd)) {
    const roomList = listRooms();
    reply(`📋 Room List:\n${roomList}`);
    return;
  }

  // ── Account management ────────────────────────────────────
  const loginMatch = cmd.match(/^\|lnu\s+(\w+):(\S+)/i);
  if (loginMatch) {
    const [, uname, pass] = loginMatch;
    if (accounts.has(uname.toLowerCase())) {
      reply(`⚠️ @${uname} already logged in`);
      return;
    }
    reply(`⏳ Logging in @${uname}...`);
    const acc = new BotAccount({ username: uname, password: pass });
    const ok = await acc.login();
    if (!ok) {
      reply(`❌ Login failed for @${uname}`);
      return;
    }
    accounts.set(uname.toLowerCase(), acc);
    acc.connect(Number(process.env.MIG66_ROOM_ID || 50));
    reply(`✅ @${uname} logged in and connected!`);
    return;
  }

  const logoutMatch = cmd.match(/^\|ltu\s+(\w+)/i);
  if (logoutMatch) {
    const uname = logoutMatch[1].toLowerCase();
    if (uname === process.env.MIG66_USERNAME?.toLowerCase()) {
      reply("❌ Cannot logout main account");
      return;
    }
    const acc = accounts.get(uname);
    if (!acc) {
      reply(`❌ @${uname} not logged in`);
      return;
    }
    acc.disconnect();
    accounts.delete(uname);
    reply(`✅ @${uname} logged out`);
    return;
  }

  if (/^\|accounts/i.test(cmd)) {
    const list = [...accounts.values()]
      .map(
        (a) =>
          `  @${a.username} ${a.isConnected ? "🟢" : "🔴"} rooms:[${[...a.joinedRooms].join(",") || "none"}]`
      )
      .join("\n");
    reply(`👥 Active (${accounts.size}):\n${list}`);
    return;
  }

  // ── Friends ───────────────────────────────────────────────
  const sendFriendMatch = cmd.match(/^\|sf\s+(\w+)/i);
  if (sendFriendMatch) {
    const r = await target.sendFriendRequest(sendFriendMatch[1]);
    reply(
      `${r.status < 400 ? "✅" : "❌"} Friend request to @${sendFriendMatch[1]} from @${
        target.username
      }: ${JSON.stringify(r.data).slice(0, 80)}`
    );
    return;
  }

  const acceptMatch = cmd.match(/^\|af\s+(\d+)/i);
  if (acceptMatch) {
    const r = await target.acceptFriendRequest(acceptMatch[1]);
    reply(
      `${r.status < 400 ? "✅" : "❌"} Accepted #${acceptMatch[1]} on @${
        target.username
      }: ${JSON.stringify(r.data).slice(0, 80)}`
    );
    return;
  }

  if (/^\|fr/i.test(cmd)) {
    const r = await target.getFriendRequests();
    const requests = Array.isArray(r.data)
      ? r.data
      : (r.data?.requests || r.data?.data || []);
    if (!requests.length) {
      reply(`📭 No pending requests on @${target.username}`);
      return;
    }
    const list = requests
      .slice(0, 10)
      .map(
        (rq) =>
          `  ID:${rq.id || rq.request_id} from @${rq.username || rq.sender?.username || "?"}`
      )
      .join("\n");
    reply(`📬 Requests on @${target.username} (${requests.length}):\n${list}`);
    return;
  }

  if (/^\|balance/i.test(cmd)) {
    if (target.balance !== null) {
      reply(`💰 @${target.username}: ${target.balance} cents`);
      return;
    }
    const r = await target.api("GET", "/api/profile/me");
    const b = r.data?.balance_cents || r.data?.data?.balance_cents || "unknown";
    reply(`💰 @${target.username}: ${b} cents`);
    return;
  }

  // ── Room control ──────────────────────────────────────────
  const joinMatch = cmd.match(/^\|jr\s+(\d+)/i);
  if (joinMatch) {
    target.joinRoom(joinMatch[1]);
    reply(`✅ @${target.username} joining room ${joinMatch[1]}`);
    return;
  }

  if (/^\|lr\s+all/i.test(cmd)) {
    const count = target.leaveAll();
    reply(`✅ @${target.username} left all rooms (${count})`);
    return;
  }

  const leaveMatch = cmd.match(/^\|lr\s+(\d+)/i);
  if (leaveMatch) {
    target.leaveRoom(leaveMatch[1]);
    reply(`✅ @${target.username} left room ${leaveMatch[1]}`);
    return;
  }

  const textRoomMatch = cmd.match(/^\|tr\s+(\d+)\s+(.+)/i);
  if (textRoomMatch) {
    target.sendRoom(textRoomMatch[1], textRoomMatch[2].trim());
    reply(`✅ Sent to room ${textRoomMatch[1]} as @${target.username}`);
    return;
  }

  // ── Voucher toggle ────────────────────────────────────────
  if (/^\|vp\s+on/i.test(cmd)) {
    target.voucherOn = true;
    reply(`✅ Voucher ON for @${target.username} 🎁`);
    return;
  }
  if (/^\|vp\s+off/i.test(cmd)) {
    target.voucherOn = false;
    reply(`⛔ Voucher OFF for @${target.username}`);
    return;
  }

  // ── Auto-welcome toggle ───────────────────────────────────
  if (/^\|aw\s+on/i.test(cmd)) {
    target.awOn = true;
    reply(`✅ Auto-welcome ON for @${target.username} 👋`);
    return;
  }
  if (/^\|aw\s+off/i.test(cmd)) {
    target.awOn = false;
    reply(`⛔ Auto-welcome OFF for @${target.username}`);
    return;
  }

  // ── Auto-reply toggle ─────────────────────────────────────
  if (/^\|ar\s+on/i.test(cmd)) {
    target.autoReplyOn = true;
    reply(`✅ Auto-reply ON for @${target.username} 💬`);
    return;
  }
  if (/^\|ar\s+off/i.test(cmd)) {
    target.autoReplyOn = false;
    reply(`⛔ Auto-reply OFF for @${target.username}`);
    return;
  }

  // ── |aw_msg <new message> — change welcome template ───────
  const awMsgMatch = cmd.match(/^\|aw_msg\s+(.+)/i);
  if (awMsgMatch) {
    target.awTemplate = awMsgMatch[1].trim();
    reply(`✅ Welcome message updated for @${target.username}:\n"${target.awTemplate}"`);
    return;
  }

  // ── Parent management ─────────────────────────────────────
  const addPMatch = cmd.match(/^\|ap\s+(\w+)/i);
  if (addPMatch) {
    PARENT_USERNAMES.add(addPMatch[1].toLowerCase());
    reply(`✅ @${addPMatch[1]} added as parent`);
    return;
  }

  const remPMatch = cmd.match(/^\|rp\s+(\w+)/i);
  if (remPMatch) {
    PARENT_USERNAMES.delete(remPMatch[1].toLowerCase());
    reply(`✅ @${remPMatch[1]} removed from parents`);
    return;
  }

  // ── Status ────────────────────────────────────────────────
  if (/^\|status/i.test(cmd)) {
    const parents = [...PARENT_USERNAMES].join(", ");
    const acctStatus = [...accounts.values()].map((a) => a.statusText()).join("\n\n");
    reply(`📊 Bot Status\nParents: [${parents}]\n\n${acctStatus}`);
    return;
  }

  // ── Help ──────────────────────────────────────────────────
  if (/^\|help/i.test(cmd)) {
    reply(
      `📖 Commands:\n` +
        `\n👥 Accounts:\n` +
        `  |lnu username:pass\n` +
        `  |ltu username\n` +
        `  |accounts\n` +
        `\n👫 Friends:\n` +
        `  |sf <user>\n` +
        `  |af <req_id>\n` +
        `  |fr\n` +
        `  |balance\n` +
        `\n🏠 Rooms:\n` +
        `  |jr <id>\n` +
        `  |lr <id/all>\n` +
        `  |tr <id> <msg>\n` +
        `\n🗺️ Room List:\n` +
        `  |addroom <Name=ID> or <Name:ID>\n` +
        `  |addroom <Name1=ID1,Name2=ID2> (comma-separated)\n` +
        `  |removeroom <Name> or <Name=ID>\n` +
        `  |removeroom <Name1,Name2> (comma-separated)\n` +
        `  |listroom\n` +
        `\n🎁 Voucher:\n` +
        `  |vp on/off\n` +
        `\n👋 Auto-welcome:\n` +
        `  |aw on/off\n` +
        `  |aw_msg <text>  (use {username} as placeholder)\n` +
        `\n💬 Auto-reply:\n` +
        `  |ar on/off\n` +
        `\n⚙️ Settings:\n` +
        `  |ap <user>\n` +
        `  |rp <user>\n` +
        `  |status\n` +
        `  |help\n` +
        `\n🤖 AI:\n` +
        `  /a <your question>  (e.g., /a What is the capital of France?)\n` +
        `\n💡 Tip: Add @user after most commands to target a sub-account\n` +
        `  e.g. |vp off @firefox`
    );
    return;
  }

  reply(`❓ Unknown command. Send "|help" for the full list.`);
}

// ── Main ───────────────────────────────────────────────────────
async function main() {
  const USERNAME = process.env.MIG66_USERNAME;
  const PASSWORD = process.env.MIG66_PASSWORD;
  const TOKEN = process.env.MIG66_TOKEN;
  const ROOM_ID = Number(process.env.MIG66_ROOM_ID || "50");
  const AI = process.env.AI_PROVIDER || "mistral";

  if (!USERNAME) {
    console.error("❌ MIG66_USERNAME missing");
    process.exit(1);
  }
  if (!TOKEN && !PASSWORD) {
    console.error("❌ MIG66_TOKEN or MIG66_PASSWORD missing");
    process.exit(1);
  }
  if (AI === "mistral" && !process.env.MISTRAL_API_KEY) {
    console.error("❌ MISTRAL_API_KEY missing");
    process.exit(1);
  }

  const AW_DEFAULT = process.env.AW_MESSAGE || "Wc {username} 🎉 Welcome!";

  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("  mig66 AI Bot  ✅ Full Edition");
  console.log(`  Main user   : ${USERNAME}`);
  console.log(`  Room        : ${ROOM_ID}`);
  console.log(`  Trigger     : ${TRIGGER}`);
  console.log(`  AI          : ${AI}`);
  console.log(`  Parents     : ${[...PARENT_USERNAMES].join(", ")}`);
  console.log(`  Auto-welcome: ON — "${AW_DEFAULT}"`);
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━\n");

  const mainAccount = new BotAccount({
    username: USERNAME,
    password: PASSWORD,
    token: TOKEN || null,
    isMain: true,
  });

  const ok = await mainAccount.login();
  if (!ok) process.exit(1);
  accounts.set(USERNAME.toLowerCase(), mainAccount);
  mainAccount.connect(ROOM_ID);

  process.on("SIGINT", () => {
    console.log("\n[*] Shutting down...");
    for (const acc of accounts.values()) acc.disconnect();
    process.exit(0);
  });
}

// ── AI Reply Function (Mistral AI API) ───────────────────────
async function getAIReply(question) {
  const API_KEY = process.env.MISTRAL_API_KEY;
  const API_URL = process.env.MISTRAL_API_URL || "https://api.mistral.ai/v1/chat/completions";

  if (!API_KEY) {
    throw new Error("MISTRAL_API_KEY is missing in .env");
  }

  try {
    const response = await fetch(API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${API_KEY}`,
      },
      body: JSON.stringify({
        model: "mistral-tiny",
        messages: [
          {
            role: "user",
            content: question,
          },
        ],
        max_tokens: 150,
        temperature: 0.7,
      }),
    });

    if (!response.ok) {
      const errorData = await response.json();
      throw new Error(`Mistral API error: ${response.status} - ${JSON.stringify(errorData)}`);
    }

    const data = await response.json();
    return data.choices?.[0]?.message?.content || "Sorry, I couldn't generate a response.";
  } catch (error) {
    console.error("[Mistral AI Error]:", error.message);
    return "Sorry, I couldn't connect to the AI service.";
  }
}

function formatUptime(s) {
  const h = Math.floor(s / 3600),
    m = Math.floor((s % 3600) / 60),
    sec = Math.floor(s % 60);
  return `${h}h ${m}m ${sec}s`;
}

main().catch(console.error);