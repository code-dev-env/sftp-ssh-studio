const { ipcRenderer, clipboard } = require("electron");
const { Terminal } = require("@xterm/xterm");
const { FitAddon } = require("@xterm/addon-fit");
const $ = (id) => document.getElementById(id);

let cwd = "/",
  nextId = 1,
  tabs = {},
  active = null;

// ---------- login ----------
async function connect() {
  $("err").textContent = "Connecting...";
  const r = await ipcRenderer.invoke("connect", {
    host: $("host").value,
    user: $("user").value,
    pass: $("pass").value,
  });
  if (r.error) {
    $("err").textContent = r.error;
    return;
  }
  $("login").style.display = "none";
  $("main").style.display = "flex";
  await listDir(r.home);
  newTab();
}
$("go").onclick = connect;
$("pass").onkeydown = (e) => {
  if (e.key === "Enter") connect();
};
ipcRenderer.on("closed", () => location.reload());
function logout() {
  ipcRenderer.send("disconnect");
  location.reload();
}

// ---------- file browser ----------
const join = (a, b) => (a === "/" ? "" : a) + "/" + b;
async function listDir(p) {
  $("left").classList.add("loading");
  const r = await ipcRenderer.invoke("list", p);
  $("left").classList.remove("loading");
  if (r.error) {
    alert(r.error);
    return;
  }
  cwd = p;
  $("path").value = p;
  const box = $("files");
  box.innerHTML = "";
  const add = (label, cls, fn, hid, item) => {
    const d = document.createElement("div");
    d.className = "f " + cls + (hid ? " hid" : "");
    d.textContent = label;
    d.onclick = fn;
    if (item)
      d.oncontextmenu = (e) => {
        e.preventDefault();
        showMenu(e.clientX, e.clientY, item);
      };
    box.appendChild(d);
  };
  if (p !== "/")
    add("..", "d", () => listDir(p.replace(/\/[^/]*$/, "") || "/"));
  for (const f of r.items) {
    const item = { path: join(p, f.name), dir: f.dir };
    if (f.dir)
      add(
        "\u{1F4C1} " + f.name,
        "d",
        () => listDir(item.path),
        f.name[0] === ".",
        item,
      );
    else
      add(
        "\u{1F4C4} " + f.name,
        "",
        () => openFile(item.path),
        f.name[0] === ".",
        item,
      );
  }
}

// ---------- context menu ----------
function showMenu(x, y, item) {
  const m = $("menu");
  m.style.display = "block";
  m.style.left = Math.min(x, window.innerWidth - m.offsetWidth - 4) + "px";
  m.style.top = Math.min(y, window.innerHeight - m.offsetHeight - 4) + "px";
  $("mdl").textContent = item.dir ? "Download folder…" : "Download file…";
  $("mdl").onclick = () => {
    hideMenu();
    download(item.path, item.dir);
  };
  $("mprops").onclick = () => {
    hideMenu();
    showProps(item.path);
  };
}
const hideMenu = () => {
  $("menu").style.display = "none";
};
document.addEventListener("click", hideMenu);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") hideMenu();
});
window.addEventListener("blur", hideMenu);

// ---------- transfer modal (loading / download progress with cancel) ----------
let xid = 0,
  xcur = null,
  xtimer = null;
const fmt = (n) =>
  n < 1024
    ? n + " B"
    : n < 1048576
      ? (n / 1024).toFixed(1) + " KB"
      : n < 1073741824
        ? (n / 1048576).toFixed(1) + " MB"
        : (n / 1073741824).toFixed(2) + " GB";
ipcRenderer.on("xfer-progress", (e, id, done, total, label) => {
  if (id !== xcur) return;
  // delay showing so tiny transfers don't flash a modal
  if (!xtimer && $("xfer").style.display !== "flex")
    xtimer = setTimeout(() => {
      xtimer = null;
      if (xcur === id) $("xfer").style.display = "flex";
    }, 200);
  if (label) $("xlabel").textContent = label;
  $("xbar").style.width = total
    ? Math.min(100, (done / total) * 100) + "%"
    : "0%";
  $("xbar").classList.toggle("ind", !total);
  $("xstat").textContent = total ? fmt(done) + " / " + fmt(total) : "";
});
async function transfer(channel, args) {
  const id = ++xid;
  xcur = id;
  $("xlabel").textContent = "Starting…";
  $("xstat").textContent = "";
  $("xbar").style.width = "0%";
  $("xcancel").disabled = false;
  try {
    return await ipcRenderer.invoke(channel, { ...args, id });
  } finally {
    xcur = null;
    clearTimeout(xtimer);
    xtimer = null;
    $("xfer").style.display = "none";
  }
}
$("xcancel").onclick = () => {
  $("xcancel").disabled = true;
  $("xlabel").textContent = "Cancelling…";
  ipcRenderer.send("xfer-cancel", xcur);
};

