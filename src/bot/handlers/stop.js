import { User } from '../../models/User.js';
import { stopClientForUser } from '../../services/clientManager.js';

export function registerStopHandler(bot) {
  bot.onText(/\/stop/, async (msg) => {
    const chatId = String(msg.chat.id);
    await stopClientForUser(chatId);
    await User.findOneAndUpdate({ telegramId: chatId }, { status: 'stopped' });
    bot.sendMessage(chatId, 'Monitoring stopped. Send /start to re-enable.');
  });
}
