/**
 * browser.js — Puppeteer automation for web.mig66.com
 *
 * Handles:
 *  1. Launch headless Chrome
 *  2. Login with credentials
 *  3. Navigate to chatroom
 *  4. Monitor messages for trigger keyword
 *  5. Send AI-generated replies
 */

require("dotenv").config();
const puppeteer = require("puppeteer");

const BASE_URL   = "https://web.mig66.com";
const HEADLESS   = process.env.HEADLESS !== "false";   // default true
const DEBUG      = process.env.DEBUG === "true";

// CSS / XPath selectors — update these if mig66 changes its markup
// Run the bot with HEADLESS=false to inspect the live DOM
const SELECTORS = {
  // Login page
  loginUsernameInput : 'input[name="username"], input[type="text"][placeholder*="user" i], input[id*="user" i]',
  loginPasswordInput : 'input[type="password"]',
  loginSubmitButton  : 'button[type="submit"], button:has-text("Login"), button:has-text("Sign in")',

  // Chat room
  chatMessageList    : '.message-list, .chat-messages, [class*="messages"], [class*="chat-body"]',
  chatMessageItem    : '.message-item, .chat-message, [class*="message-row"], [class*="msg-item"]',
  chatMessageText    : '.message-text, .msg-text, [class*="message-content"], [class*="msg-body"]',
  chatMessageSender  : '.sender-name, .username, [class*="sender"], [class*="author"]',
  chatInput          : 'textarea[placeholder*="message" i], input[placeholder*="message" i], [contenteditable="true"]',
  chatSendButton     : 'button[aria-label*="send" i], button[type="submit"]:near(textarea), button:has-text("Send")',
};

let browser = null;
let page    = null;
const seenMessageIds = new Set();   // tracks already-replied messages

// ── Helpers ──────────────────────────────────────────────────────
function log(...args)  { console.log("[Browser]", ...args); }
function dbg(...args)  { if (DEBUG) console.log("[Debug]", ...args); }
function sleep(ms)     { return new Promise(r => setTimeout(r, ms)); }

// Try multiple selectors until one works
async function findElement(selectors, timeout = 5000) {
  const list = Array.isArray(selectors) ? selectors : selectors.split(",").map(s => s.trim());
  for (const sel of list) {
    try {
      const el = await page.waitForSelector(sel, { timeout });
      if (el) return el;
    } catch (_) { /* try next */ }
  }
  return null;
}

// ── Launch ───────────────────────────────────────────────────────
async function launch() {
  log("Launching browser...");
  browser = await puppeteer.launch({
    headless: HEADLESS ? "new" : false,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-gpu",
    ],
  });
  page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800 });

  // Intercept console errors in the page (debug only)
  page.on("console", msg => {
    if (DEBUG && msg.type() === "error") dbg("PAGE ERROR:", msg.text());
  });

  log("Browser ready.");
}

// ── Login ─────────────────────────────────────────────────────────
async function login(username, password) {
  log(`Navigating to ${BASE_URL} ...`);
  await page.goto(BASE_URL, { waitUntil: "networkidle2", timeout: 30000 });

  // Take a screenshot for debugging if headless
  if (DEBUG) await page.screenshot({ path: "debug_01_loaded.png" });

  // Wait for username input
  log("Looking for login form...");
  const usernameInput = await findElement(SELECTORS.loginUsernameInput, 10000);
  if (!usernameInput) {
    // Might already be logged in — check for chatroom presence
    const chatInput = await findElement(SELECTORS.chatInput, 3000);
    if (chatInput) { log("Already logged in."); return; }
    throw new Error("Could not find login form. Check HEADLESS=false to inspect.");
  }

  await usernameInput.click({ clickCount: 3 });
  await usernameInput.type(username, { delay: 60 });

  const passwordInput = await findElement(SELECTORS.loginPasswordInput, 5000);
  if (!passwordInput) throw new Error("Password field not found.");
  await passwordInput.click({ clickCount: 3 });
  await passwordInput.type(password, { delay: 60 });

  if (DEBUG) await page.screenshot({ path: "debug_02_filled.png" });

  const submitBtn = await findElement(SELECTORS.loginSubmitButton, 5000);
  if (submitBtn) {
    await submitBtn.click();
  } else {
    await passwordInput.press("Enter");
  }

  log("Waiting for post-login navigation...");
  await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 20000 }).catch(() => {});

  if (DEBUG) await page.screenshot({ path: "debug_03_afterlogin.png" });
  log("Login step complete.");
}

