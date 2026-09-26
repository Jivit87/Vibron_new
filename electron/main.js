/* eslint-disable @typescript-eslint/no-require-imports */
const { app, BrowserWindow, dialog, ipcMain } = require('electron');
const { spawn } = require('child_process');
const http = require('http');
const net = require('net');
const path = require('path');
const { getDevServerUrl } = require('./dev-server-url');

let mainWindow;
let nextProcess;
let nextServerUrl;
let nextServerPromise;

const isDev = !app.isPackaged;
app.setName('Viberon');

// Only use no-sandbox for compatibility; do NOT disable both GPU and
// software rasterizer at the same time — that leaves Chromium with no
// rendering backend and produces a blank window.
app.commandLine.appendSwitch('no-sandbox');

function createWindow() {
  const window = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1024,
    minHeight: 700,
    show: false, // Don't show until ready-to-show to avoid blank flash
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      preload: path.join(__dirname, 'preload.js')
    },
    titleBarStyle: 'hiddenInset',
    title: 'Viberon',
    backgroundColor: '#08080f'
  });
  mainWindow = window;

  // Show window only after the page has painted to avoid blank flicker
  window.once('ready-to-show', () => {
    window.show();
  });

  // Dev-mode: open DevTools and log renderer errors for debugging
  if (isDev) {
    window.webContents.openDevTools({ mode: 'detach' });

    window.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
      console.error(`[Electron] did-fail-load: ${errorCode} ${errorDescription} at ${validatedURL}`);
    });

    window.webContents.on('render-process-gone', (_event, details) => {
      console.error('[Electron] render-process-gone:', details);
    });

    window.webContents.on('console-message', (_event, level, message, line, sourceId) => {
      const levels = ['DEBUG', 'INFO', 'WARN', 'ERROR'];
      console.log(`[Renderer ${levels[level] || level}] ${message} (${sourceId}:${line})`);
    });
  }

  if (isDev) {
    window.loadURL(getDevServerUrl());
  } else {
    // Production: start Next.js server
    void startNextServer(window);
  }

  window.on('closed', () => {
    if (mainWindow === window) {
      mainWindow = null;
    }
    if (nextProcess && BrowserWindow.getAllWindows().length === 0) {
      nextProcess.kill();
      nextProcess = null;
      nextServerUrl = null;
    }
  });
}

function waitForServer(url, timeoutMs = 20000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    function attempt() {
      const request = http.get(url, (response) => {
        response.resume();
        resolve();
      });

      request.on('error', () => {
        if (Date.now() - startedAt >= timeoutMs) {
          reject(new Error(`Timed out waiting for ${url}`));
          return;
        }
        setTimeout(attempt, 250);
      });
    }

    attempt();
  });
}

function getAvailablePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.on('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        server.close(() => reject(new Error('Failed to resolve an open port')));
        return;
      }
      const { port } = address;
      server.close((error) => {
        if (error) reject(error);
        else resolve(port);
      });
    });
  });
}

async function startNextServer(window) {
  if (nextServerUrl && nextProcess) {
    window.loadURL(nextServerUrl);
    return;
  }
  if (nextServerPromise) {
    const url = await nextServerPromise;
    window.loadURL(url);
    return;
  }

  nextServerPromise = startNextServerOnce();
  try {
    const url = await nextServerPromise;
    window.loadURL(url);
  } catch (error) {
    console.error('Next.js server did not become ready:', error);
  } finally {
    nextServerPromise = null;
  }
}

async function startNextServerOnce() {
  const nextDir = path.join(__dirname, '..');
  const nextCli = path.join(nextDir, 'node_modules', 'next', 'dist', 'bin', 'next');
  const userDataDir = app.getPath('userData');
  const port = await getAvailablePort();
  const serverUrl = `http://127.0.0.1:${port}`;

  nextProcess = spawn(process.execPath, [nextCli, 'start', '-p', String(port)], {
    cwd: nextDir,
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      VIBERON_STORE_DIR: userDataDir
    },
    stdio: 'inherit'
  });

  nextProcess.on('error', (err) => {
    console.error('Failed to start Next.js server:', err);
  });

  await waitForServer(serverUrl);
  nextServerUrl = serverUrl;
  return serverUrl;
}

ipcMain.handle('viberon:open-folder', async () => {
  const result = await dialog.showOpenDialog(mainWindow ?? undefined, {
    properties: ['openDirectory', 'createDirectory'],
    title: 'Open folder in Viberon'
  });
  if (result.canceled || result.filePaths.length === 0) {
    return { canceled: true };
  }
  return { canceled: false, path: result.filePaths[0] };
});

ipcMain.handle('viberon:new-window', async () => {
  createWindow();
  return { ok: true };
});

ipcMain.handle('viberon:open-terminal', async (_event, cwd) => {
  const workingDirectory = typeof cwd === 'string' && cwd.length > 0 ? cwd : app.getPath('home');
  try {
    if (process.platform === 'darwin') {
      spawn('open', ['-a', 'Terminal', workingDirectory], {
        detached: true,
        stdio: 'ignore'
      }).unref();
    } else if (process.platform === 'win32') {
      spawn('cmd.exe', ['/c', 'start', 'cmd.exe'], {
        cwd: workingDirectory,
        detached: true,
        stdio: 'ignore'
      }).unref();
    } else {
      spawn('x-terminal-emulator', ['--working-directory', workingDirectory], {
        detached: true,
        stdio: 'ignore'
      }).unref();
    }
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
});

app.whenReady().then(createWindow);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
  if (nextProcess) {
    nextProcess.kill();
    nextProcess = null;
    nextServerUrl = null;
  }
});

app.on('activate', () => {
  if (mainWindow === null) {
    createWindow();
  }
});

app.on('before-quit', () => {
  if (nextProcess) {
    nextProcess.kill();
    nextProcess = null;
    nextServerUrl = null;
  }
});
