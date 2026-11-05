/**
 * OpenFullPage - End-to-end capture tests in real Chromium
 *
 * Loads a copy of the extension and checks captured images pixel by pixel.
 * The copy gets <all_urls>, because a toolbar click (activeTab) cannot be automated.
 *
 *   PLAYWRIGHT_CORE=<dir of playwright-core> CHROMIUM=<chrome.exe> npm run test:e2e [-- filter]
 *   SCALE=1.25 also runs it at a real fractional device scale factor
 */
import fs from 'fs';
import os from 'os';
import path from 'path';
import http from 'http';
import { fileURLToPath, pathToFileURL } from 'url';

const [filter] = process.argv.slice(2);
const extSrc = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { chromium } = await import(
  process.env.PLAYWRIGHT_CORE ? pathToFileURL(path.join(process.env.PLAYWRIGHT_CORE, 'index.mjs')).href : 'playwright-core'
);

const S = Number(process.env.SCALE || 1);
const BAND = 100;
const bandColor = (i) => [(i * 37) % 200 + 30, (i * 91) % 200 + 30, (i * 53) % 200 + 30];
const bands = (n, cls = 'band') => Array.from({ length: n }, (_, i) =>
  `<div class="${cls}" style="height:${BAND}px;background:rgb(${bandColor(i)})">${i}</div>`).join('');

const pages = {
  '/tall': `<!doctype html><style>html{scroll-behavior:smooth}body{margin:0}
    header{position:fixed;top:0;left:0;right:0;height:50px;background:#f0f;z-index:9}</style><header>fixed</header>${bands(60)}`,
  '/spa': `<!doctype html><style>html,body{margin:0;height:100%;overflow:hidden}
    #app{position:fixed;inset:0;display:flex}
    nav{width:200px;background:#0f0}main{flex:1;overflow-y:auto}</style>
    <div id=app><nav>nav</nav><main id=m>${bands(40)}</main></div>`,
  '/inner': `<!doctype html><body style="margin:0;background:#fff;height:300px"><div style="height:120px;background:#ff0" id=top>inner top</div></body>`,
  '/el': `<!doctype html><style>body{margin:0}#pad{height:400px;background:#ddd}
    #card{width:500px;margin:0 auto}#small{width:300px;height:100px;background:#123456}
    #sticky{position:sticky;top:0;height:60px;background:#f0f;z-index:5}
    iframe{display:block;width:600px;height:200px;border:0}</style>
    <div id=sticky>sticky</div>
    <div id=small onmousedown="window.__md=(window.__md||0)+1">small</div>
    <iframe id=same src="/inner"></iframe>
    <iframe id=cross src="http://127.0.0.1:PORT2/inner"></iframe>
    <div id=pad></div><div id=card>${bands(25)}</div><div style="height:800px"></div>`
};

pages['/modal'] = `<!doctype html><style>body{margin:0;overflow:hidden}
  .modal{position:fixed;inset:0;z-index:1055;overflow-y:auto;background:rgba(0,0,0,.5)}
  #dlg{position:relative;pointer-events:none;width:400px;margin:0 auto;padding:40px;background:#fff}
  #content{pointer-events:auto;background:#eee}
  #wrap{position:fixed;inset:0;z-index:2000;pointer-events:none}</style>
  <div class=modal><div id=dlg><div id=content>${bands(10)}</div></div></div><div id=wrap></div>`;
pages['/dialog'] = `<!doctype html><style>body{margin:0}dialog{padding:0;border:0;width:300px}</style>
  <dialog id=d><div id=inner style="height:150px;background:#123456">native</div></dialog>
  <script>document.getElementById('d').showModal()</script>`;

// /html/body/div[1]/div[2]/div[24]/div/div from a real page: Bootstrap drawer dialog that scrolls itself
pages['/drawer'] = `<!doctype html><style>body{margin:0;overflow:hidden}
  .modal{position:fixed;inset:0;z-index:1055;overflow:hidden;background:rgba(0,0,0,.5)}
  #dlg{box-sizing:border-box;position:relative;pointer-events:none;float:right;margin:0;
    padding:12px 24px;background:#fff;overflow-y:auto;max-width:600px;top:0;right:0;bottom:0;width:95%;height:100vh}
  #content{pointer-events:auto}</style>
  <div><div></div><div>${'<div></div>'.repeat(23)}<div><div class=modal><div id=dlg><div id=content>${bands(30)}</div></div></div></div></div></div>`;

