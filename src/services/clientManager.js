import { TelegramClient } from 'teleproto';
import { StringSession } from 'teleproto/sessions/index.js';
import { API_ID, API_HASH, OWNER_ID } from '../config.js';
import { User } from '../models/User.js';
import { setupMediaHandler } from './mediaService.js';

export const activeClients = new Map();
let _ownerClient = null;

export function getOwnerClient() { return _ownerClient; }
export function setOwnerClient(client) { _ownerClient = client; }

export async function startClientForUser(user) {
  if (activeClients.has(user.telegramId)) return;

  const client = new TelegramClient(
    new StringSession(user.sessionString),
    API_ID,
    API_HASH,
    { connectionRetries: 5, retryDelay: 2000, autoReconnect: true }
  );

  try {
    await client.connect();
    if (user.telegramId === OWNER_ID) setOwnerClient(client);
    activeClients.set(user.telegramId, client);
    await setupMediaHandler(client, user);
    console.log(`client started: @${user.username || user.telegramId}`);
  } catch (err) {
    console.error(`failed to start client for ${user.telegramId}:`, err.message);
  }
}

export async function stopClientForUser(telegramId) {
  const client = activeClients.get(telegramId);
  if (!client) return;
  await client.disconnect().catch(() => {});
  activeClients.delete(telegramId);
  if (telegramId === OWNER_ID) _ownerClient = null;
}

export async function loadAllSessions() {
  const users = await User.find({ status: 'active' });
  console.log(`loading ${users.length} session(s)...`);
  const sorted = [...users].sort((a) => (a.telegramId === OWNER_ID ? -1 : 1));
  for (const user of sorted) {
    await startClientForUser(user);
  }
}
