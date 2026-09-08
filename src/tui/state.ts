/**
 * The TUI's state, and the pure functions over it.
 *
 * Every view is a function of one of these objects and nothing else, which is
 * what lets hqtui's renderToText exercise the real layout in a test instead of
 * a reimplementation of it. Nothing here touches the network or the terminal.
 */

import type { Job } from '../schema/index.ts';

export const TABS = ['find', 'drafts', 'listings', 'boards'] as const;
export type Tab = (typeof TABS)[number];

export interface DraftRow {
  id: string;
  jobTitle: string;
  jobSlug: string;
  createdAt: string;
}

export interface BoardRow {
  server: string;
  name: string;
  email: string | null;
  current: boolean;
}

export interface TuiState {
  tab: Tab;
  server: string;
  /** Set while a request is in flight, so the frame can say so. */
  busy: string | null;
  /** Shown in the status bar until the next action replaces it. */
  message: string | null;
  error: string | null;

  query: string;
  /** True while the search box has the keyboard. */
  editing: boolean;

  jobs: Job[];
  jobsTotal: number;
  jobIndex: number;
  /** Set when a listing is open over the list. */
  detail: Job | null;

  drafts: DraftRow[];
  draftIndex: number;

  listings: Job[];
  listingIndex: number;

  boards: BoardRow[];
  boardIndex: number;

  /** True when the account can post, which changes what the help bar says. */
  canPost: boolean;
  signedIn: boolean;
}

export function initialState(server: string): TuiState {
  return {
    tab: 'find',
    server,
    busy: null,
    message: null,
    error: null,
    query: '',
    editing: false,
    jobs: [],
    jobsTotal: 0,
    jobIndex: 0,
    detail: null,
    drafts: [],
    draftIndex: 0,
    listings: [],
    listingIndex: 0,
    boards: [],
    boardIndex: 0,
    canPost: false,
    signedIn: false,
  };
}

/** How many rows the active tab has, so movement can be written once. */
export function rowCount(state: TuiState): number {
  switch (state.tab) {
    case 'find':
      return state.jobs.length;
    case 'drafts':
      return state.drafts.length;
    case 'listings':
      return state.listings.length;
    case 'boards':
      return state.boards.length;
  }
}

export function selectedIndex(state: TuiState): number {
  switch (state.tab) {
    case 'find':
      return state.jobIndex;
    case 'drafts':
      return state.draftIndex;
    case 'listings':
      return state.listingIndex;
    case 'boards':
      return state.boardIndex;
  }
}

export function withSelection(state: TuiState, index: number): TuiState {
  // Clamped rather than wrapped: holding a cursor key past the end and
  // reappearing at the top is disorienting in a list you are reading.
  const count = rowCount(state);
  const next = count === 0 ? 0 : Math.min(count - 1, Math.max(0, index));
  switch (state.tab) {
    case 'find':
      return { ...state, jobIndex: next };
    case 'drafts':
      return { ...state, draftIndex: next };
    case 'listings':
      return { ...state, listingIndex: next };
    case 'boards':
      return { ...state, boardIndex: next };
  }
}

export function move(state: TuiState, delta: number): TuiState {
  return withSelection(state, selectedIndex(state) + delta);
}

export function nextTab(state: TuiState, delta: number): TuiState {
  const index = TABS.indexOf(state.tab);
  const next = TABS[(index + delta + TABS.length) % TABS.length] ?? 'find';
  return { ...state, tab: next, detail: null };
}

export function selectedJob(state: TuiState): Job | null {
  if (state.tab === 'find') return state.jobs[state.jobIndex] ?? null;
  if (state.tab === 'listings') return state.listings[state.listingIndex] ?? null;
  return null;
}

export function selectedDraft(state: TuiState): DraftRow | null {
  return state.drafts[state.draftIndex] ?? null;
}

export function selectedBoard(state: TuiState): BoardRow | null {
  return state.boards[state.boardIndex] ?? null;
}

/** What the bottom bar offers, which differs per tab and per role. */
export function keyHints(state: TuiState): { key: string; label: string }[] {
  if (state.editing) {
    return [
      { key: 'enter', label: 'search' },
      { key: 'esc', label: 'cancel' },
    ];
  }
  const common = [
    { key: 'tab', label: 'switch' },
    { key: '/', label: 'search' },
    { key: 'r', label: 'reload' },
    { key: 'q', label: 'quit' },
  ];
  if (state.detail !== null) {
    return [
      { key: 'a', label: 'apply' },
      { key: 'd', label: 'prepare draft' },
      { key: 'esc', label: 'back' },
      ...common,
    ];
  }
  switch (state.tab) {
    case 'find':
      return [{ key: 'enter', label: 'open' }, ...common];
    case 'drafts':
      return [
        { key: 'enter', label: 'send' },
        { key: 'x', label: 'discard' },
        ...common,
      ];
    case 'listings':
      return [
        { key: 'p', label: 'publish' },
        { key: 'c', label: 'close' },
        { key: 'enter', label: 'applications' },
        ...common,
      ];
    case 'boards':
      return [{ key: 'enter', label: 'use' }, ...common];
  }
}
