// E2E: настоящий Chrome for Testing с собранным расширением + мок модели и тестовые страницы.
// Запуск: npm run e2e (сначала собирает dist/chrome-mv3). Только часть сценариев: npm run e2e -- mask,drag
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer-core';
import { events, start } from './server.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const EXT = path.join(root, 'dist/chrome-mv3');
const PORT = Number(process.env.PORT ?? 18080);
const BASE = `http://127.0.0.1:${PORT}`;
const only = process.argv[2]?.split(',');

/** Chrome for Testing: CHROME_PATH или .cache/chrome (npx @puppeteer/browsers install chrome@stable --path .cache/chrome). */
function findChrome() {
  if (process.env.CHROME_PATH) return process.env.CHROME_PATH;
  const names = ['Google Chrome for Testing', 'chrome', 'chrome.exe'];
  const walk = (dir, depth) => {
    if (depth > 8 || !fs.existsSync(dir)) return null;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isFile() && names.includes(e.name) && (e.name !== 'chrome' || !p.includes('.app'))) return p;
      if (e.isDirectory()) {
        const found = walk(p, depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  const found = walk(path.join(root, '.cache/chrome'), 0);
  if (!found) {
    console.error('Не найден Chrome for Testing. Установите:\n  npx @puppeteer/browsers install chrome@stable --path .cache/chrome\nили укажите путь в CHROME_PATH.');
    process.exit(2);
  }
  return found;
}

if (!fs.existsSync(path.join(EXT, 'manifest.json'))) {
  console.error('Нет сборки dist/chrome-mv3 — выполните npm run build.');
  process.exit(2);
}

const server = await start(PORT);
const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: process.env.HEADLESS === '1',
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`, '--no-first-run', '--window-size=1200,900'],
});
const sw = await browser.waitForTarget((t) => t.type() === 'service_worker' && t.url().includes('background'));
const extId = new URL(sw.url()).host;
const ctl = await browser.newPage();
await ctl.goto(`chrome-extension://${extId}/sidepanel.html`);
const call = (fn, ...args) => ctl.evaluate(fn, ...args);
const bg = (msg) => call((m) => chrome.runtime.sendMessage(m), msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function setSettings(extra = {}) {
  await call(
    async (base, extra) => {
      const profile = { label: 'Mock', provider: 'openai', baseUrl: base, apiKey: '', model: 'mock', temperature: 0, contextTokens: 16384, maxOutputTokens: 512, requestTimeoutSec: 20, structuredOutput: 'auto', thinking: false, extraBody: '', vision: !!extra.vision };
      await chrome.storage.local.set({ settings: { activeProfile: 'fast', profiles: { fast: profile }, agent: { maxSteps: 12, loopThreshold: 2, autoScrollAfter: 0, screenshots: extra.screenshots ?? 'off' } } });
    },
    BASE,
    extra,
  );
}

async function openWindow(urlPath, zoom) {
  const win = await call(async (url) => (await chrome.windows.create({ url, focused: true, width: 1000, height: 800 })).id, BASE + urlPath);
  await sleep(1200);
  if (zoom) {
    await call(async (w, z) => {
      const [t] = await chrome.tabs.query({ windowId: w, active: true });
      await chrome.tabs.setZoom(t.id, z);
    }, win, zoom);
    await sleep(400);
  }
  return win;
}

async function closeWindow(win, resetZoom) {
  if (resetZoom) {
    await call(async (w) => {
      const [t] = await chrome.tabs.query({ windowId: w, active: true });
      await chrome.tabs.setZoom(t.id, 0);
    }, win).catch(() => {});
  }
  await call((w) => chrome.windows.remove(w), win).catch(() => {});
}

const WAIT_STATES = ['done', 'failed', 'stopped', 'deferred', 'awaiting_approval', 'asking_user'];

async function waitRun() {
  for (let i = 0; i < 120; i++) {
    await sleep(500);
    const info = (await bg({ type: 'bg:run-get' })).value;
    if (info && WAIT_STATES.includes(info.state.status)) return info.state;
  }
  throw new Error('запуск не закончился за 60 с');
}

function printRun(s) {
  for (const st of s.steps) {
    for (const a of st.actions) {
      const how = a.skipped ? `SKIPPED ${a.skipped}` : a.result ? `${a.result.ok ? 'ok' : 'FAIL'}: ${a.result.message}` : 'pending';
      console.log(`    ${st.n}. ${JSON.stringify(a.action)} → ${how}${a.risk ? ` RISK ${a.risk.map((r) => r.kind)}` : ''}`);
    }
  }
}

const results = [];
async function scenario(name, urlPath, check, opts = {}) {
  if (only && !only.includes(name)) return;
  if (opts.settings) await setSettings(opts.settings);
  const win = await openWindow(urlPath, opts.zoom);
  let ok = false;
  let detail = '';
  let state = null;
  try {
    const started = await bg({ type: 'bg:run-start', windowId: win, task: `[${name}] ${opts.task ?? 'e2e'}` });
    if (!started.ok) throw new Error(started.error);
    state = await waitRun();
    const verdict = await check(state, win);
    ok = verdict === true;
    detail = ok ? '' : String(verdict);
  } catch (err) {
    detail = err instanceof Error ? err.message : String(err);
  }
  if (state && ['awaiting_approval', 'asking_user'].includes(state.status)) {
    await bg({ type: 'bg:run-control', command: 'stop' });
    // Следующий сценарий стартует, только когда остановка дошла до конца.
    for (let i = 0; i < 20; i++) {
      const info = (await bg({ type: 'bg:run-get' })).value;
      if (!info || ['done', 'failed', 'stopped', 'deferred'].includes(info.state.status)) break;
      await sleep(250);
    }
  }
  console.log(`${ok ? '✓' : '✗'} ${name} — ${state?.status ?? '?'}${state?.result ? `: ${state.result}` : ''}${state?.error ? `: ${state.error}` : ''}${detail ? `\n    ${detail}` : ''}`);
  if (!ok && state) printRun(state);
  results.push(ok);
  await sleep(300);
  if (!opts.keepWindow) await closeWindow(win, !!opts.zoom);
  if (opts.settings) await setSettings();
  return { win, state };
}

const noFail = (s) => s.steps.every((st) => st.actions.every((a) => !a.result || a.result.ok)) || 'есть неудачное действие';

await setSettings();
await scenario('mask', '/mask', (s) => (s.status === 'done' && s.result.includes('+7 (999) 123-45-67') ? noFail(s) : 'маска не сработала'));
await scenario('form', '/form', (s) => (s.status === 'awaiting_approval' && !events.some((e) => e.tag === 'FORM_SUBMITTED')) || 'форма ушла без подтверждения');
await scenario('loop', '/loop', (s) => (s.status === 'failed' && /Зацикливание/.test(s.error ?? '')) || 'детектор зацикливания не сработал');
await scenario('zoom', '/zoom', (s) => s.result === 'clicked 9' || 'клик при масштабе 150% промахнулся', { zoom: 1.5 });
await scenario('blank', '/blank', (s) => s.result === 'target clicked' || 'новая вкладка не подхвачена');
await scenario('frame', '/frame-host', (s) => s.result === 'FRAME OK' || 'клик в iframe не сработал');
await scenario('shadow', '/shadow', (s) => s.result === 'shadow ok' || 'клик в shadow DOM не сработал');
await scenario('hover', '/hover', (s) => s.result === 'settings opened' || 'меню по наведению не открылось');
await scenario('modal', '/modal', (s) => s.result === 'under clicked' || 'Escape не закрыл окно');
await scenario('drag', '/drag', (s) => s.result === 'dropped' || 'перетаскивание не сработало');
await scenario('wait', '/wait', (s) => /42 товара/.test(s.result ?? '') || 'wait_for не дождался');
await scenario('area', '/area', (s) => /^box scrolled [1-9]/.test(s.result ?? '') || 'область не прокрутилась');
await scenario('shot', '/shot', (s) => /^IMAGE \d{4,}/.test(s.result ?? '') || 'скриншот не дошёл до модели', { settings: { vision: true, screenshots: 'always' } });

// Запись и повтор: агент заполняет форму, запуск сохраняется сценарием, повтор — без модели.
if (!only || only.includes('replay')) {
  const { win, state } = await scenario('macro', '/macro', (s) => s.result === 'saved Миша' || 'агент не сохранил форму', { keepWindow: true });
  let ok = false;
  let why = '';
  try {
    const saved = await bg({ type: 'bg:macro-save', runId: state.id, name: 'e2e форма' });
    if (!saved.ok) throw new Error(saved.error);
    await call(async (w, url) => {
      const [t] = await chrome.tabs.query({ windowId: w, active: true });
      await chrome.tabs.update(t.id, { url });
    }, win, `${BASE}/macro`);
    await sleep(1200);
    const llmCalls = events.length;
    const run = await bg({ type: 'bg:macro-run', id: saved.value.id, windowId: win });
    if (!run.ok) throw new Error(run.error);
    let st;
    for (let i = 0; i < 60; i++) {
      await sleep(500);
      st = (await bg({ type: 'bg:macro-get' })).value;
      if (st && st.status !== 'running') break;
    }
    const title = await call(async (w) => (await chrome.tabs.query({ windowId: w, active: true }))[0].title, win);
    ok = st?.status === 'done' && title === 'saved Миша' && events.length === llmCalls;
    why = ok ? '' : `повтор: ${st?.status} ${st?.message ?? ''}, заголовок «${title}», запросов к модели ${events.length - llmCalls}`;
    await bg({ type: 'bg:macro-delete', id: saved.value.id });
  } catch (err) {
    why = err instanceof Error ? err.message : String(err);
  }
  console.log(`${ok ? '✓' : '✗'} replay — повтор сценария без модели${why ? `\n    ${why}` : ''}`);
  results.push(ok);
  await closeWindow(win);
}

const failed = results.filter((r) => !r).length;
console.log(`\n${results.length - failed} из ${results.length} сценариев прошли`);
await browser.close();
server.close();
process.exit(failed ? 1 : 0);