// ---------- properties ----------
const pad = (n) => String(n).padStart(2, "0");
const fmtDate = (t) => {
  if (!t) return "—";
  const d = new Date(t);
  return (
    d.getFullYear() +
    "-" +
    pad(d.getMonth() + 1) +
    "-" +
    pad(d.getDate()) +
    " " +
    pad(d.getHours()) +
    ":" +
    pad(d.getMinutes()) +
    ":" +
    pad(d.getSeconds())
  );
};
const fmtSize = (n) =>
  fmt(n) + (n >= 1024 ? " (" + n.toLocaleString() + " bytes)" : "");
function rwx(mode) {
  const t =
    {
      0o140000: "s",
      0o120000: "l",
      0o100000: "-",
      0o060000: "b",
      0o040000: "d",
      0o020000: "c",
      0o010000: "p",
    }[mode & 0o170000] || "?";
  let s = t;
  for (let i = 8; i >= 0; i--) s += (mode >> i) & 1 ? "rwx"[(8 - i) % 3] : "-";
  return s;
}
let propsFor = null;
async function showProps(p) {
  propsFor = p;
  const r = await ipcRenderer.invoke("props", p);
  if (propsFor !== p) return;
  if (r.error) {
    alert(r.error);
    return;
  }
  const rows = [
    ["Name", r.name],
    ["Location", r.path],
    ["Type", r.type + (r.link ? " → " + r.link : "")],
    ["Size", r.isDir ? "Calculating…" : fmtSize(r.size)],
    ...(r.isDir ? [["Contains", "Calculating…"]] : []),
    [
      "Permissions",
      rwx(r.mode) +
        "  (" +
        (r.mode & 0o7777).toString(8).padStart(4, "0") +
        ")",
    ],
    ["Owner", (r.owner || "?") + " (uid " + r.uid + ")"],
    ["Group", (r.group || "?") + " (gid " + r.gid + ")"],
    ["Modified", fmtDate(r.mtime)],
    ["Accessed", fmtDate(r.atime)],
    ["Status changed", fmtDate(r.ctime)],
    ["Created", r.birth ? fmtDate(r.birth) : "not available"],
  ];
  const tb = $("ptable");
  tb.innerHTML = "";
  const cells = {};
  for (const [k, v] of rows) {
    const tr = tb.insertRow();
    tr.insertCell().textContent = k;
    const c = tr.insertCell();
    c.textContent = v;
    cells[k] = c;
  }
  $("props").style.display = "flex";
  if (r.isDir) {
    const s = await ipcRenderer.invoke("props-size", p);
    if (propsFor !== p) return;
    cells.Size.textContent = Number.isFinite(s.size)
      ? fmtSize(s.size)
      : "unknown";
    cells.Contains.textContent = Number.isFinite(s.files)
      ? s.files + " files, " + s.dirs + " folders"
      : "unknown";
  }
}
const closeProps = () => {
  propsFor = null;
  $("props").style.display = "none";
};
$("pclose").onclick = closeProps;
$("props").onmousedown = (e) => {
  if (e.target === $("props")) closeProps();
};
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") {
    closeProps();
    $("bin").style.display = "none";
  }
});

// ---------- binary file prompt ----------
let binPath = null;
function askBinary(p, size) {
  binPath = p;
  $("bintext").textContent =
    '"' +
    p.split("/").pop() +
    '" (' +
    fmt(size) +
    ") looks like a binary file. Opening it in the text editor will probably show unreadable characters.";
  $("bin").style.display = "flex";
}
$("binview").onclick = () => {
  $("bin").style.display = "none";
  openFile(binPath, true);
};
$("bindl").onclick = () => {
  $("bin").style.display = "none";
  download(binPath, false);
};
$("bincancel").onclick = () => {
  $("bin").style.display = "none";
};

async function download(p, dir) {
  const r = await transfer("download", { p, dir });
  if (r.error) alert(r.error);
  else if (!r.cancelled) {
    if ($("editor").style.display === "flex")
      $("estat").textContent = "Downloaded ✓";
  }
}
$("path").onkeydown = (e) => {
  if (e.key === "Enter") listDir($("path").value || "/");
};

