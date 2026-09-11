/**
 * Argument parsing, small enough to read.
 *
 * `--flag value`, `--flag=value`, `--bool`, `-x`, and `--` to stop parsing.
 * Repeated flags collect into an array, because `--answer a=1 --answer b=2` is
 * how the apply command takes fields.
 */

export interface Args {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean | string[]>;
}

// Boolean options must not consume the next command or search word. Keep
// explicit boolean values working for callers that pass `--remote false`.
const BOOLEAN_FLAGS = new Set([
  'version',
  'v',
  'help',
  'h',
  'yes',
  'y',
  'json',
  'remote',
  'agents',
  'all',
  'network',
  'unsupervised',
  'draft',
  'salary-unpaid',
  'publish',
  'following',
  'candidate',
]);

function takesValue(name: string, next: string | undefined): next is string {
  return (
    next !== undefined &&
    !next.startsWith('-') &&
    (!BOOLEAN_FLAGS.has(name) || /^(true|false|1|0|yes|no)$/i.test(next))
  );
}

export function parseArgs(argv: string[]): Args {
  const positional: string[] = [];
  const flags: Record<string, string | boolean | string[]> = {};
  let stopped = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index] ?? '';

    if (stopped) {
      positional.push(token);
      continue;
    }
    if (token === '--') {
      stopped = true;
      continue;
    }

    if (token.startsWith('--')) {
      const body = token.slice(2);
      const equals = body.indexOf('=');
      if (equals >= 0) {
        set(flags, body.slice(0, equals), body.slice(equals + 1));
        continue;
      }
      const next = argv[index + 1];
      if (takesValue(body, next)) {
        set(flags, body, next);
        index += 1;
        continue;
      }
      set(flags, body, true);
      continue;
    }

    if (token.startsWith('-') && token.length > 1) {
      const body = token.slice(1);
      const next = argv[index + 1];
      if (takesValue(body, next)) {
        set(flags, body, next);
        index += 1;
        continue;
      }
      set(flags, body, true);
      continue;
    }

    positional.push(token);
  }

  return { command: positional.shift() ?? '', positional, flags };
}

function set(
  flags: Record<string, string | boolean | string[]>,
  key: string,
  value: string | boolean,
): void {
  const existing = flags[key];
  if (existing === undefined) {
    flags[key] = value;
    return;
  }
  // Repeats collect. The first one having been a bare boolean is a typo, and
  // dropping it silently is worse than keeping it as a string.
  const list = Array.isArray(existing) ? existing : [String(existing)];
  list.push(String(value));
  flags[key] = list;
}

export function flagString(args: Args, ...names: string[]): string | undefined {
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) return value[value.length - 1];
  }
  return undefined;
}

export function flagBool(args: Args, ...names: string[]): boolean {
  for (const name of names) {
    const raw = args.flags[name];
    // Repeated options use their last value, just like flagString.
    const value = Array.isArray(raw) ? raw[raw.length - 1] : raw;
    if (value === true) return true;
    if (typeof value === 'string') return !['false', '0', 'no'].includes(value.toLowerCase());
  }
  return false;
}

export function flagList(args: Args, ...names: string[]): string[] {
  const out: string[] = [];
  for (const name of names) {
    const value = args.flags[name];
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) out.push(...value);
  }
  return out;
}

export function flagNumber(args: Args, ...names: string[]): number | undefined {
  const raw = flagString(args, ...names);
  if (raw === undefined) return undefined;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : undefined;
}
