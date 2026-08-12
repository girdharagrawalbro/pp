import { TelegramClient } from "teleproto";
import { StringSession } from "teleproto/sessions/index.js";
import { NewMessage } from "teleproto/events/index.js";
import input from "input";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

dotenv.config();

// ---------------- CONFIG ----------------
const API_ID   = Number(process.env.API_ID);
const API_HASH = process.env.API_HASH;
let   SESSION  = process.env.SESSION_STRING || "";

if (!API_ID || !API_HASH) {
  console.error(
    "❌ Missing API_ID or API_HASH in .env\n" +
    "   Get them from https://my.telegram.org/apps"
  );
  process.exit(1);
}

// ---------------- SESSION PERSISTENCE ----------------
// Writes SESSION_STRING back into .env so next run is automatic
function persistSession(sessionString) {
  const envPath = path.resolve(".env");
  let content = "";
  try {
    content = fs.readFileSync(envPath, "utf8");
  } catch {
    // .env doesn't exist yet — create from scratch
  }

  if (content.includes("SESSION_STRING=")) {
    content = content.replace(
      /SESSION_STRING=.*/,
      `SESSION_STRING=${sessionString}`
    );
  } else {
    content += `\nSESSION_STRING=${sessionString}`;
  }

  fs.writeFileSync(envPath, content, "utf8");
  console.log("💾 Session saved to .env — future runs won't need OTP.");
}

// ---------------- CLIENT SETUP ----------------
const client = new TelegramClient(
  new StringSession(SESSION),
  API_ID,
  API_HASH,
  {
    connectionRetries: 10,
    retryDelay: 2000,
    autoReconnect: true,
  }
);

// ---------------- HELPERS ----------------
function isViewOnce(media) {
  if (!media) return false;
  // Telegram marks view-once with ttlSeconds > 0
  return (
    media.ttlSeconds != null &&
    media.ttlSeconds > 0
  );
}

function formatCaption(sender, chatTitle, date) {
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
    `🕐 *Time:* ${time}`
  );
}

// ---------------- MAIN ----------------
async function main() {
  console.log("🔗 Connecting to Telegram...");

  await client.start({
    phoneNumber: async () =>
      input.text("📱 Enter your phone number (with country code, e.g. +91...): "),
    password: async () =>
      input.text("🔑 Enter your 2FA password (press Enter if none): "),
    phoneCode: async () =>
      input.text("📩 Enter the OTP sent to your Telegram app: "),
    onError: (err) => {
      console.error("❌ Login error:", err.message);
    },
  });

  const me = await client.getMe();
  console.log(`\n✅ Logged in as: ${me.firstName} (@${me.username})`);

  // Save session after successful login
  const sessionString = client.session.save();
  if (sessionString !== SESSION) {
    persistSession(sessionString);
    SESSION = sessionString;
  }

  console.log("\n👁️  Monitoring ALL chats for view-once media...");
  console.log("   Press Ctrl+C to stop.\n");

  // ---------------- EVENT HANDLER ----------------
  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg || !msg.media) return;
    if (!isViewOnce(msg.media)) return;

    try {
      // Determine chat title and sender name
      const chat   = await msg.getChat();
      const sender = await msg.getSender();
      const chatTitle =
        chat?.title ||
        [chat?.firstName, chat?.lastName].filter(Boolean).join(" ") ||
        "Unknown";

      const fileType = msg.media.photo ? "📸 Photo" : "🎬 Video";
      console.log(`\n🔔 View-once ${fileType} detected!`);
      console.log(`   Chat: ${chatTitle}`);
      console.log(`   From: ${sender?.username || sender?.firstName || "Unknown"}`);
      console.log("   Downloading...");

      // Download media bytes into memory (no temp file needed)
      const buffer = await client.downloadMedia(msg.media, {
        workers: 4,
      });

      if (!buffer || buffer.length === 0) {
        console.warn("   ⚠️  Downloaded buffer is empty — skipping.");
        return;
      }

      const ext      = msg.media.photo ? "jpg" : "mp4";
      const fileName = `view_once_${Date.now()}.${ext}`;
      const caption  = formatCaption(sender, chatTitle, msg.date);

      // Upload to Saved Messages ("me")
      await client.sendFile("me", {
        file: Buffer.from(buffer),
        caption,
        parseMode: "markdown",
        attributes: msg.media.document?.attributes || [],
        forceDocument: false,
      });

      console.log(`   ✅ Saved to Saved Messages: ${fileName}`);
    } catch (err) {
      console.error("   ❌ Failed to process view-once:", err.message);
    }
  }, new NewMessage({}));

  // Keep the process alive
  await client.run();
}

// ---------------- GLOBAL ERROR HANDLING ----------------
process.on("unhandledRejection", (err) => {
  console.error("🔥 Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception:", err);
});

main();
