import mongoose from 'mongoose';

const schema = new mongoose.Schema({
  telegramId:    { type: String, unique: true },
  username:      String,
  firstName:     String,
  phone:         String,
  sessionString: String,
  status:        { type: String, default: 'inactive' },
  registeredAt:  { type: Date, default: Date.now },
});

export const User = mongoose.model('User', schema);
