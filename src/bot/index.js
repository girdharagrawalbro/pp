import TelegramBot from 'node-telegram-bot-api';
import { BOT_TOKEN } from '../config.js';
import { registerStartHandler }   from './handlers/start.js';
import { registerStatusHandler }  from './handlers/status.js';
import { registerStopHandler }    from './handlers/stop.js';
import { registerMessageHandler } from './handlers/message.js';

const bot = new TelegramBot(BOT_TOKEN, { polling: true });

export function startBot() {
  registerStartHandler(bot);
  registerStatusHandler(bot);
  registerStopHandler(bot);
  registerMessageHandler(bot);
  console.log('bot started');
}

export { bot };
