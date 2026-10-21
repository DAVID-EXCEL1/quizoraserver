import { Setting } from '../models/index.js';

export const DEFAULT_SETTINGS = {
  features: { chat: true, stickers: true, ai: true, billing: true }, // global kill-switches
  chat: { maxLength: 200, defaultMode: 'between', cooldownMs: 700, blockedWords: [] },
  billing: { currency: 'NGN' },
  ai: { maxQuestions: 20, imagesEnabled: true },
};

let cache = null; let at = 0;
export async function getSettings() {
  if (cache && Date.now() - at < 3000) return cache;
  const merged = structuredClone(DEFAULT_SETTINGS);
  for (const d of await Setting.find({}).lean()) if (merged[d.key]) merged[d.key] = { ...merged[d.key], ...d.value };
  cache = merged; at = Date.now();
  return merged;
}

export async function updateSettings(patch) {
  const cur = await getSettings();
  for (const [key, value] of Object.entries(patch)) {
    await Setting.updateOne({ key }, { $set: { value: { ...cur[key], ...value } } }, { upsert: true });
  }
  cache = null;
  return getSettings();
}
export const resetSettingsCache = () => { cache = null; };
