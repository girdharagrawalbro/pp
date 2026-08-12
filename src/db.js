import mongoose from 'mongoose';
import { MONGO_URI } from './config.js';

export async function connectDB() {
  await mongoose.connect(MONGO_URI);
  console.log('MongoDB connected');
}
