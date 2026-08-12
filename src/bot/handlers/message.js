import { resolveAuthStep } from '../../services/authService.js';

export function registerMessageHandler(bot) {
  bot.on('message', (msg) => {
    if (!msg.text || msg.text.startsWith('/')) return;
    resolveAuthStep(String(msg.chat.id), msg.text.trim());
  });
}