const serve = () => new Promise((res) => {
  const s = http.createServer((q, r) => {
    const body = (pages[q.url] || '').replaceAll('PORT2', s.port2);
    r.writeHead(pages[q.url] ? 200 : 404, { 'content-type': 'text/html' }); r.end(body);
  });
  s.listen(0, () => res(s));
});
const srv = await serve();
const srv2 = await serve();
srv.port2 = srv2.address().port; srv2.port2 = srv.address().port;
const base = `http://localhost:${srv.address().port}`;

// test copy: real extension + <all_urls> (no toolbar gesture available) + exported entry points
const ext = fs.mkdtempSync(path.join(os.tmpdir(), 'openfp-ext-'));
fs.cpSync(extSrc, ext, { recursive: true, filter: (p) => !/node_modules|\.git$/.test(p) });
const mf = JSON.parse(fs.readFileSync(path.join(ext, 'manifest.json'), 'utf8'));
mf.host_permissions = ['<all_urls>'];
fs.writeFileSync(path.join(ext, 'manifest.json'), JSON.stringify(mf));
fs.appendFileSync(path.join(ext, 'background/service_worker.js'),
  `\nimport { getAllCaptures as __gac, getCapture as __gc } from '../utils/db.js';
  import { saveCapture as __sc } from '../utils/db.js';
  self.__openfp = { captureFullPage, startSelectElement, getAll: __gac, get: __gc, save: __sc };\n`);

const ctx = await chromium.launchPersistentContext(fs.mkdtempSync(path.join(os.tmpdir(), 'openfp-prof-')), {
  executablePath: process.env.CHROMIUM, headless: true, viewport: S === 1 ? { width: 1000, height: 600 } : null,
  args: ['--headless=new', ...(S === 1 ? [] : [`--force-device-scale-factor=${S}`, '--window-size=1250,900']), `--disable-extensions-except=${ext}`, `--load-extension=${ext}`]
});
let sw = ctx.serviceWorkers()[0] || await ctx.waitForEvent('serviceworker');
const swLogs = [];
sw.on('console', (m) => swLogs.push(m.text()));

const open = async (url) => {
  const p = await ctx.newPage();
  p.on('pageerror', (e) => console.log('  pageerror:', e.message));
  await p.goto(url); await p.bringToFront(); await p.waitForTimeout(150);
  return p;
};
const latestAfter = async (n, ms = 25000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const c = await sw.evaluate(async () => (await self.__openfp.getAll(false)).map((r) => r.id));
    if (c.length > n) return sw.evaluate(async ([id, S]) => {
      const r = await self.__openfp.get(id);
      const bmp = await createImageBitmap(await (await fetch(r.dataUrl)).blob());
      const cv = new OffscreenCanvas(bmp.width, bmp.height); const g = cv.getContext('2d', { willReadFrequently: true });
      g.drawImage(bmp, 0, 0);
      const d = g.getImageData(0, 0, bmp.width, bmp.height).data;
      const px = [];
      const x = Math.round(bmp.width / 2) + Math.round(40 * S);
      for (let cy = 0; Math.round(cy * S) < bmp.height; cy += 10) { const i = (Math.round(cy * S) * bmp.width + x) * 4; px.push([d[i], d[i + 1], d[i + 2]]); }
      const lx = 20; const left = (20 * bmp.width + lx) * 4;
      return { w: bmp.width, h: bmp.height, type: r.type, col: px, left: [d[left], d[left + 1], d[left + 2]], mid: (() => { const i = (Math.round(40 * S) * bmp.width + Math.round(bmp.width / 2)) * 4; return [d[i], d[i + 1], d[i + 2]]; })() };
    }, [c[0], S]);
    await new Promise((r) => setTimeout(r, 250));
  }
  return null;
};
const count = () => sw.evaluate(async () => (await self.__openfp.getAll(false)).length);
const tabId = (url) => sw.evaluate(async (u) => {
  const [t] = await chrome.tabs.query({ url: u }); return t;
}, url);
// fraction of sampled rows that show the expected band
const bandScore = (img, offset = 0) => {
  let ok = 0, all = 0;
  img.col.forEach((c, k) => {
    const y = k * 10 + offset; if (y % BAND < 8 || y % BAND > 92) return;
    const e = bandColor(Math.floor(y / BAND)); all++;
    if (Math.abs(c[0] - e[0]) + Math.abs(c[1] - e[1]) + Math.abs(c[2] - e[2]) < 12) ok++;
  });
  return all ? +(ok / all).toFixed(3) : 0;
};

