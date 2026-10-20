import http from 'node:http';
import mongoose from 'mongoose';
import { env } from './config/env.js';
import { connectDb } from './config/db.js';
import { createApp } from './app.js';
import { initSockets } from './sockets/index.js';
import { startJobs } from './jobs/maintenance.js';
import { log } from './utils/logger.js';

await connectDb();
const server = http.createServer(createApp());
initSockets(server);
const stopJobs = env.enableWorker ? startJobs() : () => {};

server.listen(env.port, () => log.info(`Quizora API on :${env.port} (${env.nodeEnv}); worker ${env.enableWorker ? 'in-process' : 'disabled'}`));

async function shutdown() {
  stopJobs();
  server.close();
  await mongoose.disconnect();
  process.exit(0);
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
