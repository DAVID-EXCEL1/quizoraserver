// Creates the first administrator, or promotes an existing account. Admins can never be created through signup.
//   ADMIN_PASSWORD='…' node src/scripts/createAdmin.js you@example.com "Your Name"
//   node src/scripts/createAdmin.js you@example.com          (prompts for a password if the account doesn't exist yet)
import { pathToFileURL } from 'node:url';
import readline from 'node:readline';
import bcrypt from 'bcryptjs';
import { env } from '../config/env.js';
import { connectDb, disconnectDb } from '../config/db.js';
import { User } from '../models/index.js';
import { password as passwordRule } from '../validators/auth.js';
import { audit } from '../services/adminService.js';

export async function createAdmin({ email, password, fullName }) {
  email = String(email || '').trim().toLowerCase();
  if (!/^\S+@\S+\.\S+$/.test(email)) throw new Error('A valid email address is required');
  let user = await User.findOne({ email });
  if (user) {
    await User.updateOne({ _id: user._id }, { $set: { role: 'admin', status: 'active', emailVerified: true } });
    await audit(null, 'admin.bootstrap', { type: 'user', id: user._id, label: email }, { mode: 'promoted' });
    return { created: false, email };
  }
  const parsed = passwordRule.safeParse(password || '');
  if (!parsed.success) throw new Error(`Password rejected: ${parsed.error.issues[0].message}`);
  user = await User.create({ fullName: fullName || 'Administrator', email, passwordHash: await bcrypt.hash(password, env.bcryptRounds), role: 'admin', emailVerified: true });
  await audit(null, 'admin.bootstrap', { type: 'user', id: user._id, label: email }, { mode: 'created' });
  return { created: true, email };
}

function prompt(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
    rl._writeToOutput = (s) => { if (s.includes(question)) rl.output.write(s); }; // hide typed characters
    rl.question(question, (a) => { rl.close(); process.stdout.write('\n'); resolve(a); });
  });
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  const [email, fullName] = process.argv.slice(2);
  try {
    await connectDb();
    const exists = email && (await User.exists({ email: email.toLowerCase() }));
    const password = exists ? undefined : (process.env.ADMIN_PASSWORD || await prompt('New admin password: '));
    const r = await createAdmin({ email, password, fullName });
    console.log(r.created ? `Created administrator ${r.email}` : `Promoted ${r.email} to administrator`);
  } catch (e) { console.error(e.message); process.exitCode = 1; }
  await disconnectDb();
}
