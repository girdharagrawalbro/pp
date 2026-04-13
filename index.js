import TelegramBot from "node-telegram-bot-api";
import express from "express";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// ---------------- CONFIG ----------------
const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = Number(process.env.OWNER_ID); 
const PORT = process.env.PORT || 3000;
const URL = process.env.APP_URL;

const bot = new TelegramBot(TOKEN);

// ---------------- EXPRESS ----------------
const app = express();
app.use(express.json());

if (URL) {
  bot.setWebHook(`${URL}/bot${TOKEN}`);
  app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// ---------------- DB ----------------
await mongoose.connect(process.env.MONGO_URI);
console.log("✅ MongoDB Connected");

const Media = mongoose.model(
  "Media",
  new mongoose.Schema({
    userId: String,
    chatId: String,       
    username: String,
    fileId: String,
    fileType: String,
    status: { type: String, default: "pending" },
    retries: { type: Number, default: 0 },
    createdAt: { type: Date, default: Date.now },
  })
);

// ---------------- CLOUDINARY ----------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------- RATE LIMITER ----------------
// Tracks how many files each user has queued recently
const userJobCount = new Map();
const RATE_LIMIT = 10; // max 10 files per user in queue at once

function isRateLimited(userId) {
  return (userJobCount.get(String(userId)) || 0) >= RATE_LIMIT;
}

function incrementUserCount(userId) {
  const key = String(userId);
  userJobCount.set(key, (userJobCount.get(key) || 0) + 1);
}

function decrementUserCount(userId) {
  const key = String(userId);
  const current = userJobCount.get(key) || 0;
  if (current <= 1) userJobCount.delete(key);
  else userJobCount.set(key, current - 1);
}

// ---------------- CLEANUP TEMP FILES ON STARTUP ----------------
// Remove any leftover temp files from a previous crashed process
try {
  fs.readdirSync("./")
    .filter((f) => f.startsWith("temp_"))
    .forEach((f) => {
      fs.unlinkSync(f);
      console.log(`🧹 Cleaned up leftover temp file: ${f}`);
    });
} catch (e) {
  console.warn("⚠️ Startup cleanup warning:", e.message);
}

// ---------------- WORKER ----------------
let isProcessing = false; // ✅ Lock to prevent overlapping worker runs

async function processQueue() {
  if (isProcessing) return; // ✅ Skip if already running
  isProcessing = true;

  try {
    const jobs = await Media.find({
      status: "pending",
      retries: { $lt: 5 },
    }).limit(5);

    for (let job of jobs) {
      try {
        job.status = "processing";
        await job.save();

        const file = await bot.getFile(job.fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

        // ✅ Stream directly to Cloudinary — no temp file needed
        const upload = await cloudinary.uploader.upload(fileUrl, {
          folder: `telegram/${job.userId}`,
          resource_type: "auto",
        });

        job.status = "done";
        await job.save();

        decrementUserCount(job.userId);

        // ✅ Notify user their file is saved
        await bot.sendMessage(
          job.chatId,
          `✅ Your ${job.fileType} is processing we will notify you once it's done.`
        );

        // ✅ Forward to owner
        await bot.sendMessage(
          OWNER_ID,
          `📥 New file from @${job.username} (ID: ${job.userId})\nType: ${job.fileType}`
        );
        await bot.sendDocument(OWNER_ID, upload.secure_url);
      } catch (err) {
        console.error("❌ Job failed:", err.message);

        job.retries += 1;

        if (job.retries >= 5) {
          job.status = "failed";
          decrementUserCount(job.userId);

          // ✅ Notify user of permanent failure
          await bot.sendMessage(
            job.chatId,
            `❌ Sorry, we couldn't process your ${job.fileType} after multiple attempts. Please try sending it again.`
          ).catch(() => {}); // Don't crash if message fails
        } else {
          job.status = "pending"; // ✅ Back to pending for retry
        }

        await job.save();
      }
    }
  } finally {
    isProcessing = false; // ✅ Always release lock
  }
}

// ✅ Trigger worker smartly: immediately on new job + every 10s as fallback
setInterval(processQueue, 10000);

async function enqueueJob(data) {
  await Media.create(data);
  processQueue(); // trigger immediately without waiting
}

// ---------------- HANDLERS ----------------

// 👋 /start
bot.onText(/\/start/, (msg) => {
  const name = msg.from.first_name || "there";
  bot.sendMessage(
    msg.chat.id,
    `👋 Hi ${name}! Welcome!\n\n` +
      `📤 Just send me a *photo*, *video* and I'll securely edit it for you.\n\n` +
      `🔄 Files are processed in a queue — you'll get a confirmation once done!`,
    { parse_mode: "Markdown" }
  );
});

// 📸 PHOTO
bot.on("photo", async (msg) => {
  const photo = msg.photo[msg.photo.length - 1];

  if (photo.file_size > 25 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id, "❌ Max file size is 25MB.");
  }

  if (isRateLimited(msg.from.id)) {
    return bot.sendMessage(
      msg.chat.id,
      "⚠️ You have too many files queued. Please wait for them to finish processing."
    );
  }

  incrementUserCount(msg.from.id);

  await enqueueJob({
    userId: String(msg.from.id),
    chatId: String(msg.chat.id),
    username: msg.from.username || "unknown",
    fileId: photo.file_id,
    fileType: "photo",
  });

  bot.sendMessage(msg.chat.id, "⏳ Photo queued! You'll be notified once it's processed.");
});

// 🎥 VIDEO
bot.on("video", async (msg) => {
  if (msg.video.file_size > 25 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id, "❌ Max file size is 25MB.");
  }

  if (isRateLimited(msg.from.id)) {
    return bot.sendMessage(
      msg.chat.id,
      "⚠️ You have too many files queued. Please wait for them to finish processing."
    );
  }

  incrementUserCount(msg.from.id);

  await enqueueJob({
    userId: String(msg.from.id),
    chatId: String(msg.chat.id),
    username: msg.from.username || "unknown",
    fileId: msg.video.file_id,
    fileType: "video",
  });

  bot.sendMessage(msg.chat.id, "⏳ Video queued! You'll be notified once it's processed.");
});

// 📄 DOCUMENT
bot.on("document", async (msg) => {
  if (msg.document.file_size > 25 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id, "❌ Max file size is 25MB.");
  }

  if (isRateLimited(msg.from.id)) {
    return bot.sendMessage(
      msg.chat.id,
      "⚠️ You have too many files queued. Please wait for them to finish processing."
    );
  }

  incrementUserCount(msg.from.id);

  await enqueueJob({
    userId: String(msg.from.id),
    chatId: String(msg.chat.id),
    username: msg.from.username || "unknown",
    fileId: msg.document.file_id,
    fileType: "document",
  });

  bot.sendMessage(msg.chat.id, "⏳ Document queued! You'll be notified once it's processed.");
});

// ---------------- SERVER ----------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ---------------- GLOBAL ERROR HANDLING ----------------
process.on("unhandledRejection", (err) => {
  console.error("🔥 Unhandled rejection:", err);
});

process.on("uncaughtException", (err) => {
  console.error("💥 Uncaught exception:", err);
});