let fails = 0;
const check = (name, cond, extra = '') => { console.log(`${cond ? 'PASS' : 'FAIL'}  ${name} ${extra}`); if (!cond) fails++; };
const scenarios = {
  async hugeCapture() {
    // real pages can stitch into more than IndexedDB's ~133 MB value limit
    const res = await sw.evaluate(async () => {
      const bytes = new Uint8Array(200 * 1024 * 1024);
      for (let i = 0; i < bytes.length; i += 65536) crypto.getRandomValues(bytes.subarray(i, i + 65536));
      let binary = '';
      for (let i = 0; i < bytes.length; i += 8192) binary += String.fromCharCode.apply(null, bytes.subarray(i, i + 8192));
      const url = 'data:image/png;base64,' + btoa(binary);
      const rec = await self.__openfp.save({ title: 'huge', dataUrl: url, thumbnail: 'x', type: 'full' });
      const back = await self.__openfp.get(rec.id);
      return { len: url.length, same: back.dataUrl === url, size: back.fileSize };
    });
    check('huge: record over IndexedDB value limit is saved and read back', res.same && res.len > 250e6, JSON.stringify(res));
  },
  async drawerSelfScrolling() {
    const p = await open(base + '/drawer');
    const n = await count();
    await p.evaluate(() => { document.getElementById('dlg').scrollTop = 500; });
    await sw.evaluate(async (t) => { await self.__openfp.startSelectElement(t); }, await tabId(base + '/drawer'));
    await p.waitForTimeout(200);
    const x = await p.evaluate(() => document.getElementById('dlg').getBoundingClientRect().left + 10);
    await p.mouse.move(x, 300); await p.waitForTimeout(120);
    const label = await p.evaluate(() => document.getElementById('openfullpage-element-badge').textContent);
    check('drawer: dialog picked on its padding', /600 × 600/.test(label) || S !== 1, label);
    await p.mouse.click(x, 300);
    const img = await latestAfter(n);
    check('drawer: whole scrolled content captured', img && img.w === 600 * S && Math.abs(img.h - 3024 * S) <= 2, `${img?.w}x${img?.h}`);
    if (img) {
      const s = bandScore({ col: img.col.slice(2) }, 8);
      check('drawer: bands correct', s > 0.98, `score=${s}`);
    }
    check('drawer: inner scroll restored', (await p.evaluate(() => document.getElementById('dlg').scrollTop)) === 500);

    await p.waitForTimeout(200);
    const { debugLog = [] } = await sw.evaluate(() => chrome.storage.local.get('debugLog'));
    const events = debugLog.map((e) => e.event);
    check('log: records the picked element and slices',
      ['element-confirmed', 'element-prepared', 'element-slice', 'stitched'].every((e) => events.includes(e)), events.slice(-8).join(','));
    const picked = debugLog.findLast((e) => e.event === 'element-confirmed');
    check('log: describes the element', /#dlg/.test(picked?.element?.path) && picked.element.pointerEvents === 'none', picked?.element?.path);
    const id = sw.url().split('/')[2];
    const pop = await ctx.newPage();
    await pop.goto(`chrome-extension://${id}/popup/popup.html`);
    await pop.bringToFront();
    await pop.evaluate(() => {
      const original = navigator.clipboard.writeText.bind(navigator.clipboard);
      navigator.clipboard.writeText = (text) => { window.__copied = text; return original(text); };
    });
    await pop.click('#btn-copy-debug-log');
    await pop.waitForFunction(() => document.getElementById('btn-copy-debug-log').textContent !== 'Copy debug log');
    const label2 = await pop.textContent('#btn-copy-debug-log');
    const copied = await pop.evaluate(() => window.__copied);
    check('log: popup button copies it', label2.includes('Copied') && copied.includes('element-confirmed'), `${label2} ${copied.length} chars`);
    await pop.close();
    await p.close();
  },
  async modalPointerEventsNone() {
    const p = await open(base + '/modal');
    const n = await count();
    await sw.evaluate(async (t) => { await self.__openfp.startSelectElement(t); }, await tabId(base + '/modal'));
    await p.waitForTimeout(200);
    const badge = () => p.evaluate(() => document.getElementById('openfullpage-element-badge').textContent);
    const x = await p.evaluate(() => document.getElementById('dlg').getBoundingClientRect().left + 15);
    await p.mouse.move(x, 20); await p.waitForTimeout(120);
    const onDialog = await badge();
    check('modal: pointer-events:none dialog is pickable', /480 × 1080/.test(onDialog), onDialog);
    await p.mouse.move(x - 40, 20); await p.waitForTimeout(120);
    const onBackdrop = await badge();
    check('modal: backdrop still pickable, transparent wrapper skipped', /class|modal/.test(onBackdrop), onBackdrop);
    await p.mouse.move(x, 20); await p.waitForTimeout(120);
    await p.mouse.click(x, 20);
    const img = await latestAfter(n);
    check('modal: dialog captured whole', img && img.w === 480 * S && img.h === 1080 * S, `${img?.w}x${img?.h}`);
    await p.close();
  },
  async nativeDialog() {
    const p = await open(base + '/dialog');
    const n = await count();
    await sw.evaluate(async (t) => { await self.__openfp.startSelectElement(t); }, await tabId(base + '/dialog'));
    await p.waitForTimeout(200);
    const r = await p.evaluate(() => { const b = document.getElementById('inner').getBoundingClientRect(); return [b.left + 50, b.top + 50]; });
    await p.mouse.move(...r); await p.waitForTimeout(120);
    const label = await p.evaluate(() => document.getElementById('openfullpage-element-badge')?.textContent);
    check('dialog: element inside modal <dialog> highlighted', /300 × 150/.test(label || ''), label);
    await p.mouse.click(...r);
    const img = await latestAfter(n);
    check('dialog: captured', img && img.w === 300 * S && Math.abs(img.h - 150 * S) <= 1, `${img?.w}x${img?.h}`);
    await p.close();
  },
  async viewerUndoAndMenu() {
    const p = await open(base + '/spa');
    const n = await count();
    await sw.evaluate(async (t) => { self.__openfp.captureFullPage(t); }, await tabId(base + '/spa'));
    await latestAfter(n);
    await p.close();
    const v = ctx.pages().find((t) => t.url().includes('viewer.html'));
    v.on('pageerror', (e) => check('viewer: no page errors', false, e.message));
    await v.bringToFront();
    await v.waitForSelector('#doc-dims');
    await v.waitForFunction(() => /\d{3} × \d{3}/.test(document.getElementById('doc-dims').textContent));
    const state = () => v.evaluate(() => ({
      undo: !document.getElementById('btn-editor-undo').disabled,
      redo: !document.getElementById('btn-editor-redo').disabled,
      dims: document.getElementById('doc-dims').textContent,
      crop: !document.getElementById('crop-actions-bar').classList.contains('hidden')
    }));
    const ctrl = (key, code, shiftKey = false) => v.evaluate(([key, code, shiftKey]) => {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, code, ctrlKey: true, shiftKey, bubbles: true, cancelable: true }));
    }, [key, code, shiftKey]);

    await v.waitForTimeout(300); // zoom transition
    const box = await v.locator('#canvas-stage canvas').last().boundingBox();
    const cx = box.x + box.width / 2; const cy = box.y + box.height / 2;

    await v.mouse.click(cx, cy, { button: 'right' });
    const menu = await v.evaluate(() => {
      const m = document.getElementById('editor-context-menu');
      return { shown: !m.classList.contains('hidden'), h: m.offsetHeight, undo: document.getElementById('ctx-undo').disabled };
    });
    check('menu: right click opens it', menu.shown && menu.h > 100, JSON.stringify(menu));
    check('menu: undo disabled with empty history', menu.undo);
    await v.keyboard.press('Escape');

    await v.click('#btn-toggle-editor');
    await v.click('.editor-tool-btn[data-tool="rect"]');
    const drag = async (x1, y1, x2, y2) => {
      await v.mouse.move(x1, y1); await v.mouse.down(); await v.mouse.move(x2, y2, { steps: 3 }); await v.mouse.up();
    };
    await drag(cx - 40, cy - 40, cx + 40, cy + 40);
    check('undo: drawing adds a state', (await state()).undo);
    await v.mouse.click(cx, cy, { button: 'right' });
    check('menu: undo enabled after drawing', !(await v.evaluate(() => document.getElementById('ctx-undo').disabled)));
    await v.keyboard.press('Escape');

    await ctrl('я', 'KeyZ');
    let s = await state();
    check('undo: Ctrl+Z works on Russian layout', !s.undo && s.redo, JSON.stringify(s));
    await ctrl('Z', 'KeyZ', true);
    s = await state();
    check('redo: Ctrl+Shift+Z', s.undo && !s.redo, JSON.stringify(s));
    await ctrl('я', 'KeyZ');
    await ctrl('н', 'KeyY');
    s = await state();
    check('redo: Ctrl+Y works on Russian layout', s.undo && !s.redo, JSON.stringify(s));

    await v.click('.editor-tool-btn[data-tool="crop"]');
    await drag(cx - 30, cy - 30, cx + 20, cy + 20);
    s = await state();
    check('crop: frame change is undoable', s.crop && s.undo, JSON.stringify(s));
    await ctrl('z', 'KeyZ');
    s = await state();
    check('crop: Ctrl+Z steps the frame back', s.crop && s.redo, JSON.stringify(s));
    await ctrl('y', 'KeyY');
    s = await state();
    check('crop: Ctrl+Y brings it forward', s.crop && !s.redo, JSON.stringify(s));
    await ctrl('z', 'KeyZ'); await ctrl('z', 'KeyZ');
    s = await state();
    check('crop: Ctrl+Z past first step leaves crop mode', !s.crop, JSON.stringify(s));

    const before = (await state()).dims;
    await v.click('.editor-tool-btn[data-tool="crop"]');
    await v.click('#btn-apply-crop');
    s = await state();
    check('crop: applied', s.dims !== before, `${before} -> ${s.dims}`);
    await ctrl('z', 'KeyZ');
    s = await state();
    check('crop: Ctrl+Z restores size', s.dims === before, s.dims);
    await v.waitForTimeout(800);
    check('crop: undo right after apply is not overwritten by the save', (await state()).dims === before);
    const saved = await sw.evaluate(async () => (await self.__openfp.getAll(false))[0].dimensions);
    check('crop: undo reaches saved capture', before.startsWith(`${saved.width} × ${saved.height}`), JSON.stringify(saved));
    await ctrl('z', 'KeyZ');
    s = await state();
    check('undo: earlier annotation undone after crop undo', s.dims === before, JSON.stringify(s));

    await v.evaluate(() => { const i = document.createElement('input'); i.id = 'tmp'; document.body.append(i); i.focus(); });
    const prevented = await v.evaluate(() => {
      const e = new KeyboardEvent('keydown', { key: 'z', code: 'KeyZ', ctrlKey: true, bubbles: true, cancelable: true });
      document.getElementById('tmp').dispatchEvent(e); return e.defaultPrevented;
    });
    check('undo: leaves Ctrl+Z in text fields alone', !prevented);
    await v.close();
  },
  async hudNotInShot() {
    // band 0 row under the HUD, in the later slices too
    const p = await open(base + '/tall');
    await p.evaluate(() => window.scrollTo({ top: 300, behavior: 'instant' }));
    const n = await count();
    await sw.evaluate(async (t) => { self.__openfp.captureFullPage(t); }, await tabId(base + '/tall'));
    const img = await latestAfter(n);
    const e = bandColor(0);
    check('hud: absent in image', img && Math.abs(img.mid[0] - e[0]) + Math.abs(img.mid[1] - e[1]) < 12 || img?.mid[0] === 255, `mid=${img?.mid}`);
    await p.waitForTimeout(100);
    check('hud: scroll position restored', (await p.evaluate(() => scrollY)) === 300);
    await p.close();
  },
  async wheelInnerScroller() {
    const p = await open(base + '/spa');
    await sw.evaluate(async (t) => { await self.__openfp.startSelectElement(t); }, await tabId(base + '/spa'));
    await p.waitForTimeout(200);
    await p.mouse.move(500, 300); await p.waitForTimeout(100);
    await p.mouse.wheel(0, 250); await p.waitForTimeout(250);
    const top = await p.evaluate(() => document.getElementById('m').scrollTop);
    check('wheel: scrolls inner container through shield', Math.abs(top - 250) < 1, `scrollTop=${top}`);
    const r = await p.evaluate(() => document.getElementById('openfullpage-element-badge').textContent);
    await p.keyboard.press('Escape');
    const left = await p.evaluate(() => document.querySelectorAll('[id^=openfullpage-element]').length);
    check('wheel: ESC removes all inspector UI', left === 0, `${r} left=${left}`);
    await p.close();
  },
  async orphanReinject() {
    // an instance orphaned by extension reload must not block a fresh injection
    const p = await open(base + '/tall');
    const t = await tabId(base + '/tall');
    await sw.evaluate(async (t) => {
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/content.js'] });
      await chrome.scripting.executeScript({ target: { tabId: t.id }, files: ['content/content.js'] });
    }, t);
    const answers = await sw.evaluate(async (t) => chrome.tabs.sendMessage(t.id, { action: 'PING' }, { frameId: 0 }), t);
    check('reinject: live listener after re-injection', answers?.pong === true);
    await p.close();
  },
  async popupMessage() {
    // real message path used by the popup
    const p = await open(base + '/tall');
    const t = await tabId(base + '/tall');
    const n = await count();
    const id = sw.url().split('/')[2];
    const ext2 = await ctx.newPage();
    await ext2.goto(`chrome-extension://${id}/popup/popup.html`);
    await p.bringToFront();
    const res = await ext2.evaluate((tabId) => chrome.runtime.sendMessage({ action: 'CAPTURE_FULL_PAGE', tabId }), t.id);
    check('popup: acknowledged', res?.started === true);
    check('popup: capture done', !!(await latestAfter(n)));
    await ext2.close(); await p.close();
  },
  async fullTall() {
    const p = await open(base + '/tall');
    const n = await count();
    await sw.evaluate(async (t) => { self.__openfp.captureFullPage(t); }, await tabId(base + '/tall'));
    const img = await latestAfter(n);
    check('tall: image produced', !!img);
    if (img) {
      check('tall: size', (S !== 1 || img.w === 1000) && img.h === 6000 * S, `${img.w}x${img.h}`);
      const s = bandScore({ col: img.col.slice(10) }, 100);
      check('tall: bands in right place (smooth-scroll page)', s > 0.98, `score=${s}`);
    }
    await p.waitForTimeout(150);
    check('tall: page state restored', (await p.evaluate(() => !document.getElementById('openfullpage-hud') && !document.getElementById('openfullpage-status'))));
    await p.close();
  },
  async fullSpa() {
    const p = await open(base + '/spa');
    const n = await count();
    await sw.evaluate(async (t) => { self.__openfp.captureFullPage(t); }, await tabId(base + '/spa'));
    const img = await latestAfter(n);
    check('spa: image produced', !!img);
    if (img) {
      check('spa: only scroller captured', (S !== 1 || img.w === 800) && img.h === 4000 * S, `${img.w}x${img.h}`);
      check('spa: nav not repeated', !(img.left[1] > 200 && img.left[0] < 50), `left=${img.left}`);
      const s = bandScore(img, 0);
      check('spa: bands correct', s > 0.98, `score=${s}`);
    }
    await p.close();
  },
  async elementHover() {
    const p = await open(base + '/el');
    await sw.evaluate(async (t) => { await self.__openfp.startSelectElement(t); }, await tabId(base + '/el'));
    await p.waitForTimeout(200);
    const hl = () => p.evaluate(() => {
      const h = document.getElementById('openfullpage-element-highlighter');
      if (!h) return null; const b = document.getElementById('openfullpage-element-badge');
      return { top: parseFloat(h.style.top), h: parseFloat(h.style.height), w: parseFloat(h.style.width), label: b.textContent };
    });
    await p.mouse.move(100, 100); await p.waitForTimeout(120);
    const a = await hl(); check('hover: plain element', a && /small/.test(a.label) || a?.w === 300, JSON.stringify(a));
    await p.mouse.move(100, 230); await p.waitForTimeout(120);
    const b = await hl(); check('hover: same-origin iframe drills in', /top|div|iframe/.test(b?.label || '') && b?.top !== a?.top, JSON.stringify(b));
    await p.mouse.move(100, 430); await p.waitForTimeout(120);
    const c = await hl(); check('hover: cross-origin iframe selectable', /iframe/.test(c?.label || '') && c?.top !== b?.top, JSON.stringify(c));
    await p.mouse.move(100, 100); await p.waitForTimeout(100);
    await p.mouse.wheel(0, 60); await p.waitForTimeout(250);
    const d = await p.evaluate(() => { const h = document.getElementById('openfullpage-element-highlighter'); return { t: h.getBoundingClientRect().top, r: document.getElementById('same').getBoundingClientRect().top, y: scrollY }; });
    check('hover: highlight tracks element under cursor after scroll', d.y === 60 && d.t === d.r, JSON.stringify(d));
    await p.keyboard.press('Escape');
    await p.close();
  },
  async elementClickSmall() {
    const p = await open(base + '/el');
    const n = await count();
    await sw.evaluate(async (t) => { await self.__openfp.startSelectElement(t); }, await tabId(base + '/el'));
    await p.waitForTimeout(200);
    await p.mouse.move(100, 100); await p.waitForTimeout(120);
    await p.mouse.click(100, 100);
    const img = await latestAfter(n);
    check('small: captured', !!img);
    if (img) check('small: exact size', img.w === 300 * S && img.h === 100 * S, `${img.w}x${img.h}`);
    check('small: page got no mousedown', !(await p.evaluate(() => window.__md)));
    await p.close();
  },
  async elementTall() {
    const p = await open(base + '/el');
    await p.evaluate(() => window.scrollTo(0, 1000)); await p.waitForTimeout(200);
    const n = await count();
    await sw.evaluate(async (t) => { await self.__openfp.startSelectElement(t); }, await tabId(base + '/el'));
    await p.waitForTimeout(200);
    const lbl = await p.evaluate(() => { const r = document.querySelector('#card').getBoundingClientRect(); return [r.top, r.left]; });
    // climb from a band to its parent #card
    await p.mouse.move(500, 300); await p.waitForTimeout(120);
    await p.keyboard.press('ArrowUp'); await p.waitForTimeout(80);
    const label = await p.evaluate(() => document.getElementById('openfullpage-element-badge')?.textContent);
    await p.mouse.click(500, 300);
    const img = await latestAfter(n);
    check('tall el: captured', !!img, `${label} ${lbl}`);
    if (img) {
      check('tall el: whole element', img.w === 500 * S && img.h === 2500 * S, `${img.w}x${img.h}`);
      const s = bandScore(img, 0); check('tall el: bands correct, no sticky', s > 0.98, `score=${s}`);
    }
    const y = await p.evaluate(() => scrollY);
    check('tall el: scroll restored', y === 1000, `y=${y}`);
    await p.close();
  }
};

for (const [name, fn] of Object.entries(scenarios)) {
  if (filter && !name.includes(filter)) continue;
  console.log(`--- ${name}`);
  try { await fn(); } catch (e) { fails++; console.log('FAIL  exception:', e.message.split('\n')[0]); }
  for (const t of ctx.pages()) { if (t.url().includes('viewer.html')) await t.close().catch(() => {}); }
}
console.log('--- SW log:\n' + swLogs.slice(-10).join('\n'));
console.log(`\nFAILS: ${fails}`);
await ctx.close(); srv.close(); srv2.close();
process.exit(fails ? 1 : 0);
