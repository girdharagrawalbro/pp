const required = ['API_ID', 'API_HASH', 'BOT_TOKEN', 'MONGO_URI', 'OWNER_ID'];

for (const key of required) {
  if (!process.env[key]) {
    console.error(`Missing env var: ${key}`);
    process.exit(1);
  }
}

export const API_ID    = Number(process.env.API_ID);
export const API_HASH  = process.env.API_HASH;
export const BOT_TOKEN = process.env.BOT_TOKEN;
export const MONGO_URI = process.env.MONGO_URI;
export const OWNER_ID  = String(process.env.OWNER_ID);
