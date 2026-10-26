import QRCode from 'qrcode';
import { Quiz, Room } from '../models/index.js';
import { env } from '../config/env.js';
import { AppError, notFound } from '../utils/errors.js';
import { generatePin } from '../utils/tokens.js';
import { publishProblems } from '../validators/quiz.js';
import { emailConfigured } from './mailer.js';
import { entitlementsFor } from './entitlements.js';
import { getSettings } from './settings.js';

export const joinUrl = (code) => `${env.clientUrl}/join/${code}`;
export const hostUrl = (code) => `${env.clientUrl}/host/${code}`;
export const qrFor = (code) => QRCode.toDataURL(joinUrl(code), { margin: 1, width: 320, errorCorrectionLevel: 'M' });

export async function createRoom(user, { quizId, showQuestionsToPlayers = true, chatEnabled = true, locationOptions = [] }) {
  if (emailConfigured() && !user.emailVerified) {
    throw new AppError(403, 'EMAIL_NOT_VERIFIED', 'Verify your email address before hosting a game');
  }
  const quiz = await Quiz.findOne({ _id: quizId, ownerId: user._id }); // ownership enforced here
  if (!quiz) throw notFound('Quiz');
  if (quiz.status !== 'published') throw new AppError(422, 'QUIZ_NOT_PUBLISHED', 'Publish this quiz before hosting it');
  const problems = publishProblems(quiz);
  if (problems.length) throw new AppError(422, 'QUIZ_INCOMPLETE', 'This quiz is not ready to host', { problems });

  const snapshot = {
    title: quiz.title,
    description: quiz.description,
    questions: quiz.questions.map((q) => ({
      qid: String(q._id), text: q.text, options: q.options.map((o) => ({ key: o.key, text: o.text })),
      correctKey: q.correctKey, timeLimit: q.timeLimit, basePoints: q.basePoints, imageUrl: q.imageUrl || null,
    })),
  };
  const ent = await entitlementsFor(user._id);
  const settings = await getSettings();
  const chatOn = ent.features.chat;
  const now = Date.now();
  for (let attempt = 0; attempt < 12; attempt++) {
    try {
      return await Room.create({
        code: generatePin(), hostId: user._id, quizId: quiz._id, snapshot, status: 'LOBBY',
        maxPlayers: ent.limits.maxPlayersPerGame, features: { chat: chatOn, stickers: ent.features.stickers },
        chatMode: chatOn && chatEnabled ? (settings.chat.defaultMode === 'off' ? 'between' : settings.chat.defaultMode) : 'off',
        showQuestionsToPlayers, locationOptions,
        lastActivityAt: new Date(now), expiresAt: new Date(now + env.roomInactivityMs),
      });
    } catch (err) {
      if (err.code !== 11000) throw err; // PIN collision: try another
    }
  }
  throw new AppError(503, 'PIN_EXHAUSTED', 'Could not allocate a game PIN. Please try again.');
}

/** Host-scoped lookup: another host's room is indistinguishable from a missing one. */
export async function getOwnedRoom(code, hostId) {
  const room = await Room.findOne({ code, hostId });
  if (!room) throw notFound('Game');
  return room;
}
