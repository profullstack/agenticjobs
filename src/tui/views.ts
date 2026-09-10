/**
 * The screens, as pure functions.
 *
 * Each takes the hqtui container and one state object and draws. No network,
 * no timers, no reading the clock beyond what the state carries - which is
 * what lets a test render the real layout to text and assert on it.
 */

import { fill, type Container, type Theme } from '@profullstack/hqtui';
import { ago } from '../schema/text.ts';
import { formatMethod, formatPay, formatPayShort, payOfJob } from '../schema/pay.ts';
import { toPlainText } from '../markup/markdown.ts';
import {
  keyHints,
  selectedIndex,
  type Job,
  type TuiState,
} from './types.ts';

export function render(ui: Container, theme: Theme, state: TuiState): void {
  ui.statusBar({
    items: [
      { label: 'agenticjobs', active: true },
      { label: state.server.replace(/^https?:\/\//, '') },
      ...(state.signedIn ? [] : [{ label: 'not signed in', color: theme.warning }]),
    ],
    right: [
      { label: state.tab },
      ...(state.busy === null ? [] : [{ label: state.busy, color: theme.accent }]),
    ],
  });

  ui.tabs({
    tabs: [
      'Find work',
      `Drafts${state.drafts.length === 0 ? '' : ` (${state.drafts.length})`}`,
      'Your listings',
      'Boards',
    ],
    active: ['find', 'drafts', 'listings', 'boards'].indexOf(state.tab),
    variant: 'underline',
  });

  if (state.error !== null) {
    ui.text([{ text: ' ! ', bg: theme.danger }, { text: ` ${state.error}` }]);
  } else if (state.message !== null) {
    ui.label(` ${state.message}`);
  }

  if (state.detail !== null) {
    jobDetail(ui, theme, state.detail);
  } else {
    switch (state.tab) {
      case 'find':
        findTab(ui, theme, state);
        break;
      case 'drafts':
        draftsTab(ui, theme, state);
        break;
      case 'listings':
        listingsTab(ui, theme, state);
        break;
      case 'boards':
        boardsTab(ui, theme, state);
        break;
    }
  }

  ui.statusBar({ items: keyHints(state).map((hint) => ({ key: hint.key, label: hint.label })) });
}

function findTab(ui: Container, theme: Theme, state: TuiState): void {
  ui.panel({ title: state.editing ? 'Search (enter to run)' : 'Search' }, (panel) => {
    panel.text(state.query === '' ? (state.editing ? '_' : 'press / to search') : state.query);
  });

  if (state.jobs.length === 0) {
    ui.panel({ title: 'Jobs' }, (panel) => {
      panel.label('Nothing here.');
      panel.label('This board only holds listings posted to it, so that means');
      panel.label('nobody posted one, not that a crawler missed it.');
    });
    return;
  }

  ui.panel({ title: `Jobs (${state.jobs.length} of ${state.jobsTotal})`, size: fill }, (panel) => {
    panel.list({
      items: state.jobs.map((job) => ({
        label: jobRow(job),
        badge: job.agentPolicy === 'welcome' ? 'agents' : undefined,
        color: job.agentPolicy === 'human-only' ? theme.muted : undefined,
      })),
      selected: state.jobIndex,
      followSelection: true,
      scrollbar: true,
    });
  });
}

function jobRow(job: Job): string {
  const salary = formatPayShort(payOfJob(job));
  const bits = [job.org.name, job.workplace, salary ?? '', ago(job.publishedAt)].filter(
    (bit) => bit !== '',
  );
  return `${job.title}  -  ${bits.join(' | ')}`;
}

function jobDetail(ui: Container, theme: Theme, job: Job): void {
  ui.heading(job.title);
  ui.label(`${job.org.name}${job.location === null ? '' : ` - ${job.location}`}`);

  ui.keyValues([
      { label: 'Where', value: `${job.workplace}${job.location === null ? '' : `, ${job.location}`}` },
      { label: 'Type', value: job.employmentType },
      { label: 'Level', value: job.seniority ?? 'unspecified' },
      {
        label: 'Pay',
        value: [formatPay(payOfJob(job)) ?? 'not listed', formatMethod(payOfJob(job).method)]
          .filter((bit): bit is string => bit !== null)
          .join(', '),
      },
      {
        label: 'Agents',
        value: agentPolicyText(job.agentPolicy),
        color:
          job.agentPolicy === 'welcome'
            ? theme.success
            : job.agentPolicy === 'human-only'
              ? theme.muted
              : theme.warning,
      },
      { label: 'Stack', value: job.stack.join(', ') || '-' },
    { label: 'Apply', value: job.apply.via },
  ]);

  ui.panel({ title: 'The listing', size: fill }, (panel) => {
    // The description is Markdown; the terminal gets it flattened rather than
    // half-rendered, because a half-rendered heading reads worse than none.
    panel.text(toPlainText(job.description, 4000), { wrap: true });
  });
}

function agentPolicyText(policy: string): string {
  if (policy === 'welcome') return 'welcome, no disclosure asked';
  if (policy === 'human-only') return 'asks for a human-written application';
  return 'welcome if disclosed';
}

function draftsTab(ui: Container, theme: Theme, state: TuiState): void {
  ui.panel({ title: 'Prepared, not sent' }, (panel) => {
    panel.label('An agent can write these. You decide which ones go out.');
  });

  if (state.drafts.length === 0) {
    ui.panel({ title: 'Drafts' }, (panel) => {
      panel.label('Nothing waiting.');
      panel.label('Open a job and press d to prepare one.');
    });
    return;
  }

  ui.panel({ title: `Drafts (${state.drafts.length})`, size: fill }, (panel) => {
    panel.list({
      items: state.drafts.map((draft) => ({
        label: `${draft.jobTitle}   ${ago(draft.createdAt)}`,
        color: theme.accent,
      })),
      selected: state.draftIndex,
      followSelection: true,
      scrollbar: true,
    });
  });
}

function listingsTab(ui: Container, theme: Theme, state: TuiState): void {
  if (!state.canPost) {
    ui.panel({ title: 'Your listings' }, (panel) => {
      panel.label('No employer on this account yet, so there is nothing to post under.');
      panel.label('Add one in a browser, or with the API, then come back.');
    });
    return;
  }

  if (state.listings.length === 0) {
    ui.panel({ title: 'Your listings' }, (panel) => {
      panel.label('Nothing posted yet.');
      panel.label('agenticjobs post job.md');
    });
    return;
  }

  ui.panel({ title: `Your listings (${state.listings.length})`, size: fill }, (panel) => {
    panel.list({
      items: state.listings.map((job) => ({
        label: `${job.title}   ${job.org.name}`,
        badge: job.status,
        color: job.status === 'published' ? theme.success : theme.muted,
      })),
      selected: state.listingIndex,
      followSelection: true,
      scrollbar: true,
    });
  });
}

function boardsTab(ui: Container, theme: Theme, state: TuiState): void {
  ui.panel({ title: 'Boards you are signed in to' }, (panel) => {
    panel.label('One account per board. Search across all of them with: agenticjobs search --all');
  });

  if (state.boards.length === 0) {
    ui.panel({ title: 'Boards' }, (panel) => {
      panel.label('None yet. Run: agenticjobs login <url>');
    });
    return;
  }

  ui.panel({ title: 'Boards', size: fill }, (panel) => {
    panel.list({
      items: state.boards.map((board) => ({
        label: `${board.current ? '* ' : '  '}${board.name}   ${board.email ?? 'signed out'}`,
        color: board.current ? theme.accent : undefined,
      })),
      selected: state.boardIndex,
      followSelection: true,
    });
  });
}

export { selectedIndex };
