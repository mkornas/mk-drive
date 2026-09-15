/**
 * The client side of the mk-nas socket: one request per connection,
 * newline-delimited JSON, the agent's error codes mapped to HTTP. The
 * agent is root; this is the only thing in the container that talks to it,
 * and it can only ask for verbs the agent's allow-list knows.
 */
import { connect } from 'node:net';
import { HttpError } from './errors.ts';
import type { NasError, Request, Response, Verb, Verbs } from '../../shared/nas.ts';

const STATUS: Record<NasError['code'], number> = {
  'bad-request': 500,
  'unknown-verb': 500,
  'bad-args': 400,
  'not-found': 404,
  unavailable: 503,
  'command-failed': 502,
  internal: 502,
};

/** The verb contract this drive is built for (mk-nas shared/types.ts, agent CONTRACT). */
export const NAS_CONTRACT = 2;

export class NasClient {
  private readonly socket: string;
  private readonly timeout: number;
  private seq = 0;
  private versionAt = 0;
  private version: { agent: string; contract: number } | null = null;

  /** The agent's version, asked at most once a minute; null when it does not answer. */
  async cachedVersion(): Promise<{ agent: string; contract: number } | null> {
    if (Date.now() - this.versionAt < 60_000) return this.version;
    this.versionAt = Date.now();
    try {
      const v = await this.call('version');
      this.version = { agent: v.agent, contract: typeof v.contract === 'number' ? v.contract : 0 };
    } catch {
      this.version = null;
    }
    return this.version;
  }

  constructor(socket: string, timeout = 60_000) {
    this.socket = socket;
    this.timeout = timeout;
  }

  call<V extends Verb>(verb: V, args?: Verbs[V]['args']): Promise<Verbs[V]['result']> {
    const id = ++this.seq;
    const req: Request = { id, verb, args: args as Record<string, unknown> | undefined };
    return new Promise((resolve, reject) => {
      let buf = '';
      let done = false;
      const finish = (fn: () => void) => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        sock.destroy();
        fn();
      };
      const sock = connect(this.socket);
      const timer = setTimeout(() => finish(() => reject(new HttpError(504, 'the NAS agent did not answer in time'))), this.timeout);
      sock.setEncoding('utf8');
      sock.on('connect', () => sock.write(JSON.stringify(req) + '\n'));
      sock.on('data', (chunk: string) => {
        buf += chunk;
        const nl = buf.indexOf('\n');
        if (nl < 0) return;
        let res: Response;
        try {
          res = JSON.parse(buf.slice(0, nl)) as Response;
        } catch {
          return finish(() => reject(new HttpError(502, 'the NAS agent sent something that is not JSON')));
        }
        finish(() => {
          if (res.ok) resolve(res.result as Verbs[V]['result']);
          else reject(Object.assign(new HttpError(STATUS[res.error.code] ?? 502, res.error.message), { nas: res.error }));
        });
      });
      sock.on('error', (err: NodeJS.ErrnoException) =>
        finish(() =>
          reject(
            new HttpError(
              503,
              err.code === 'ENOENT' || err.code === 'ECONNREFUSED'
                ? 'the NAS agent is not running'
                : err.code === 'EACCES'
                  ? 'the NAS socket refuses this container'
                  : `NAS socket: ${err.message}`,
            ),
          ),
        ),
      );
      sock.on('close', () => finish(() => reject(new HttpError(502, 'the NAS agent closed the connection'))));
    });
  }
}

/** The SMB user name for a drive account: the email's local part, lower-cased, tamed to what Samba and useradd take. */
export function smbUserName(email: string): string {
  const local = email
    .split('@')[0]
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, '-')
    .replace(/^[^a-z]+/, '');
  const name = (local || 'user').slice(0, 32);
  return name === 'root' ? 'root-' : name;
}

/**
 * The SMB user name of every drive account, unique: accounts are taken oldest first, each gets its email's name
 * unless an older account holds it already, then `<name>-<id>` (cut to 32 characters, the suffix kept). A new
 * account never changes the name of an older one, so alex@a and alex@b never share one SMB account and password.
 */
export function smbUserNames(accounts: { id: number; email: string }[]): Map<number, string> {
  const names = new Map<number, string>();
  const taken = new Set<string>();
  for (const a of [...accounts].sort((x, y) => x.id - y.id)) {
    const base = smbUserName(a.email);
    let name = base;
    for (let n = 0; taken.has(name); n++) {
      const suffix = n === 0 ? `-${a.id}` : `-${a.id}-${n}`;
      name = base.slice(0, 32 - suffix.length) + suffix;
    }
    taken.add(name);
    names.set(a.id, name);
  }
  return names;
}
