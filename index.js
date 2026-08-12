import 'dotenv/config';
import { connectDB } from './src/db.js';
import { loadAllSessions } from './src/services/clientManager.js';
import { startBot } from './src/bot/index.js';

process.on('unhandledRejection', (err) => console.error('🔥 Unhandled rejection:', err.message));
process.on('uncaughtException',  (err) => console.error('💥 Uncaught exception:',  err.message));

await connectDB();
await loadAllSessions();
startBot();

console.log('\n🚀 App running.\n');
await new Promise(() => {}); // keep process alive
