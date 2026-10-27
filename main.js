const { app, BrowserWindow, ipcMain } = require('electron');
const { Client } = require('ssh2');

let win, conn, sftp;
const shells = {};

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1300, height: 800, autoHideMenuBar: true, icon: require('path').join(__dirname, 'build', 'icon.png'),
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  win.loadFile('index.html');
});
app.on('window-all-closed', () => app.quit());

ipcMain.handle('connect', (e, { host, user, pass }) => new Promise((resolve) => {
  conn = new Client();
  conn.on('ready', () => conn.sftp((err, s) => {
    if (err) return resolve({ error: err.message });
    sftp = s;
    s.realpath('.', (e2, p) => resolve({ home: e2 ? '/' : p }));
  }));
  conn.on('error', (err) => resolve({ error: err.message }));
  conn.on('close', () => win && win.webContents.send('closed'));
  conn.connect({ host, port: 22, username: user, password: pass, readyTimeout: 15000, keepaliveInterval: 15000 });
}));

ipcMain.handle('shell-open', (e, { id, cols, rows }) => new Promise((resolve) => {
  conn.shell({ term: 'xterm-256color', cols, rows }, (err, stream) => {
    if (err) return resolve({ error: err.message });
    shells[id] = stream;
    stream.on('data', (d) => win.webContents.send('shell-data', id, d.toString('utf8')));
    stream.on('close', () => { delete shells[id]; win.webContents.send('shell-exit', id); });
    resolve({});
  });
}));
ipcMain.on('shell-write', (e, id, data) => shells[id] && shells[id].write(data));
ipcMain.on('shell-resize', (e, id, cols, rows) => shells[id] && shells[id].setWindow(rows, cols, 0, 0));
ipcMain.on('shell-close', (e, id) => { if (shells[id]) { shells[id].end(); delete shells[id]; } });

ipcMain.handle('list', (e, p) => new Promise((resolve) => {
  sftp.readdir(p, (err, list) => {
    if (err) return resolve({ error: err.message });
    resolve({
      items: list.map(f => ({ name: f.filename, dir: f.attrs.isDirectory(), size: f.attrs.size }))
        .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name))
    });
  });
}));
ipcMain.handle('read', (e, p) => new Promise((resolve) => {
  sftp.readFile(p, (err, buf) => err ? resolve({ error: err.message }) : resolve({ text: buf.toString('utf8') }));
}));
ipcMain.handle('write', (e, p, text) => new Promise((resolve) => {
  sftp.writeFile(p, Buffer.from(text, 'utf8'), (err) => resolve(err ? { error: err.message } : {}));
}));
ipcMain.on('disconnect', () => { if (conn) { conn.removeAllListeners('close'); conn.end(); conn = null; } });
