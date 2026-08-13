import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { OWNER_ID } from '../config.js';
import { User } from '../models/User.js';
import { activeClients, setOwnerClient } from './clientManager.js';
import { setupMediaHandler } from './mediaService.js';

// telegramId -> { step, client, apiId, apiHash, resolveApiId, resolveApiHash, resolvePhone, resolveCode, resolvePassword }
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

  let resolveApiId, resolveApiHash, resolvePhone, resolveCode, resolvePassword;
  const apiIdPromise    = new Promise(r => (resolveApiId = r));
  const apiHashPromise  = new Promise(r => (resolveApiHash = r));
  const phonePromise    = new Promise(r => (resolvePhone = r));
  const codePromise     = new Promise(r => (resolveCode = r));
  const passwordPromise = new Promise(r => (resolvePassword = r));

  apiIdPromise.then(() => {
    bot.sendMessage(chatId, 'Now send your api_hash:');
  });

  pendingAuth.set(chatId, {
    step: 'api_id',
    resolveApiId, resolveApiHash, resolvePhone, resolveCode, resolvePassword,
    apiId: null, apiHash: null, client: null,
  });

  // Once we have api_id and api_hash, spin up the client and start login
  Promise.all([apiIdPromise, apiHashPromise]).then(async ([apiId, apiHash]) => {
    const p = pendingAuth.get(chatId);
    if (!p) return;

    p.apiId   = apiId;
    p.apiHash = apiHash;

    const client = new TelegramClient(new StringSession(''), apiId, apiHash, {
      connectionRetries: 5,
      retryDelay: 1000,
    });
    p.client = client;

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
            const minutes = Math.ceil(Number(floodMatch[1]) / 60);
            await bot.sendMessage(chatId,
              `Telegram is rate limiting this. Wait ${minutes} minute(s) then send /start again.`
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
        const p = pendingAuth.get(chatId);
        const user = await User.findOneAndUpdate(
          { telegramId: chatId },
          { sessionString, apiId: p?.apiId, apiHash: p?.apiHash, status: 'active' },
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

    // Ask for phone number now that client is ready
    await bot.sendMessage(chatId, 'Now send your phone number with country code:\ne.g. +919876543210');
    p.step = 'phone';
  });
}

export function resolveAuthStep(chatId, text) {
  const pending = pendingAuth.get(chatId);
  if (!pending) return;

  const { step } = pending;

  if (step === 'api_id') {
    const id = Number(text);
    if (!id || isNaN(id)) return; // ignore invalid input, wait for correct one
    pending.step = 'api_hash';
    pending.resolveApiId(id);
  } else if (step === 'api_hash') {
    if (text.length < 10) return; // basic sanity check
    pending.resolveApiHash(text);
    // step will be set to 'phone' after Promise.all resolves above
  } else if (step === 'phone') {
    pending.resolvePhone(text);
  } else if (step === 'code') {
    pending.resolveCode(text);
  } else if (step === 'password') {
    pending.resolvePassword(text);
  }
}
