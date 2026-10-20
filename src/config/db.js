import mongoose from 'mongoose';
import { env } from './env.js';

mongoose.set('strictQuery', true);

export async function connectDb(uri = env.mongoUri) {
  await mongoose.connect(uri, { serverSelectionTimeoutMS: 10000 });
  // Unique indexes are part of the security model, so build them before serving traffic.
  await Promise.all(Object.values(mongoose.models).map((m) => m.init().catch((err) => {
    console.error(`[db] index build problem on ${m.modelName}: ${err.message}`);
  })));
  return mongoose.connection;
}

export async function disconnectDb() {
  await mongoose.disconnect();
}
