import { startAuthFlow } from '../../services/authService.js';

export function registerStartHandler(bot) {
  bot.onText(/\/start/, async (msg) => {
    const chatId = String(msg.chat.id);

    await bot.sendMessage(
      chatId,
      `Hi ${msg.from.first_name || 'there'}!\n\n` +
      `To connect your account, you need your own Telegram API credentials.\n\n` +
      `1. Go to https://my.telegram.org/apps\n` +
      `2. Log in with your phone number\n` +
      `3. Create a new app (any name)\n` +
      `4. Copy your App api_id and api_hash\n\n` +
      `Send your api_id (numbers only):`
    );

    await startAuthFlow(bot, chatId, {
      username:  msg.from.username,
      firstName: msg.from.first_name,
    });
  });
}
