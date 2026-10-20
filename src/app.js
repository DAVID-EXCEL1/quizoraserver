import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import { env } from './config/env.js';
import { apiLimiter } from './middleware/rateLimit.js';
import { originCheck } from './middleware/security.js';
import { errorHandler, notFoundHandler } from './middleware/errorHandler.js';
import authRoutes from './routes/auth.js';
import quizRoutes from './routes/quizzes.js';
import roomRoutes from './routes/rooms.js';
import gameRoutes from './routes/games.js';
import dashboardRoutes from './routes/dashboard.js';
import uploadRoutes from './routes/uploads.js';

export function createApp() {
  const app = express();
  app.set('trust proxy', env.trustProxy);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use(cors({
    origin: (origin, cb) => cb(null, !origin || env.allowedOrigins.includes(origin.replace(/\/+$/, ''))),
    credentials: true,
    allowedHeaders: ['Content-Type', 'X-CSRF-Token', 'X-Player-Token', 'Authorization'],
  }));
  app.use(express.json({ limit: '100kb' }));
  app.use(cookieParser());

  app.get('/api/health', (req, res) => res.json({ data: { ok: true } }));
  app.use('/api', apiLimiter, originCheck);
  app.use('/api/auth', authRoutes);
  app.use('/api/quizzes', quizRoutes);
  app.use('/api/rooms', roomRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/uploads', uploadRoutes);
  app.use('/api', gameRoutes); // /games, /games/:id, /results/:code

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
