import { Quiz } from '../models/index.js';
import { AppError, notFound } from '../utils/errors.js';
import { escapeRegex } from '../utils/misc.js';
import { publishProblems } from '../validators/quiz.js';

const summary = (q) => ({
  id: String(q._id), title: q.title, description: q.description, status: q.status,
  questionCount: q.questions?.length ?? 0, createdAt: q.createdAt, updatedAt: q.updatedAt,
});
export const fullQuiz = (q) => ({
  ...summary(q),
  questions: q.questions.map((x) => ({
    id: String(x._id), text: x.text, options: x.options.map((o) => ({ key: o.key, text: o.text })),
    correctKey: x.correctKey, timeLimit: x.timeLimit, basePoints: x.basePoints, imageUrl: x.imageUrl || null,
  })),
});

// Every lookup is scoped by ownerId; a guessed id for someone else's quiz is just "not found".
export async function getOwned(ownerId, id) {
  const quiz = await Quiz.findOne({ _id: id, ownerId });
  if (!quiz) throw notFound('Quiz');
  return quiz;
}

export async function list(ownerId, { page, limit, search, status }) {
  const filter = { ownerId };
  if (status) filter.status = status;
  if (search) filter.title = { $regex: escapeRegex(search), $options: 'i' };
  const [items, total] = await Promise.all([
    Quiz.find(filter).select('-questions.options -questions.text').sort({ updatedAt: -1 }).skip((page - 1) * limit).limit(limit).lean(),
    Quiz.countDocuments(filter),
  ]);
  return { items: items.map(summary), total, page, pages: Math.max(1, Math.ceil(total / limit)) };
}

export const create = async (ownerId, data) => fullQuiz(await Quiz.create({ ...data, ownerId, status: 'draft' }));

export async function update(ownerId, id, data) {
  const quiz = await getOwned(ownerId, id);
  quiz.title = data.title;
  quiz.description = data.description;
  quiz.questions = data.questions;
  // Editing a published quiz is allowed; running games use their own snapshot.
  await quiz.save();
  return fullQuiz(quiz);
}

export async function setStatus(ownerId, id, status) {
  const quiz = await getOwned(ownerId, id);
  if (status === 'published') {
    const problems = publishProblems(quiz);
    if (problems.length) throw new AppError(422, 'QUIZ_INCOMPLETE', 'This quiz is not ready to publish', { problems });
  }
  quiz.status = status;
  await quiz.save();
  return fullQuiz(quiz);
}

export async function duplicate(ownerId, id) {
  const src = await getOwned(ownerId, id);
  const copy = await Quiz.create({
    ownerId, title: `${src.title} (copy)`.slice(0, 100), description: src.description, status: 'draft',
    questions: src.questions.map((q) => ({
      text: q.text, options: q.options.map((o) => ({ key: o.key, text: o.text })), correctKey: q.correctKey,
      timeLimit: q.timeLimit, basePoints: q.basePoints, imageUrl: q.imageUrl,
    })),
  });
  return fullQuiz(copy);
}

export async function remove(ownerId, id) {
  const r = await Quiz.deleteOne({ _id: id, ownerId });
  if (!r.deletedCount) throw notFound('Quiz');
}
