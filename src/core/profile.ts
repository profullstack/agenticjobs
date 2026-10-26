/**
 * The shared Profullstack profile (@profullstack/profile): email, first and
 * last name, company domain, job title and LinkedIn URL, in `user_profiles`.
 *
 * Asked for on /signup only, carried on the magic link (the account is created
 * when the link is spent), and editable afterwards on /me and through
 * GET/PUT/PATCH /api/v1/me/profile. Never shown to anyone but its owner.
 */

import type pg from 'pg';
import {
  createProfileHandlers,
  createProfileStore,
  saveSignupProfile,
  type ProfileStore,
} from '@profullstack/profile';

const stores = new WeakMap<pg.Pool, ProfileStore>();

export function profileStore(pool: pg.Pool): ProfileStore {
  let store = stores.get(pool);
  if (store === undefined) {
    store = createProfileStore(pool);
    stores.set(pool, store);
  }
  return store;
}

type Handlers = ReturnType<typeof createProfileHandlers>;
const handlers = new WeakMap<pg.Pool, Handlers>();

/**
 * GET/PUT/PATCH /api/v1/me/profile: the package's own handlers. `getUser`
 * receives the Hono context as its second argument and reads the viewer the
 * session middleware already resolved.
 */
export function profileHandlers(pool: pg.Pool): Handlers {
  let found = handlers.get(pool);
  if (found === undefined) {
    found = createProfileHandlers({
      store: profileStore(pool),
      getUser: (_request, c) => {
        const viewer = (c as { get(key: 'viewer'): { id: string; email: string } | null }).get(
          'viewer',
        );
        return viewer === null ? null : { id: viewer.id, email: viewer.email };
      },
    });
    handlers.set(pool, found);
  }
  return found;
}

/**
 * Save the fields a signup carried on its link. A failure is logged and
 * swallowed: it must never cost anybody their sign-in, and /me asks again.
 */
export async function saveCarriedProfile(
  pool: pg.Pool,
  user: { id: string; email: string },
  profile: Record<string, unknown> | null,
): Promise<void> {
  if (profile === null) return;
  try {
    await saveSignupProfile(profileStore(pool), user.id, profile, { email: user.email });
  } catch (error) {
    console.error('[auth] signup profile save failed:', (error as Error).message);
  }
}
