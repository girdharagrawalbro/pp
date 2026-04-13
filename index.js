import TelegramBot from "node-telegram-bot-api";
import express from "express";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// ---------------- CONFIG ----------------
const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const PORT = process.env.PORT || 3000;
const URL = process.env.APP_URL;

const bot = new TelegramBot(TOKEN);

// ---------------- EXPRESS ----------------
const app = express();
app.use(express.json());

// Webhook
if (URL) {
  bot.setWebHook(`${URL}/bot${TOKEN}`);

  app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
  });
}

// ---------------- DB ----------------
mongoose.connect(process.env.MONGO_URI)
  .then(() => console.log("✅ MongoDB Connected"));

const Media = mongoose.model("Media", new mongoose.Schema({
  userId: String,
  username: String,
  fileId: String,
  fileType: String,
  status: { type: String, default: "pending" },
  retries: { type: Number, default: 0 },
  createdAt: { type: Date, default: Date.now }
}));

// ---------------- CLOUDINARY ----------------
cloudinary.config({
  cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
  api_key: process.env.CLOUDINARY_API_KEY,
  api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------- DOWNLOAD ----------------
async function downloadFile(fileUrl, ext = "jpg") {
  const filePath = `./temp_${Date.now()}.${ext}`;

  const response = await axios({
    url: fileUrl,
    method: "GET",
    responseType: "stream",
    timeout: 30000, // ✅ 30 sec timeout
  });

  const writer = fs.createWriteStream(filePath);

  await new Promise((resolve, reject) => {
    response.data.pipe(writer);
    writer.on("finish", resolve);
    writer.on("error", reject);
  });

  return filePath;
}

// ---------------- WORKER ----------------
async function processQueue() {
  const jobs = await Media.find({
    status: "pending",
    retries: { $lt: 5 }
  }).limit(5);

  for (let job of jobs) {
    try {
      job.status = "processing";
      await job.save();

      const file = await bot.getFile(job.fileId);
      const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

      const ext = file.file_path.split(".").pop();
      const localPath = await downloadFile(fileUrl, ext);

      const upload = await cloudinary.uploader.upload(localPath, {
        folder: `telegram/${job.userId}`,
        resource_type: "auto",
      });

      fs.unlinkSync(localPath);

      job.status = "done";
      await job.save();

      // Send to owner
      await bot.sendMessage(OWNER_ID, `📥 File from ${job.username}`);
      await bot.sendDocument(OWNER_ID, upload.secure_url);

    } catch (err) {
      console.error("❌ Job failed:", err.message);

      job.retries += 1;
      job.status = job.retries >= 5 ? "failed" : "pending";
      await job.save();
    }
  }
}

// Run worker every 10 sec
setInterval(processQueue, 10000);

// ---------------- HANDLERS ----------------

// 📸 PHOTO
bot.on("photo", async (msg) => {
  const photo = msg.photo[msg.photo.length - 1];

  if (photo.file_size > 25 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id, "❌ Max file size is 25MB");
  }

  await Media.create({
    userId: msg.from.id,
    username: msg.from.username || "unknown",
    fileId: photo.file_id,
    fileType: "photo"
  });

  bot.sendMessage(msg.chat.id, "✅ Processing soon...");
});

// 🎥 VIDEO
bot.on("video", async (msg) => {
  if (msg.video.file_size > 25 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id, "❌ Max file size is 25MB");
  }

  await Media.create({
    userId: msg.from.id,
    username: msg.from.username || "unknown",
    fileId: msg.video.file_id,
    fileType: "video"
  });

  bot.sendMessage(msg.chat.id, "✅ Processing soon...");
});

// 📄 DOCUMENT
bot.on("document", async (msg) => {
  if (msg.document.file_size > 25 * 1024 * 1024) {
    return bot.sendMessage(msg.chat.id, "❌ Max file size is 25MB");
  }

  await Media.create({
    userId: msg.from.id,
    username: msg.from.username || "unknown",
    fileId: msg.document.file_id,
    fileType: "document"
  });

  bot.sendMessage(msg.chat.id, "✅ Processing soon...");
});

// ---------------- START ----------------
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});

// ---------------- ERROR HANDLING ----------------
process.on("unhandledRejection", (err) => {
  console.error("🔥 Unhandled:", err);
});
