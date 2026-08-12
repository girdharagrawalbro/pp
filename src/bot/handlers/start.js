import { startAuthFlow } from '../../services/authService.js';

export function registerStartHandler(bot) {
  bot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);
    await bot.sendMessage(
      chatId,
      `Hi ${msg.from.first_name || 'there'}!\n\nSend me your phone number with country code to connect your account:\ne.g. +919876543210`
    );
    await startAuthFlow(bot, chatId, {
      username:  msg.from.username,
      firstName: msg.from.first_name,
    });
  });
}
