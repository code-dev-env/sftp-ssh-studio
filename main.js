const { app, BrowserWindow, ipcMain, dialog } = require("electron");
const { Client } = require("ssh2");
const fs = require("fs");
const path = require("path");

let win, conn, sftp;
const shells = {};

app.whenReady().then(() => {
  win = new BrowserWindow({
    width: 1300,
    height: 800,
    autoHideMenuBar: true,
    icon: require("path").join(__dirname, "build", "icon.png"),
    webPreferences: { nodeIntegration: true, contextIsolation: false },
  });
  win.loadFile("index.html");
});
app.on("window-all-closed", () => app.quit());

ipcMain.handle(
  "connect",
  (e, { host, user, pass }) =>
    new Promise((resolve) => {
      conn = new Client();
      conn.on("ready", () =>
        conn.sftp((err, s) => {
          if (err) return resolve({ error: err.message });
          sftp = s;
          s.realpath(".", (e2, p) => resolve({ home: e2 ? "/" : p }));
        }),
      );
      conn.on("error", (err) => resolve({ error: err.message }));
      conn.on("close", () => win && win.webContents.send("closed"));
      conn.connect({
        host,
        port: 22,
        username: user,
        password: pass,
        readyTimeout: 15000,
        keepaliveInterval: 15000,
      });
    }),
);

ipcMain.handle(
  "shell-open",
  (e, { id, cols, rows }) =>
    new Promise((resolve) => {
      conn.shell({ term: "xterm-256color", cols, rows }, (err, stream) => {
        if (err) return resolve({ error: err.message });
        shells[id] = stream;
        stream.on("data", (d) =>
          win.webContents.send("shell-data", id, d.toString("utf8")),
        );
        stream.on("close", () => {
          delete shells[id];
          win.webContents.send("shell-exit", id);
        });
        resolve({});
      });
    }),
);
ipcMain.on(
  "shell-write",
  (e, id, data) => shells[id] && shells[id].write(data),
);
ipcMain.on(
  "shell-resize",
  (e, id, cols, rows) => shells[id] && shells[id].setWindow(rows, cols, 0, 0),
);
ipcMain.on("shell-close", (e, id) => {
  if (shells[id]) {
    shells[id].end();
    delete shells[id];
  }
});

ipcMain.handle(
  "list",
  (e, p) =>
    new Promise((resolve) => {
      sftp.readdir(p, (err, list) => {
        if (err) return resolve({ error: err.message });
        resolve({
          items: list
            .map((f) => ({
              name: f.filename,
              dir: f.attrs.isDirectory(),
              size: f.attrs.size,
            }))
            .sort((a, b) => b.dir - a.dir || a.name.localeCompare(b.name)),
        });
      });
    }),
);
// ---------- cancellable transfers ----------
// xfers[id].abort() destroys the in-flight streams and rejects the pending promise with 'cancelled'
const xfers = {};
// byte-count updates (no label) are throttled to ~10/s so the renderer isn't flooded
const progress = (id, done, total, label) => {
  const x = xfers[id],
    now = Date.now();
  if (!label && x && now - (x.t || 0) < 100) return;
  if (x) x.t = now;
  win.webContents.send("xfer-progress", id, done, total, label);
};
const stat = (p) =>
  new Promise((res, rej) =>
    sftp.stat(p, (err, s) => (err ? rej(err) : res(s))),
  );
const readdir = (p) =>
  new Promise((res, rej) =>
    sftp.readdir(p, (err, l) => (err ? rej(err) : res(l))),
  );
ipcMain.on(
  "xfer-cancel",
  (e, id) => xfers[id] && xfers[id].abort && xfers[id].abort(),
);

function pump(id, rs, ws, onBytes) {
  return new Promise((resolve, reject) => {
    xfers[id].abort = () => {
      xfers[id].cancelled = true;
      rs.destroy();
      ws && ws.destroy();
      reject(new Error("cancelled"));
    };
    rs.on("data", (c) => onBytes(c.length));
    rs.on("error", reject);
    if (ws) {
      ws.on("error", reject);
      ws.on("close", resolve);
      rs.pipe(ws);
    } else rs.on("end", resolve);
  });
}

ipcMain.handle("read", async (e, { p, id, force }) => {
  xfers[id] = {};
  let binary = false,
    size = 0;
  try {
    const total = (size = (await stat(p)).size);
    const chunks = [];
    let done = 0,
      checked = false;
    progress(id, 0, total, "Opening " + path.posix.basename(p));
    const rs = sftp.createReadStream(p);
    rs.on("data", (c) => {
      chunks.push(c);
      // NUL byte in the first chunk => treat as binary and stop before downloading the rest
      if (!checked && !force) {
        checked = true;
        if (c.subarray(0, 8192).includes(0)) {
          binary = true;
          xfers[id].abort();
        }
      }
    });
    await pump(id, rs, null, (n) => {
      done += n;
      progress(id, done, total);
    });
    return { text: Buffer.concat(chunks).toString("utf8") };
  } catch (err) {
    if (binary) return { binary: true, size };
    return err.message === "cancelled"
      ? { cancelled: true }
      : { error: err.message };
  } finally {
    delete xfers[id];
  }
});

