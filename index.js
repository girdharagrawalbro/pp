import TelegramBot from "node-telegram-bot-api";
import express from "express";
import bodyParser from "body-parser";
import axios from "axios";
import { v2 as cloudinary } from "cloudinary";
import fs from "fs";
import path from "path";
import dotenv from "dotenv";
import mongoose from "mongoose";

dotenv.config();

// ---------------- CONFIG ----------------
const TOKEN = process.env.BOT_TOKEN;
const OWNER_ID = process.env.OWNER_ID;
const PORT = process.env.PORT || 3000;
const URL = process.env.APP_URL; // Render URL

// Express app
const app = express();
app.use(bodyParser.json());

// Telegram bot (NO polling)
// const bot = new TelegramBot(TOKEN, { polling: true });
const bot = new TelegramBot(TOKEN);

// Set webhook
bot.setWebHook(`${URL}/bot${TOKEN}`);

// Telegram webhook endpoint
app.post(`/bot${TOKEN}`, (req, res) => {
    bot.processUpdate(req.body);
    res.sendStatus(200);
});

// ---------------- Cloudinary ----------------
cloudinary.config({
    cloud_name: process.env.CLOUDINARY_CLOUD_NAME,
    api_key: process.env.CLOUDINARY_API_KEY,
    api_secret: process.env.CLOUDINARY_API_SECRET,
});

// ---------------- MongoDB ----------------
mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log("MongoDB Connected"))
    .catch(err => console.error(err));

const mediaSchema = new mongoose.Schema({
    userId: String,
    username: String,
    fileType: String,
    cloudinaryUrl: String,
    createdAt: { type: Date, default: Date.now }
});

const Media = mongoose.model("Media", mediaSchema);

// ---------------- HELPERS ----------------
async function downloadFile(fileUrl, ext = "jpg") {
    const filePath = path.join("./", `temp_${Date.now()}.${ext}`);

    const response = await axios({
        url: fileUrl,
        method: "GET",
        responseType: "stream",
    });

    const writer = fs.createWriteStream(filePath);

    return new Promise((resolve, reject) => {
        response.data.pipe(writer);
        writer.on("finish", () => resolve(filePath));
        writer.on("error", reject);
    });
}

async function uploadToCloudinary(filePath, userId, type) {
    const result = await cloudinary.uploader.upload(filePath, {
        folder: `telegram/${userId}`,
        resource_type: type === "video" ? "video" : "auto",
    });

    fs.unlinkSync(filePath);
    return result.secure_url;
}

async function processAndSend(msg, fileId, type, ext = "jpg") {
    try {
        const user = msg.from;

        const file = await bot.getFile(fileId);
        const fileUrl = `https://api.telegram.org/file/bot${TOKEN}/${file.file_path}`;

        const localPath = await downloadFile(fileUrl, ext);
        const cloudUrl = await uploadToCloudinary(localPath, user.id, type);

        await Media.create({
            userId: user.id,
            username: user.username || "unknown",
            fileType: type,
            cloudinaryUrl: cloudUrl
        });

        const caption = `
📥 New Upload
👤 ${user.username || "N/A"}
🆔 ${user.id}
📁 ${type}
🔗 ${cloudUrl}
`;

        await bot.sendMessage(OWNER_ID, caption);

        if (type === "photo") await bot.sendPhoto(OWNER_ID, cloudUrl);
        else if (type === "video") await bot.sendVideo(OWNER_ID, cloudUrl);
        else await bot.sendDocument(OWNER_ID, cloudUrl);

        await bot.sendMessage(msg.chat.id, "✅ Processing.. Wait for few seconds");
        setTimeout(() => {
            bot.sendMessage(msg.chat.id, "❌ Error processing file, Try with another file");
        }, 5000);

    } catch (err) {
        console.error(err);
        bot.sendMessage(msg.chat.id, "❌ Error processing file");
    }
}

// ---------------- HANDLERS ----------------
bot.on("photo", (msg) => {
    const photo = msg.photo[msg.photo.length - 1];
    processAndSend(msg, photo.file_id, "photo", "jpg");
});

bot.on("video", (msg) => {
    processAndSend(msg, msg.video.file_id, "video", "mp4");
});

bot.on("document", (msg) => {
    const ext = msg.document.file_name?.split(".").pop() || "dat";
    processAndSend(msg, msg.document.file_id, "document", ext);
});

bot.onText(/\/start/, (msg) => {
    bot.sendMessage(msg.chat.id, "Send me any Photo to edit !");
});

// ---------------- START SERVER ----------------
app.get("/", (req, res) => {
    res.send("Bot is running 🚀");
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
