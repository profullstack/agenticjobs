/**
 * The full-screen client.
 *
 * Both halves of the board in one window: find work, read what an agent has
 * prepared for you and send it, and on the same account, publish a listing and
 * read what came back. Which half you use is a tab, not a different program,
 * because it is one person either way.
 *
 * Everything drawn lives in views.ts as pure functions; this file is the
 * network, the keyboard and the state transitions and nothing else.
 */

import { createApp } from '@profullstack/hqtui';
import type { BoardClient } from '../client/client.ts';
import { ApiError } from '../client/client.ts';
import { loadConfig } from '../client/config.ts';
import type { Job } from '../schema/index.ts';
import { render } from './views.ts';
import {
  initialState,
  move,
  nextTab,
  selectedBoard,
  selectedDraft,
  selectedJob,
  type DraftRow,
  type TuiState,
} from './state.ts';

export async function startTui(client: BoardClient): Promise<void> {
  let state = initialState(client.server);

  const app = await createApp({
    // The board is read far more than it changes, so a lower cap keeps a
    // remote session responsive without redrawing a static list 30 times a
    // second.
    fps: 20,
    quitKeys: [],
  });

  const invalidate = (next: TuiState): void => {
    state = next;
    app.invalidate();
  };

  const busy = async <T>(label: string, work: () => Promise<T>): Promise<T | null> => {
    invalidate({ ...state, busy: label, error: null });
    try {
      const value = await work();
      invalidate({ ...state, busy: null });
      return value;
    } catch (error) {
      invalidate({
        ...state,
        busy: null,
        error: error instanceof ApiError ? error.message : String(error),
      });
      return null;
    }
  };

  const loadJobs = async (): Promise<void> => {
    const page = await busy('searching', () =>
      client.search({ ...(state.query === '' ? {} : { q: state.query }), limit: 50 }),
    );
    if (page === null) return;
    invalidate({ ...state, jobs: page.items, jobsTotal: page.total, jobIndex: 0 });
  };

  const loadDrafts = async (): Promise<void> => {
    if (!state.signedIn) return;
    const result = await busy('loading drafts', () =>
      client.request<{ items: DraftRow[] }>('GET', '/api/v1/applications/drafts'),
    );
    if (result === null) return;
    invalidate({ ...state, drafts: result.items, draftIndex: 0 });
  };

  const loadListings = async (): Promise<void> => {
    if (!state.canPost) return;
    const me = await busy('loading listings', () => client.me());
    if (me === null) return;
    const slugs = new Set(me.orgs.map((org) => org.slug));
    const pages = await Promise.all(
      me.orgs.map((org) => client.search({ org: org.slug, limit: 50 }).catch(() => null)),
    );
    const listings = pages
      .filter((page): page is NonNullable<typeof page> => page !== null)
      .flatMap((page) => page.items)
      .filter((job: Job) => slugs.has(job.org.slug));
    invalidate({ ...state, listings, listingIndex: 0 });
  };

  const loadBoards = (): void => {
    const config = loadConfig();
    invalidate({
      ...state,
      boards: Object.values(config.boards).map((board) => ({
        server: board.server,
        name: board.name ?? board.server,
        email: board.email ?? null,
        current: board.server === config.current,
      })),
    });
  };

  const identify = async (): Promise<void> => {
    if (!client.hasToken()) return;
    try {
      const me = await client.me();
      invalidate({ ...state, signedIn: true, canPost: me.orgs.length > 0 });
    } catch {
      // An expired token is not an error worth a red bar on the first frame;
      // the status bar already says "not signed in".
      invalidate({ ...state, signedIn: false, canPost: false });
    }
  };

  const handleKey = async (event: { key: string; ctrl?: boolean }): Promise<void> => {
    const key = event.key;

    if (state.editing) {
      if (key === 'escape') {
        invalidate({ ...state, editing: false });
        return;
      }
      if (key === 'enter') {
        invalidate({ ...state, editing: false });
        await loadJobs();
        return;
      }
      if (key === 'backspace') {
        invalidate({ ...state, query: state.query.slice(0, -1) });
        return;
      }
      // Anything that is one printable character is typing. Named keys are
      // longer than one character, which is the whole test.
      if (key.length === 1 && event.ctrl !== true) {
        invalidate({ ...state, query: state.query + key });
      }
      return;
    }

    if (key === 'q' || (key === 'c' && event.ctrl === true)) {
      app.stop();
      return;
    }
    if (key === '/') {
      invalidate({ ...state, editing: true, tab: 'find', detail: null, query: '' });
      return;
    }
    if (key === 'tab') {
      const next = nextTab(state, 1);
      invalidate(next);
      await refresh(next.tab);
      return;
    }
    if (key === 'escape' && state.detail !== null) {
      invalidate({ ...state, detail: null });
      return;
    }
    if (key === 'up' || key === 'k') {
      invalidate(move(state, -1));
      return;
    }
    if (key === 'down' || key === 'j') {
      invalidate(move(state, 1));
      return;
    }
    if (key === 'r') {
      await refresh(state.tab);
      return;
    }

    if (state.detail !== null) {
      if (key === 'a' || key === 'd') await apply(state.detail, key === 'd');
      return;
    }

    if (key === 'enter') {
      await activate();
      return;
    }
    if (state.tab === 'listings' && (key === 'p' || key === 'c')) {
      const job = selectedJob(state);
      if (job === null) return;
      const action = key === 'p' ? 'publish' : 'close';
      const result = await busy(action, () =>
        client.request<{ job: Job }>('POST', `/api/v1/jobs/${encodeURIComponent(job.slug)}/${action}`),
      );
      if (result !== null) {
        invalidate({ ...state, message: `${job.title} is now ${result.job.status}.` });
        await loadListings();
      }
      return;
    }
  };

  const activate = async (): Promise<void> => {
    if (state.tab === 'find' || state.tab === 'listings') {
      const job = selectedJob(state);
      if (job !== null) invalidate({ ...state, detail: job, message: null });
      return;
    }
    if (state.tab === 'drafts') {
      const draft = selectedDraft(state);
      if (draft === null) return;
      const sent = await busy('sending', () =>
        client.request('POST', `/api/v1/applications/${encodeURIComponent(draft.id)}/submit`),
      );
      if (sent !== null) {
        invalidate({ ...state, message: `Sent your application for ${draft.jobTitle}.` });
        await loadDrafts();
      }
      return;
    }
    if (state.tab === 'boards') {
      const board = selectedBoard(state);
      if (board === null) return;
      // Switching boards inside the TUI would mean rebuilding every client and
      // every list; saying so is more honest than half-doing it.
      invalidate({
        ...state,
        message: `Run: agenticjobs use ${board.server}  (then restart the TUI)`,
      });
    }
  };

  const apply = async (job: Job, draft: boolean): Promise<void> => {
    if (!state.signedIn) {
      invalidate({ ...state, error: `Sign in first: agenticjobs login ${client.server}` });
      return;
    }
    const resumes = await busy('reading your resumes', () => client.resumes());
    if (resumes === null) return;
    const first = resumes.items[0];
    if (first === undefined) {
      invalidate({
        ...state,
        error: 'No resume saved. Run: agenticjobs resume import <file>',
      });
      return;
    }

    const me = await busy('applying', () => client.me());
    if (me === null) return;

    const sent = await busy(draft ? 'preparing' : 'applying', () =>
      client.apply(job.slug, {
        name: me.user.name ?? me.user.email,
        email: me.user.email,
        cover: `Applying for ${job.title} at ${job.org.name}.`,
        resumeSlug: first.slug,
        ...(draft ? { submit: false } : {}),
      }),
    );
    if (sent === null) return;

    invalidate({
      ...state,
      detail: null,
      message: draft
        ? `Prepared for ${job.title}. Read it on the Drafts tab and send it there.`
        : `Applied to ${job.title}.`,
    });
    if (draft) await loadDrafts();
  };

  const refresh = async (tab: TuiState['tab']): Promise<void> => {
    if (tab === 'find') await loadJobs();
    else if (tab === 'drafts') await loadDrafts();
    else if (tab === 'listings') await loadListings();
    else loadBoards();
  };

  // Registered after handleKey exists, so the listener never fires into a
  // binding that is still in its temporal dead zone.
  app.on('key', (event) => {
    void handleKey(event);
  });

  app.render((args) => {
    render(args.ui, args.theme, state);
  });

  loadBoards();
  await identify();
  await loadJobs();
  await loadDrafts();

  await app.start();
}