// ---------- properties ----------
const run = (cmd) =>
  new Promise((resolve) =>
    conn.exec(cmd, (err, stream) => {
      if (err) return resolve("");
      let out = "";
      stream.on("data", (d) => (out += d));
      stream.stderr.on("data", () => {});
      stream.on("close", () => resolve(out));
    }),
  );
const q = (s) => "'" + s.replace(/'/g, "'\\''") + "'";

ipcMain.handle("props", async (e, p) => {
  try {
    const st = await new Promise((res, rej) =>
      sftp.lstat(p, (err, s) => (err ? rej(err) : res(s))),
    );
    const [owner, group, type, birth, ctime, target] = (
      await run("stat -c '%U\t%G\t%F\t%W\t%Z\t%N' -- " + q(p) + " 2>/dev/null")
    )
      .replace(/\n$/, "")
      .split("\t");
    return {
      path: p,
      name: path.posix.basename(p) || "/",
      size: st.size,
      mode: st.mode,
      uid: st.uid,
      gid: st.gid,
      owner: owner || "",
      group: group || "",
      type: type || (st.isDirectory() ? "directory" : "file"),
      isDir: st.isDirectory(),
      atime: st.atime * 1000,
      mtime: st.mtime * 1000,
      ctime: ctime ? +ctime * 1000 : 0,
      birth: birth && +birth > 0 ? +birth * 1000 : 0,
      link:
        target && target.includes(" -> ")
          ? target.split(" -> ")[1].replace(/^'|'$/g, "")
          : "",
    };
  } catch (err) {
    return { error: err.message };
  }
});
ipcMain.handle("props-size", async (e, p) => {
  const out = (
    await run(
      "du -sb -- " +
        q(p) +
        " 2>/dev/null | cut -f1; find " +
        q(p) +
        " -type f 2>/dev/null | wc -l; find " +
        q(p) +
        " -mindepth 1 -type d 2>/dev/null | wc -l",
    )
  )
    .trim()
    .split("\n")
    .map(Number);
  return { size: out[0], files: out[1], dirs: out[2] };
});

ipcMain.handle("download", async (e, { p, dir, id }) => {
  const name = path.posix.basename(p);
  let dest;
  if (dir) {
    const r = await dialog.showOpenDialog(win, {
      title: 'Choose where to save "' + name + '"',
      properties: ["openDirectory", "createDirectory"],
    });
    if (r.canceled) return { cancelled: true };
    dest = path.join(r.filePaths[0], name);
  } else {
    const r = await dialog.showSaveDialog(win, { defaultPath: name });
    if (r.canceled) return { cancelled: true };
    dest = r.filePath;
  }
  xfers[id] = {};
  let current = null;
  try {
    // collect everything first so progress can be reported against a total
    const files = [];
    const walk = async (remote, local) => {
      if (!dir) {
        files.push({ remote, local, size: (await stat(remote)).size });
        return;
      }
      await fs.promises.mkdir(local, { recursive: true });
      for (const f of await readdir(remote)) {
        const r = path.posix.join(remote, f.filename),
          l = path.join(local, f.filename);
        if (f.attrs.isDirectory()) await walk(r, l);
        else files.push({ remote: r, local: l, size: f.attrs.size });
      }
    };
    xfers[id].abort = () => {
      xfers[id].cancelled = true;
    };
    progress(id, 0, 0, "Scanning " + name);
    await walk(p, dest);
    const total = files.reduce((s, f) => s + f.size, 0);
    let done = 0;
    for (const f of files) {
      if (xfers[id].cancelled) throw new Error("cancelled");
      current = f.local;
      progress(id, done, total, f.remote);
      const rs = sftp.createReadStream(f.remote),
        ws = fs.createWriteStream(f.local);
      await pump(id, rs, ws, (n) => {
        done += n;
        progress(id, done, total);
      });
      current = null;
    }
    return { path: dest };
  } catch (err) {
    if (current) fs.unlink(current, () => {});
    return err.message === "cancelled"
      ? { cancelled: true }
      : { error: err.message };
  } finally {
    delete xfers[id];
  }
});
ipcMain.handle(
  "write",
  (e, p, text) =>
    new Promise((resolve) => {
      sftp.writeFile(p, Buffer.from(text, "utf8"), (err) =>
        resolve(err ? { error: err.message } : {}),
      );
    }),
);
ipcMain.on("disconnect", () => {
  if (conn) {
    conn.removeAllListeners("close");
    conn.end();
    conn = null;
  }
});
