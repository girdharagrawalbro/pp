import { User } from '../../models/User.js';
import { activeClients } from '../../services/clientManager.js';

export function registerStatusHandler(bot) {
  bot.onText(/\/status/, async (msg) => {
    const chatId = String(msg.chat.id);
    const user = await User.findOne({ telegramId: chatId });
    if (!user) return bot.sendMessage(chatId, 'Not registered. Send /start to begin.');

    const running = activeClients.has(chatId);
    bot.sendMessage(chatId, running
      ? 'Active - monitoring all your chats.'
      : `Inactive (${user.status}). Send /start to reconnect.`
    );
  });
}
