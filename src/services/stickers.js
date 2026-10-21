import { Sticker } from '../models/index.js';
import { AppError } from '../utils/errors.js';

const PACKS = {
  Animals: ['🦊 Fox', '🐼 Panda', '🦁 Lion', '🐯 Tiger', '🐸 Frog', '🐙 Octopus', '🦄 Unicorn', '🐧 Penguin', '🦉 Owl', '🐢 Turtle', '🦈 Shark', '🐨 Koala'],
  Faces: ['😎 Cool', '🤓 Nerd', '🥳 Party', '😈 Mischief', '🤠 Cowboy', '🤩 Starstruck', '😴 Sleepy', '🤯 Mind blown', '🥶 Frozen', '🤖 Robot'],
  Space: ['🚀 Rocket', '🌟 Star', '🪐 Planet', '👽 Alien', '☄️ Comet', '🌙 Moon', '🛸 UFO', '🌍 Earth'],
  Sports: ['⚽ Football', '🏀 Basketball', '🏆 Trophy', '🎯 Bullseye', '🏎️ Racer', '🥇 Gold', '🎮 Gamer', '🎸 Rock'],
};

export async function seedStickers() {
  if (await Sticker.countDocuments({}) > 0) return 0;
  let order = 0; const docs = [];
  for (const [pack, items] of Object.entries(PACKS)) for (const it of items) { const [emoji, ...rest] = it.split(' '); docs.push({ emoji, label: rest.join(' '), pack, order: order++ }); }
  await Sticker.insertMany(docs);
  return docs.length;
}

export const listActive = () => Sticker.find({ active: true }).sort({ order: 1, createdAt: 1 }).lean();

export async function groupedActive() {
  const out = {};
  for (const s of await listActive()) (out[s.pack] ||= []).push({ id: String(s._id), emoji: s.emoji, label: s.label });
  return Object.entries(out).map(([pack, items]) => ({ pack, items }));
}

/** Only stickers an admin has left active can be used. */
export async function assertValidSticker(emoji) {
  if (!emoji) return '';
  if (!(await Sticker.exists({ emoji, active: true }))) throw new AppError(400, 'BAD_STICKER', 'That sticker isn’t available', { sticker: 'Pick one from the list' });
  return emoji;
}

export async function randomSticker() {
  const all = await listActive();
  return all.length ? all[Math.floor(Math.random() * all.length)].emoji : '';
}
