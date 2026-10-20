// Мок OpenAI-совместимого сервера + тестовые страницы для e2e и ручной отладки без настоящей модели.
// Сценарий выбирается меткой в задаче, например «[mask] ...»; ответы модели заданы кодом ниже.
import fs from 'node:fs';
import http from 'node:http';

export const events = [];
const counters = {};

const style = '<style>body{font:15px sans-serif;margin:16px} button{display:block;margin:6px 0;min-width:160px;height:30px}</style>';
const page = (title, body) => `<!doctype html><meta charset=utf-8><title>${title}</title>${style}${body}`;

export const pages = {
  '/mask': page('Mask', `
<label>Name <input id=nm placeholder="Name"></label>
<label>Phone <input id=phone placeholder="Phone"></label>
<button id=save>Сохранить</button><p id=out></p>
<script>
phone.addEventListener('input', () => {
  const d = phone.value.replace(/\\D/g, '').replace(/^7/, '').slice(0, 10);
  let s = '+7 (' + d.slice(0,3); if (d.length > 3) s += ') ' + d.slice(3,6); if (d.length > 6) s += '-' + d.slice(6,8); if (d.length > 8) s += '-' + d.slice(8,10);
  phone.value = d ? s : '';
});
save.onclick = () => { out.textContent = 'Saved: ' + nm.value + ' / ' + phone.value; };
</script>`),
  '/form': page('Feedback', `<form action="/submitted" method="get"><input name=msg placeholder="Your message"><button type=submit>Отправить</button></form>`),
  '/submitted': page('Submitted', '<p>Thanks, sent.</p>'),
  '/loop': page('Loop', '<button>Nothing</button>'),
  '/zoom': page('Zoom', Array.from({ length: 12 }, (_, i) => `<button onclick="document.title='clicked ${i + 1}'">B${i + 1}</button>`).join('')),
  '/blank': page('Blank', '<a href="/target" target="_blank">Open target</a>'),
  '/target': page('Target', `<p>target page</p><button onclick="document.title='target clicked'">Press</button>`),
  '/frame-host': page('Frames', '<p>Host</p><iframe src="http://localhost:PORT/frame-child" width=400 height=200></iframe>'),
  '/frame-child': page('Child', `<button onclick="this.textContent='Done'">Inner button</button>`),
  '/shadow': page('Shadow', `<div id=h></div><script>const r=h.attachShadow({mode:'open'});r.innerHTML='<button>Shadow btn</button>';r.querySelector('button').onclick=()=>document.title='shadow ok'</script>`),
  '/hover': page('Hover', `
<div id=menu style="display:inline-block;padding:8px;border:1px solid #888;cursor:pointer">Профиль
  <div id=sub style="display:none"><button onclick="document.title='settings opened'">Настройки</button></div>
</div>
<script>menu.addEventListener('mouseenter',()=>sub.style.display='block');menu.addEventListener('mouseleave',()=>sub.style.display='none');</script>`),
  '/modal': page('Modal', `
<button onclick="document.title='under clicked'">Под окном</button>
<div id=ov style="position:fixed;inset:0;background:rgba(0,0,0,.5)"><div style="background:#fff;margin:80px;padding:20px">Подписка! Нажмите Esc, чтобы закрыть.</div></div>
<script>addEventListener('keydown',e=>{if(e.key==='Escape')ov.remove()});</script>`),
  '/drag': page('Drag', `
<div id=card style="width:140px;padding:10px;background:#cde;cursor:grab;user-select:none" role=button>Карточка</div>
<div id=done style="margin-top:120px;width:220px;height:80px;border:2px dashed #888" role=button>Готово</div>
<script>
let dragging=false;
card.addEventListener('mousedown',()=>dragging=true);
addEventListener('mouseup',e=>{ if(!dragging) return; dragging=false; const r=done.getBoundingClientRect(); if(e.clientX>=r.left&&e.clientX<=r.right&&e.clientY>=r.top&&e.clientY<=r.bottom){done.textContent='Готово: Карточка';document.title='dropped';} });
</script>`),
  '/wait': page('Wait', `<button onclick="setTimeout(()=>out.textContent='Загружено: 42 товара',1500)">Загрузить</button><p id=out></p>`),
  '/area': page('Area', `
<div id=box style="height:150px;overflow-y:auto;border:1px solid #888">${Array.from({ length: 40 }, (_, i) => `<p style="margin:4px">Пункт ${i + 1}</p>`).join('')}<button>Последний</button></div>
<script>box.addEventListener('scroll',()=>document.title='box scrolled '+Math.round(box.scrollTop))</script>`),
  '/shot': page('Shot', '<button>Кнопка</button>'),
  '/macro': page('Macro', `<label>Имя <input id=nm></label><button onclick="out.textContent='Привет, '+nm.value;document.title='saved '+nm.value">Сохранить</button><p id=out></p>`),
};

