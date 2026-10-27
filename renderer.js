const { ipcRenderer, clipboard } = require('electron');
const { Terminal } = require('@xterm/xterm');
const { FitAddon } = require('@xterm/addon-fit');
const $ = (id) => document.getElementById(id);

let cwd = '/', nextId = 1, tabs = {}, active = null;

// ---------- login ----------
async function connect() {
  $('err').textContent = 'Connecting...';
  const r = await ipcRenderer.invoke('connect', { host: $('host').value, user: $('user').value, pass: $('pass').value });
  if (r.error) { $('err').textContent = r.error; return; }
  $('login').style.display = 'none';
  $('main').style.display = 'flex';
  await listDir(r.home);
  newTab();
}
$('go').onclick = connect;
$('pass').onkeydown = (e) => { if (e.key === 'Enter') connect(); };
ipcRenderer.on('closed', () => location.reload());
function logout() { ipcRenderer.send('disconnect'); location.reload(); }

// ---------- file browser ----------
const join = (a, b) => (a === '/' ? '' : a) + '/' + b;
async function listDir(p) {
  $('left').classList.add('loading');
  const r = await ipcRenderer.invoke('list', p);
  $('left').classList.remove('loading');
  if (r.error) { alert(r.error); return; }
  cwd = p; $('path').value = p;
  const box = $('files'); box.innerHTML = '';
  const add = (label, cls, fn, hid) => { const d = document.createElement('div'); d.className = 'f ' + cls + (hid ? ' hid' : ''); d.textContent = label; d.onclick = fn; box.appendChild(d); };
  if (p !== '/') add('..', 'd', () => listDir(p.replace(/\/[^/]*$/, '') || '/'));
  for (const f of r.items) {
    if (f.dir) add('\u{1F4C1} ' + f.name, 'd', () => listDir(join(p, f.name)), f.name[0] === '.');
    else add('\u{1F4C4} ' + f.name, '', () => openFile(join(p, f.name)), f.name[0] === '.');
  }
}
$('path').onkeydown = (e) => { if (e.key === 'Enter') listDir($('path').value || '/'); };

// ---------- editor ----------
let editing = null;
async function openFile(p) {
  const r = await ipcRenderer.invoke('read', p);
  if (r.error) { alert(r.error); return; }
  editing = p; $('ename').textContent = p; $('estat').textContent = '';
  $('etext').value = r.text; $('editor').style.display = 'flex'; $('etext').focus();
}
async function save() {
  const r = await ipcRenderer.invoke('write', editing, $('etext').value);
  $('estat').textContent = r.error ? 'ERROR: ' + r.error : 'Saved ✓';
}
$('save').onclick = save;
$('close').onclick = () => { $('editor').style.display = 'none'; editing = null; };
$('etext').onkeydown = (e) => {
  if (e.ctrlKey && e.key === 's') { e.preventDefault(); save(); }
  if (e.key === 'Tab') { e.preventDefault(); document.execCommand('insertText', false, '\t'); }
  if (e.key === 'Escape') $('close').onclick();
};

// ---------- terminal tabs ----------
async function newTab() {
  const id = nextId++;
  const el = document.createElement('div'); el.className = 'term'; $('terms').appendChild(el);
  const term = new Terminal({ fontSize: 14, fontFamily: 'Consolas, monospace', cursorBlink: true, theme: { background: '#1e1e1e' } });
  const fit = new FitAddon(); term.loadAddon(fit);
  const tab = document.createElement('div'); tab.className = 'tab';
  tab.innerHTML = 'Terminal ' + id + '<span>✕</span>';
  tab.onclick = () => select(id);
  tab.querySelector('span').onclick = (e) => { e.stopPropagation(); closeTab(id); };
  $('tabs').insertBefore(tab, $('add'));
  tabs[id] = { term, fit, el, tab };
  select(id);
  term.open(el); fit.fit();

  term.attachCustomKeyEventHandler((e) => {
    if (e.type !== 'keydown' || !e.ctrlKey) return true;
    const k = e.key.toLowerCase();
    if (k === 'c' && (term.hasSelection() || e.shiftKey)) { clipboard.writeText(term.getSelection()); term.clearSelection(); return false; }
    if (k === 'v') { term.paste(clipboard.readText()); return false; }
    return true;
  });
  el.addEventListener('contextmenu', (e) => { e.preventDefault(); term.paste(clipboard.readText()); });

  term.onData((d) => ipcRenderer.send('shell-write', id, d));
  term.onResize(({ cols, rows }) => ipcRenderer.send('shell-resize', id, cols, rows));
  const r = await ipcRenderer.invoke('shell-open', { id, cols: term.cols, rows: term.rows });
  if (r.error) term.write('Error: ' + r.error);
  term.focus();
}
function select(id) {
  active = id;
  for (const k in tabs) { const t = tabs[k]; const on = +k === id; t.el.classList.toggle('on', on); t.tab.classList.toggle('on', on); }
  const t = tabs[id]; setTimeout(() => { t.fit.fit(); t.term.focus(); }, 0);
}
function closeTab(id) {
  const t = tabs[id]; if (!t) return;
  ipcRenderer.send('shell-close', id);
  t.term.dispose(); t.el.remove(); t.tab.remove(); delete tabs[id];
  const rest = Object.keys(tabs);
  if (rest.length) select(+rest[rest.length - 1]); else logout();
}
$('add').onclick = newTab;
ipcRenderer.on('shell-data', (e, id, d) => tabs[id] && tabs[id].term.write(d));
ipcRenderer.on('shell-exit', (e, id) => closeTab(id));
window.addEventListener('resize', () => active && tabs[active] && tabs[active].fit.fit());

// ---------- resizable left pane ----------
$('resizer').onmousedown = (e) => {
  e.preventDefault();
  $('resizer').classList.add('drag');
  const move = (ev) => {
    $('left').style.width = Math.max(120, Math.min(ev.clientX - 8, window.innerWidth - 300)) + 'px';
    if (active && tabs[active]) tabs[active].fit.fit();
  };
  const up = () => { $('resizer').classList.remove('drag'); document.removeEventListener('mousemove', move); document.removeEventListener('mouseup', up); };
  document.addEventListener('mousemove', move); document.addEventListener('mouseup', up);
};
