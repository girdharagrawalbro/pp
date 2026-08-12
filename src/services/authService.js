import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { API_ID, API_HASH, OWNER_ID } from '../config.js';
import { User } from '../models/User.js';
import { activeClients, setOwnerClient } from './clientManager.js';
import { setupMediaHandler } from './mediaService.js';

const pendingAuth = new Map();

export function getPendingAuth(telegramId) {
  return pendingAuth.get(telegramId);
}

export async function startAuthFlow(bot, chatId, userInfo) {
  const existing = activeClients.get(chatId);
  if (existing) {
    await existing.disconnect().catch(() => {});
    activeClients.delete(chatId);
  }
  pendingAuth.delete(chatId);

  await User.findOneAndUpdate(
    { telegramId: chatId },
    { telegramId: chatId, username: userInfo.username, firstName: userInfo.firstName, status: 'pending' },
    { upsert: true }
  );

  let resolvePhone, resolveCode, resolvePassword;
  const phonePromise    = new Promise(r => (resolvePhone = r));
  const codePromise     = new Promise(r => (resolveCode = r));
  const passwordPromise = new Promise(r => (resolvePassword = r));

  const client = new TelegramClient(new StringSession(''), API_ID, API_HASH, {
    connectionRetries: 5,
    retryDelay: 1000,
  });

  pendingAuth.set(chatId, { step: 'phone', resolvePhone, resolveCode, resolvePassword, client });

  client
    .start({
      phoneNumber: () => phonePromise,
      phoneCode: async () => {
        await bot.sendMessage(chatId, 'OTP sent to your Telegram app. Send it here:');
        const p = pendingAuth.get(chatId);
        if (p) p.step = 'code';
        return codePromise;
      },
      password: async () => {
        await bot.sendMessage(chatId, '2FA is enabled. Send your password:');
        const p = pendingAuth.get(chatId);
        if (p) p.step = 'password';
        return passwordPromise;
      },
      onError: async (err) => {
        const floodMatch = err.message?.match(/FLOOD_WAIT_(\d+)/);
        if (floodMatch) {
          const seconds = Number(floodMatch[1]);
          const minutes = Math.ceil(seconds / 60);
          await bot.sendMessage(chatId,
            `Telegram is rate limiting login requests. Please wait ${minutes} minute(s) and send /start again.`
          ).catch(() => {});
        } else {
          console.error('auth error:', err.message);
          bot.sendMessage(chatId, `Login error: ${err.message}\n\nSend /start to try again.`).catch(() => {});
        }
        pendingAuth.delete(chatId);
        await User.findOneAndUpdate({ telegramId: chatId }, { status: 'inactive' });
      },
    })
    .then(async () => {
      const sessionString = client.session.save();
      const user = await User.findOneAndUpdate(
        { telegramId: chatId },
        { sessionString, status: 'active' },
        { new: true }
      );

      pendingAuth.delete(chatId);

      if (chatId === OWNER_ID) setOwnerClient(client);
      activeClients.set(chatId, client);
      await setupMediaHandler(client, user);

      await bot.sendMessage(
        chatId,
        'Connected. Monitoring all your chats now.\n\n/status - check status\n/stop - disable'
      );
      console.log(`registered: @${user?.username || chatId}`);
    })
    .catch(async (err) => {
      console.error('login failed:', err.message);
      pendingAuth.delete(chatId);
      await User.findOneAndUpdate({ telegramId: chatId }, { status: 'inactive' });
      bot.sendMessage(chatId, `Login failed: ${err.message}\n\nSend /start to try again.`).catch(() => {});
    });
}

export function resolveAuthStep(chatId, text) {
  const pending = pendingAuth.get(chatId);
  if (!pending) return;
  const { step } = pending;
  if (step === 'phone')    pending.resolvePhone(text);
  else if (step === 'code')     pending.resolveCode(text);
  else if (step === 'password') pending.resolvePassword(text);
}