// ---------- editor ----------
let editing = null;
async function openFile(p, force) {
  const r = await transfer("read", { p, force });
  if (r.cancelled) return;
  if (r.binary) {
    askBinary(p, r.size);
    return;
  }
  if (r.error) {
    alert(r.error);
    return;
  }
  editing = p;
  $("ename").textContent = p;
  $("estat").textContent = "";
  $("etext").value = r.text;
  $("editor").style.display = "flex";
  $("etext").focus();
}
async function save() {
  const r = await ipcRenderer.invoke("write", editing, $("etext").value);
  $("estat").textContent = r.error ? "ERROR: " + r.error : "Saved ✓";
}
$("save").onclick = save;
$("edl").onclick = () => download(editing, false);
$("close").onclick = () => {
  $("editor").style.display = "none";
  editing = null;
};
$("etext").onkeydown = (e) => {
  if (e.ctrlKey && e.key === "s") {
    e.preventDefault();
    save();
  }
  if (e.key === "Tab") {
    e.preventDefault();
    document.execCommand("insertText", false, "\t");
  }
  if (e.key === "Escape") $("close").onclick();
};

// ---------- terminal tabs ----------
async function newTab() {
  const id = nextId++;
  const el = document.createElement("div");
  el.className = "term";
  $("terms").appendChild(el);
  const term = new Terminal({
    fontSize: 14,
    fontFamily: "Consolas, monospace",
    cursorBlink: true,
    theme: { background: "#1e1e1e" },
  });
  const fit = new FitAddon();
  term.loadAddon(fit);
  const tab = document.createElement("div");
  tab.className = "tab";
  tab.innerHTML = "Terminal " + id + "<span>✕</span>";
  tab.onclick = () => select(id);
  tab.querySelector("span").onclick = (e) => {
    e.stopPropagation();
    closeTab(id);
  };
  $("tabs").insertBefore(tab, $("add"));
  tabs[id] = { term, fit, el, tab };
  select(id);
  term.open(el);
  fit.fit();

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== "keydown" || !e.ctrlKey) return true;
    const k = e.key.toLowerCase();
    if (k === "c" && (term.hasSelection() || e.shiftKey)) {
      clipboard.writeText(term.getSelection());
      term.clearSelection();
      return false;
    }
    if (k === "v") {
      term.paste(clipboard.readText());
      return false;
    }
    return true;
  });
  el.addEventListener("contextmenu", (e) => {
    e.preventDefault();
    term.paste(clipboard.readText());
  });

  term.onData((d) => ipcRenderer.send("shell-write", id, d));
  term.onResize(({ cols, rows }) =>
    ipcRenderer.send("shell-resize", id, cols, rows),
  );
  const r = await ipcRenderer.invoke("shell-open", {
    id,
    cols: term.cols,
    rows: term.rows,
  });
  if (r.error) term.write("Error: " + r.error);
  term.focus();
}
function select(id) {
  active = id;
  for (const k in tabs) {
    const t = tabs[k];
    const on = +k === id;
    t.el.classList.toggle("on", on);
    t.tab.classList.toggle("on", on);
  }
  const t = tabs[id];
  setTimeout(() => {
    t.fit.fit();
    t.term.focus();
  }, 0);
}
function closeTab(id) {
  const t = tabs[id];
  if (!t) return;
  ipcRenderer.send("shell-close", id);
  t.term.dispose();
  t.el.remove();
  t.tab.remove();
  delete tabs[id];
  const rest = Object.keys(tabs);
  if (rest.length) select(+rest[rest.length - 1]);
  else logout();
}
$("add").onclick = newTab;
ipcRenderer.on("shell-data", (e, id, d) => tabs[id] && tabs[id].term.write(d));
ipcRenderer.on("shell-exit", (e, id) => closeTab(id));
const refit = () => active && tabs[active] && tabs[active].fit.fit();
window.addEventListener("resize", refit);
// moving between monitors (different size/DPI) can leave the layout stale; refit whenever the terminal area changes
new ResizeObserver(() => requestAnimationFrame(refit)).observe($("terms"));
matchMedia("(resolution: 1dppx)").addEventListener?.("change", refit);

// ---------- resizable left pane ----------
$("resizer").onmousedown = (e) => {
  e.preventDefault();
  $("resizer").classList.add("drag");
  const move = (ev) => {
    $("left").style.width =
      Math.max(120, Math.min(ev.clientX - 8, window.innerWidth - 300)) + "px";
    if (active && tabs[active]) tabs[active].fit.fit();
  };
  const up = () => {
    $("resizer").classList.remove("drag");
    document.removeEventListener("mousemove", move);
    document.removeEventListener("mouseup", up);
  };
  document.addEventListener("mousemove", move);
  document.addEventListener("mouseup", up);
};
