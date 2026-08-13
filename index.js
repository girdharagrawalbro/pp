import 'dotenv/config';
import http from 'http';
import { connectDB } from './src/db.js';
import { loadAllSessions } from './src/services/clientManager.js';
import { startBot } from './src/bot/index.js';

process.on('unhandledRejection', (err) => console.error('unhandled rejection:', err.message));
process.on('uncaughtException',  (err) => console.error('uncaught exception:',  err.message));

await connectDB();
await loadAllSessions();
startBot();

// Health endpoint — keeps Render Web Service alive
const PORT = process.env.PORT || 3000;
http.createServer((_, res) => res.end('ok')).listen(PORT);

console.log('app running');
