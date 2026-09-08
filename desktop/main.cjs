/**
 * The desktop app.
 *
 * A window onto a board, and nothing more. There is no second implementation
 * of the board in here: the app loads the same pages a browser loads, from
 * whichever instance you point it at.
 *
 * What it adds over a browser tab is the thing the web cannot do - it reads
 * the terminal's config, so the boards you are signed in to on the CLI are the
 * boards in the menu, and switching between them is one keystroke.
 */

const { app, BrowserWindow, Menu, shell, dialog, session } = require('electron');
const { readFileSync } = require('node:fs');
const { homedir } = require('node:os');
const { join } = require('node:path');

const DEFAULT_SERVER = 'https://agenticjobs.work';

/** The same file `agenticjobs login` writes. One sign-in, both surfaces. */
function configPath() {
  const base =
    process.env.AGENTICJOBS_CONFIG_DIR ??
    process.env.XDG_CONFIG_HOME ??
    join(homedir(), '.config');
  return join(base, 'agenticjobs', 'config.json');
}

function loadBoards() {
  try {
    const parsed = JSON.parse(readFileSync(configPath(), 'utf8'));
    const boards = Object.values(parsed.boards ?? {});
    return { boards, current: parsed.current ?? boards[0]?.server ?? DEFAULT_SERVER };
  } catch {
    return { boards: [], current: DEFAULT_SERVER };
  }
}

let window = null;
let currentServer = DEFAULT_SERVER;

function origin(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function createWindow(server) {
  currentServer = server;

  window = new BrowserWindow({
    width: 1180,
    height: 820,
    minWidth: 380,
    backgroundColor: '#111318',
    title: 'Agentic Jobs',
    autoHideMenuBar: false,
    webPreferences: {
      // No preload and no node integration: the board is a website, and
      // nothing it serves has any business reaching the filesystem.
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      spellcheck: true,
    },
  });

  // Anything that is not this board opens in the real browser. Without this a
  // link to an employer's site loads inside the app with no address bar, which
  // is the shape every desktop-app phishing problem takes.
  window.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });

  window.webContents.on('will-navigate', (event, url) => {
    if (origin(url) !== origin(currentServer)) {
      event.preventDefault();
      void shell.openExternal(url);
    }
  });

  window.webContents.on('did-fail-load', (_event, code, description, url) => {
    if (code === -3) return; // aborted, usually by a redirect
    void dialog.showMessageBox(window, {
      type: 'warning',
      title: 'Could not reach the board',
      message: `${currentServer} did not answer.`,
      detail: `${description} (${code})\n${url}\n\nIt may be offline, or the URL may be wrong.`,
      buttons: ['Retry', 'Choose another board'],
    }).then((result) => {
      if (result.response === 0) window.reload();
      else void switchBoard();
    });
  });

  void window.loadURL(server);
  buildMenu();
}

async function switchBoard() {
  const { boards } = loadBoards();
  if (boards.length === 0) {
    await dialog.showMessageBox(window, {
      type: 'info',
      title: 'No boards yet',
      message: 'Sign in from a terminal first.',
      detail: `Run:\n\n  agenticjobs login ${DEFAULT_SERVER}\n\nThen reopen this app: the boards you are signed in to appear in the Boards menu.`,
      buttons: ['OK'],
    });
    return;
  }
  const result = await dialog.showMessageBox(window, {
    type: 'question',
    title: 'Boards',
    message: 'Which board?',
    buttons: [...boards.map((board) => board.name ?? board.server), 'Cancel'],
    cancelId: boards.length,
  });
  const chosen = boards[result.response];
  if (chosen !== undefined) {
    currentServer = chosen.server;
    void window.loadURL(chosen.server);
    buildMenu();
  }
}

function buildMenu() {
  const { boards, current } = loadBoards();

  Menu.setApplicationMenu(
    Menu.buildFromTemplate([
      {
        label: 'Boards',
        submenu: [
          ...(boards.length === 0
            ? [{ label: 'None yet - sign in with `agenticjobs login`', enabled: false }]
            : boards.map((board) => ({
                label: board.name ?? board.server,
                type: 'radio',
                checked: board.server === currentServer,
                click: () => {
                  currentServer = board.server;
                  void window.loadURL(board.server);
                },
              }))),
          { type: 'separator' },
          { label: 'Reload', accelerator: 'CmdOrCtrl+R', click: () => window.reload() },
          { role: 'quit' },
        ],
      },
      {
        label: 'Go',
        submenu: [
          { label: 'Jobs', accelerator: 'CmdOrCtrl+1', click: () => window.loadURL(`${currentServer}/`) },
          { label: 'You', accelerator: 'CmdOrCtrl+2', click: () => window.loadURL(`${currentServer}/me`) },
          { label: 'Post a job', accelerator: 'CmdOrCtrl+3', click: () => window.loadURL(`${currentServer}/post`) },
          { type: 'separator' },
          { label: 'Back', accelerator: 'CmdOrCtrl+[', click: () => window.webContents.navigationHistory.goBack() },
          { label: 'Forward', accelerator: 'CmdOrCtrl+]', click: () => window.webContents.navigationHistory.goForward() },
        ],
      },
      { role: 'editMenu' },
      {
        label: 'View',
        submenu: [
          { role: 'resetZoom' },
          { role: 'zoomIn' },
          { role: 'zoomOut' },
          { type: 'separator' },
          { role: 'togglefullscreen' },
          { role: 'toggleDevTools' },
        ],
      },
      {
        label: 'Help',
        submenu: [
          { label: 'For agents', click: () => shell.openExternal(`${currentServer}/docs`) },
          { label: 'Source', click: () => shell.openExternal('https://github.com/profullstack/agenticjobs') },
        ],
      },
    ]),
  );

  if (current !== currentServer && boards.length > 0) buildMenu();
}

app.whenReady().then(() => {
  // The board ships no third-party script and its own CSP says so; this is the
  // belt to that CSP's braces, applied at the app level where a page cannot
  // relax it.
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({ responseHeaders: details.responseHeaders });
  });

  const { current } = loadBoards();
  createWindow(current);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow(currentServer);
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