const idx = (obs, re) => {
  for (const line of obs.split('\n')) {
    const m = /^\[(\d+)\] (.*)$/.exec(line);
    if (m && re.test(m[2])) return Number(m[1]);
  }
  return null;
};
const step = (actions, extra = {}) => ({ reasoning: 'scripted', expected_outcome: '', actions, ...extra });
const done = (result) => step([{ action: 'done', result }]);
const title = (obs) => /^Title: (.*)$/m.exec(obs)?.[1] ?? '';
/** Нужный элемент есть — действие, нет — done с MISSING (тест увидит причину). */
const need = (i, what, fn) => (i === null ? done(`MISSING ${what}`) : step(fn(i)));

export const scenarios = {
  mask(obs, n) {
    if (n === 1) {
      const a = idx(obs, /"Name"/), b = idx(obs, /"Phone"/);
      return a === null || b === null ? done('MISSING fields') : step([{ action: 'type', index: a, text: 'Misha' }, { action: 'type', index: b, text: '9991234567' }]);
    }
    if (n === 2) return need(idx(obs, /"Сохранить"/), 'save', (i) => [{ action: 'click', index: i }]);
    return done(/Saved: [^\n]*/.exec(obs)?.[0] ?? 'no saved text');
  },
  form(obs, n) {
    if (n === 1) return need(idx(obs, /"Your message"/), 'field', (i) => [{ action: 'type', index: i, text: 'hello', submit: true }]);
    return done(obs.includes('Thanks, sent') ? 'SUBMITTED' : 'not submitted');
  },
  loop: (obs) => need(idx(obs, /"Nothing"/), 'button', (i) => [{ action: 'click', index: i }]),
  zoom: (obs, n) => (n === 1 ? need(idx(obs, /"B9"/), 'B9', (i) => [{ action: 'click', index: i }]) : done(title(obs))),
  blank(obs, n) {
    if (n === 1) return need(idx(obs, /"Open target"/), 'link', (i) => [{ action: 'click', index: i }]);
    if (n === 2) return need(idx(obs, /"Press"/), 'press', (i) => [{ action: 'click', index: i }]);
    return done(title(obs));
  },
  frame: (obs, n) => (n === 1 ? need(idx(obs, /"Inner button"/), 'inner', (i) => [{ action: 'click', index: i }]) : done(obs.includes('"Done"') ? 'FRAME OK' : 'frame not changed')),
  shadow: (obs, n) => (n === 1 ? need(idx(obs, /"Shadow btn"/), 'shadow', (i) => [{ action: 'click', index: i }]) : done(title(obs))),
  hover(obs, n) {
    if (n === 1) return need(idx(obs, /Профиль/), 'menu', (i) => [{ action: 'hover', index: i }]);
    if (n === 2) return need(idx(obs, /"Настройки"/), 'submenu', (i) => [{ action: 'click', index: i }]);
    return done(title(obs));
  },
  modal(obs, n) {
    if (n === 1) return step([{ action: 'press_key', key: 'Escape' }]);
    if (n === 2) return need(idx(obs, /"Под окном"/), 'button', (i) => [{ action: 'click', index: i }]);
    return done(title(obs));
  },
  drag(obs, n) {
    if (n === 1) {
      const a = idx(obs, /"Карточка"/), b = idx(obs, /"Готово"/);
      return a === null || b === null ? done('MISSING drag elements') : step([{ action: 'drag', index: a, to_index: b }]);
    }
    return done(title(obs));
  },
  wait(obs, n) {
    if (n === 1) return need(idx(obs, /"Загрузить"/), 'button', (i) => [{ action: 'click', index: i }, { action: 'wait_for', text: 'Загружено', timeout_ms: 5000 }]);
    return done(/Загружено[^\n]*/.exec(obs)?.[0] ?? 'not loaded');
  },
  area(obs, n) {
    if (n === 1) return need(idx(obs, /"Пункт 1"|Пункт 1/) ?? idx(obs, /"Последний"/), 'item', (i) => [{ action: 'scroll', direction: 'down', amount: 1, index: i }]);
    return done(title(obs));
  },
  shot: (obs, n, req) => done(req.image ? `IMAGE ${req.image.length}` : 'NO IMAGE'),
  macro(obs, n) {
    if (n === 1) return need(idx(obs, /^input/), 'name field', (i) => [{ action: 'type', index: i, text: 'Миша' }]);
    if (n === 2) return need(idx(obs, /"Сохранить"/), 'save', (i) => [{ action: 'click', index: i }]);
    return done(title(obs));
  },
};