// ── Join Room ─────────────────────────────────────────────────────
async function joinRoom(roomName) {
  log(`Joining room: ${roomName}`);

  // Try direct room URL first
  const roomUrl = `${BASE_URL}/room/${roomName}`;
  await page.goto(roomUrl, { waitUntil: "networkidle2", timeout: 20000 });

  if (DEBUG) await page.screenshot({ path: "debug_04_room.png" });

  // Check if we ended up in the room
  const chatInput = await findElement(SELECTORS.chatInput, 8000);
  if (!chatInput) {
    // Try clicking a room link that contains the room name
    log("Direct URL failed, trying to find room link...");
    const roomLink = await page.$(`a[href*="${roomName}"]`);
    if (roomLink) {
      await roomLink.click();
      await page.waitForNavigation({ waitUntil: "networkidle2", timeout: 15000 }).catch(() => {});
    } else {
      throw new Error(`Room "${roomName}" not found. Set HEADLESS=false and check manually.`);
    }
  }

  log("Entered chat room.");
}

// ── Read Latest Messages ──────────────────────────────────────────
async function getRecentMessages() {
  try {
    return await page.evaluate((selectors) => {
      const container =
        document.querySelector(selectors.chatMessageList) || document.body;

      // Try common message item patterns
      const items = Array.from(
        container.querySelectorAll(
          ".message-item, .chat-message, [class*='message-row'], [class*='msg-item'], [class*='message_item']"
        )
      );

      return items.slice(-30).map((el, idx) => {
        const senderEl = el.querySelector(
          ".sender-name, .username, [class*='sender'], [class*='author'], [class*='nick']"
        );
        const textEl = el.querySelector(
          ".message-text, .msg-text, [class*='message-content'], [class*='msg-body'], [class*='text']"
        );

        const sender  = senderEl ? senderEl.innerText.trim() : "";
        const text    = textEl   ? textEl.innerText.trim()   : el.innerText.trim();
        const id      = el.getAttribute("data-id") ||
                        el.getAttribute("id")       ||
                        `auto_${idx}_${text.slice(0, 20)}`;

        return { id, sender, text };
      });
    }, SELECTORS);
  } catch (err) {
    dbg("getRecentMessages error:", err.message);
    return [];
  }
}

// ── Send Message ──────────────────────────────────────────────────
async function sendMessage(text) {
  const delaySec = parseInt(process.env.SEND_DELAY_SECONDS || "2", 10);
  await sleep(delaySec * 1000);

  const chatInput = await findElement(SELECTORS.chatInput, 5000);
  if (!chatInput) throw new Error("Chat input not found when trying to send.");

  await chatInput.click();
  await chatInput.type(text, { delay: 30 });

  // Try send button first, fall back to Enter
  const sendBtn = await findElement(SELECTORS.chatSendButton, 2000);
  if (sendBtn) {
    await sendBtn.click();
  } else {
    await chatInput.press("Enter");
  }

  log(`Sent: "${text.slice(0, 80)}${text.length > 80 ? "…" : ""}"`);
}

// ── Monitor Loop ──────────────────────────────────────────────────
async function startMonitoring(triggerKeyword, onTrigger) {
  const keyword = triggerKeyword.toLowerCase();
  log(`Monitoring for keyword: "${triggerKeyword}"`);

  const POLL_MS = 2500;   // check every 2.5 seconds

  while (true) {
    try {
      const messages = await getRecentMessages();

      for (const msg of messages) {
        // Skip already-seen messages
        if (seenMessageIds.has(msg.id)) continue;
        seenMessageIds.add(msg.id);

        // Check if message contains trigger keyword
        if (msg.text.toLowerCase().includes(keyword)) {
          log(`Triggered by [${msg.sender}]: "${msg.text}"`);

          // Strip trigger keyword from the question
          const question = msg.text
            .replace(new RegExp(triggerKeyword, "gi"), "")
            .trim();

          // Fire the callback (sends AI reply)
          await onTrigger(question, msg.sender).catch(err => {
            log("onTrigger error:", err.message);
          });
        }
      }
    } catch (err) {
      log("Monitor loop error:", err.message);
      // If page crashed, try to reload
      if (err.message.includes("Session closed") || err.message.includes("detached")) {
        log("Page detached — attempting recovery...");
        await page.reload({ waitUntil: "networkidle2" }).catch(() => {});
        await sleep(3000);
      }
    }

    await sleep(POLL_MS);
  }
}

// ── Cleanup ───────────────────────────────────────────────────────
async function close() {
  if (browser) await browser.close();
  log("Browser closed.");
}

module.exports = { launch, login, joinRoom, sendMessage, startMonitoring, close };
