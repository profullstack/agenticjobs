/**
 * Credit and invites from a terminal.
 *
 *   credits                       balance and history (the board, over the API)
 *   redeem <code>                 redeem a credit code
 *   invites [create --note t]     invites and the ?ref= link
 *   credits mint|list|revoke      operator: straight against DATABASE_URL
 */

import type { BoardClient } from '../client/client.ts';
import { flagString, type Args } from './args.ts';
import { bold, dim } from './format.ts';

type Out = (human: string, machine: unknown) => number;

function dollars(cents: number): string {
  const abs = Math.abs(Math.round(cents));
  return `${cents < 0 ? '-' : ''}$${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

export async function runCredits(args: Args, client: () => BoardClient, out: Out): Promise<number> {
  if (args.command === 'redeem') {
    const code = args.positional[0] ?? '';
    if (code === '') {
      process.stderr.write('agenticjobs redeem <code>\n');
      return 1;
    }
    const result = await client().redeemCredit(code);
    return out(
      `Redeemed: ${bold(dollars(result.addedCents))} added. Balance ${bold(result.balance)}.`,
      result,
    );
  }

  if (args.command === 'invites') {
    if (args.positional[0] === 'create') {
      const result = await client().createInvite(flagString(args, 'note') ?? '');
      return out(
        `${bold(result.url)}\n${dim(`Shown once. ${result.quota.left} of ${result.quota.total} invites left.`)}`,
        result,
      );
    }
    const result = await client().invites();
    const lines = result.invites.map(
      (invite) =>
        `${invite.used ? 'accepted' : invite.revoked ? 'withdrawn' : 'open    '}  ${invite.note || dim('no note')}  ${dim(invite.createdAt.slice(0, 10))}`,
    );
    return out(
      [
        `${bold(`${result.quota.left} of ${result.quota.total}`)} invites left. ${dim('agenticjobs invites create --note "for Ada"')}`,
        ...lines,
        '',
        `Your link: ${result.affiliateUrl}`,
      ].join('\n'),
      result,
    );
  }

  // credits
  const sub = args.positional[0];
  if (sub === 'mint' || sub === 'list' || sub === 'revoke') return runOperator(args, sub, out);
  const result = await client().credits();
  const lines = result.history.map(
    (entry) =>
      `${entry.kind === 'spend' ? '-' : '+'}${dollars(entry.cents)}  ${entry.source}  ${dim(entry.at.slice(0, 10))}`,
  );
  return out([`Balance ${bold(result.balance)}`, ...lines].join('\n'), result);
}

/** Operator commands: the board's own database, no sign-in, like `serve`. */
async function runOperator(args: Args, sub: 'mint' | 'list' | 'revoke', out: Out): Promise<number> {
  const { closePool, getPool } = await import('../db/pool.ts');
  const { loadConfig } = await import('../config.ts');
  const { migrate } = await import('../db/migrate.ts');
  const { creditServices, mintCreditCode } = await import('../core/credits.ts');
  const pool = getPool(loadConfig().databaseUrl);
  try {
    await migrate(pool);
    if (sub === 'mint') {
      const cents = Number.parseInt(flagString(args, 'cents') ?? '', 10);
      const label = flagString(args, 'label') ?? '';
      if (!Number.isInteger(cents) || label === '') {
        process.stderr.write(
          'agenticjobs credits mint --cents 500 --label "for Ada" [--max 1] [--expires-days 90]\n',
        );
        return 1;
      }
      const max = flagString(args, 'max');
      const days = flagString(args, 'expires-days');
      const minted = await mintCreditCode(pool, {
        cents,
        label,
        maxRedemptions: max === undefined ? 1 : Number.parseInt(max, 10),
        expiresInDays: days === undefined ? null : Number.parseInt(days, 10),
        createdBy: 'cli',
      });
      return out(
        `${bold(minted.code)}\n${dim(`${dollars(cents)}, ${minted.maxRedemptions} use(s), id ${minted.id}. Shown once; only its hash is stored.`)}`,
        { ...minted, cents },
      );
    }
    const { credits } = creditServices(pool);
    if (sub === 'revoke') {
      const id = args.positional[1] ?? '';
      if (id === '') {
        process.stderr.write('agenticjobs credits revoke <id>   (ids are in: credits list)\n');
        return 1;
      }
      await credits.revoke(id);
      return out(`Revoked ${id}.`, { revoked: id });
    }
    const codes = await credits.list();
    if (codes.length === 0) return out('No codes minted yet.', { items: [] });
    return out(
      codes
        .map(
          (code) =>
            `${code.id}  ${dollars(code.grant.amount)}  ${code.redemptions}/${code.maxRedemptions}  ${code.label}${code.revokedAt === null ? '' : dim('  revoked')}`,
        )
        .join('\n'),
      { items: codes },
    );
  } finally {
    await closePool();
  }
}
