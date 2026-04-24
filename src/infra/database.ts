import mongoose from 'mongoose';
import { getConfig } from '../config/env.js';
import { logger } from '../common/logger.js';

export async function connectMongo(): Promise<void> {
  const uri = getConfig().MONGO_URI;
  await mongoose.connect(uri);
  logger.info('MongoDB connected');
}

export async function disconnectMongo(): Promise<void> {
  await mongoose.disconnect();
}