function sse(res, content) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const p of content.match(/.{1,20}/gs) ?? []) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`);
  res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 20 } })}\n\n`);
  res.end('data: [DONE]\n\n');
}

const textOf = (content) => (typeof content === 'string' ? content : content.filter((p) => p.type === 'text').map((p) => p.text).join('\n'));
const imageOf = (content) => (typeof content === 'string' ? null : content.find((p) => p.type === 'image_url')?.image_url.url ?? null);

export function start(port) {
  const server = http.createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    res.setHeader('Access-Control-Allow-Origin', '*');
    if (req.method === 'OPTIONS') {
      res.setHeader('Access-Control-Allow-Headers', '*');
      return res.end();
    }
    if (url.pathname === '/v1/models') return res.end(JSON.stringify({ data: [{ id: 'mock' }] }));
    if (url.pathname === '/v1/chat/completions') {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        const j = JSON.parse(body);
        const userMsg = j.messages.find((m) => m.role === 'user');
        const user = textOf(userMsg.content);
        const image = imageOf(userMsg.content);
        const tag = /\[([a-z]+)\]/.exec(user)?.[1];
        const obs = /BEGIN PAGE \w+ =====\n([\s\S]*?)\n===== END PAGE/.exec(user)?.[1] ?? '';
        const key = `${tag}#${/run=(\d+)/.exec(user)?.[1] ?? ''}`;
        counters[key] = (counters[key] ?? 0) + 1;
        const n = counters[key];
        events.push({ tag, n, obs, image: !!image });
        // E2E_SHOT_DIR=папка — сохранить скриншоты, которые получила «модель» (для отладки).
        if (image && process.env.E2E_SHOT_DIR) fs.writeFileSync(`${process.env.E2E_SHOT_DIR}/${tag}-${n}.jpg`, Buffer.from(image.split(',')[1], 'base64'));
        const fn = scenarios[tag];
        const out = fn ? fn(obs, n, { image }) : done(`mock: нет сценария для задачи. Метки: ${Object.keys(scenarios).map((s) => `[${s}]`).join(' ')}`);
        sse(res, JSON.stringify(out));
      });
      return;
    }
    if (url.pathname === '/submitted') events.push({ tag: 'FORM_SUBMITTED' });
    if (url.pathname === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(page('Mock pages', `<h3>Тестовые страницы</h3><ul>${Object.keys(pages).map((p) => `<li><a href="${p}">${p}</a> — задача «[${p.slice(1).replace('frame-host', 'frame').replace('blank', 'blank')}] …»</li>`).join('')}</ul>`));
    }
    const html = pages[url.pathname];
    if (html) {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      return res.end(html.replace('PORT', String(port)));
    }
    res.statusCode = 404;
    res.end('not found');
  });
  return new Promise((r) => server.listen(port, '127.0.0.1', () => r(server)));
}

// Запуск напрямую: `npm run mock-llm` — сервер для ручной отладки расширения.
if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.env.PORT ?? 18080);
  await start(port);
  console.log(`Мок модели: http://127.0.0.1:${port}  (в настройках профиля: адрес http://127.0.0.1:${port}, модель mock)`);
  console.log(`Тестовые страницы: http://127.0.0.1:${port}/`);
}
