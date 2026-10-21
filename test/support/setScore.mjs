import mongoose from 'mongoose';
import { Player } from '../../src/models/index.js';
await mongoose.connect(process.env.MONGODB_URI);
const [nick, score] = process.argv.slice(2);
const r = await Player.updateMany({ nickname: nick }, { $set: { score: Number(score) } });
console.log('updated', r.modifiedCount);
await mongoose.disconnect();
