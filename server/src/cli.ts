/**
 * Operator commands, run inside the container against the same database:
 *
 *   docker exec -it mk-drive node src/cli.ts users
 *   docker exec -it mk-drive node src/cli.ts password you@example.com
 *
 * `password` asks for the new one on the terminal (or reads it from stdin
 * when piped) — the way back in when nobody remembers the admin password.
 */
import { createInterface } from 'node:readline/promises';
import { config } from './config.ts';
import { openDb } from './db.ts';
import { PASSWORD_MIN, Users } from './users.ts';

/** Set `email`'s password without knowing the old one; the audit log says the CLI did it. */
export async function resetPassword(users: Users, email: string, password: string): Promise<void> {
  const user = users.byEmail(email.trim().toLowerCase());
  if (!user) throw new Error(`no account for ${email}`);
  if (password.length < PASSWORD_MIN) throw new Error(`the password must be at least ${PASSWORD_MIN} characters`);
  await users.setPassword(user.id, password);
  users.audit({ userId: user.id, email: user.email, action: 'password.reset', detail: 'cli' });
}

async function readSecret(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    let data = '';
    for await (const chunk of process.stdin) data += chunk;
    return data.split(/\r?\n/)[0] ?? '';
  }
  process.stdout.write(prompt);
  const rl = createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  (rl as unknown as { _writeToOutput: () => void })._writeToOutput = () => {}; // keep the typed password off the screen
  try {
    return await rl.question('');
  } finally {
    rl.close();
    process.stdout.write('\n');
  }
}

async function main(argv: string[]): Promise<void> {
  const [command, ...args] = argv;
  const users = new Users(openDb(config.dbFile));
  switch (command) {
    case 'users':
      for (const u of users.list()) console.log(`${u.email}\t${u.role}${u.disabled ? '\tdisabled' : ''}\t${u.name}`);
      return;
    case 'password': {
      const email = args[0];
      if (!email) throw new Error('usage: password <email>');
      const password = await readSecret(`new password for ${email}: `);
      await resetPassword(users, email, password);
      console.log(`password set for ${email}`);
      return;
    }
    default:
      throw new Error('usage: node src/cli.ts users | password <email>');
  }
}

if (process.argv[1]?.endsWith('cli.ts')) {
  main(process.argv.slice(2)).catch((e: Error) => {
    console.error(e.message);
    process.exit(1);
  });
}
