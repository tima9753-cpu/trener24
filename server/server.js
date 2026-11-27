// Тренер 24 — сервер в России: мини-приложение, бот, база пользователей.
// Запросы к ИИ уходят через посредника на Vercel (OpenAI не работает с российских адресов),
// посредник ничего не хранит. Все данные пользователей лежат только здесь, в SQLite.
//
// Переменные окружения (.env рядом с этим файлом):
//   BOT_TOKEN      — токен бота от @BotFather (обязательно)
//   APP_URL        — адрес мини-приложения, например https://trener24app.ru/app/
//   AI_PROXY       — адрес посредника ИИ, по умолчанию https://trener24.vercel.app/api/ai
//   CRON_SECRET    — случайная строка для ежедневных постов
//   DB_PATH        — путь к базе, по умолчанию ./data/trener24.sqlite
//   PORT           — порт, по умолчанию 3000
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const express = require('express');
const Database = require('better-sqlite3');

(() => { // простой загрузчик .env без зависимостей
  const f = path.join(__dirname, '.env');
  if (!fs.existsSync(f)) return;
  for (const line of fs.readFileSync(f, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)\s*$/);
    if (m && process.env[m[1]] === undefined) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
})();

const ROOT = path.join(__dirname, '..');
const PORT = +process.env.PORT || 3000;
const AI_PROXY = process.env.AI_PROXY || 'https://trener24.vercel.app/api/ai';
const TOKEN = process.env.BOT_TOKEN || '';
const PROXY_SIG = crypto.createHmac('sha256', TOKEN).update('t24-proxy').digest('hex');

/* ---------- база ---------- */
const dbFile = process.env.DB_PATH || path.join(__dirname, 'data', 'trener24.sqlite');
fs.mkdirSync(path.dirname(dbFile), { recursive: true });
const db = new Database(dbFile);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  tg_id INTEGER PRIMARY KEY,
  first_name TEXT, username TEXT, lang TEXT,
  ref TEXT,                       -- код блогера, по которому пришёл
  consent_at INTEGER,             -- когда дал согласие на обработку данных
  created_at INTEGER NOT NULL, last_seen INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS kv (   -- данные приложения: профиль, дневник, тренировки (JSON)
  tg_id INTEGER NOT NULL REFERENCES users(tg_id) ON DELETE CASCADE,
  k TEXT NOT NULL, v TEXT NOT NULL, t INTEGER NOT NULL,
  PRIMARY KEY (tg_id, k)
);
CREATE TABLE IF NOT EXISTS usage (  -- счётчики запросов к ИИ (без содержимого)
  tg_id INTEGER NOT NULL, type TEXT NOT NULL, day TEXT NOT NULL, n INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (tg_id, type, day)
);
CREATE TABLE IF NOT EXISTS subs (   -- подписки (заполнится после подключения ЮKassa)
  tg_id INTEGER PRIMARY KEY REFERENCES users(tg_id) ON DELETE CASCADE,
  plan TEXT, paid_until INTEGER, updated_at INTEGER
);
CREATE TABLE IF NOT EXISTS payments (
  id TEXT PRIMARY KEY, tg_id INTEGER, amount INTEGER, plan TEXT, status TEXT, ref TEXT, created_at INTEGER
);
`);

const SYNCK = new Set(['p', 'log', 'wh', 'done', 'ws', 'wl', 'prd', 'mp', 'bm', 'chk', 'inv', 'prem']);
const now = () => Date.now();
const today = () => new Date(Date.now() + 5 * 3600e3).toISOString().slice(0, 10); // сутки по UTC+5

/* ---------- проверка, что запрос пришёл из Telegram ---------- */
function checkInitData(initData) {
  if (!initData || !TOKEN) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(TOKEN).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc.length !== hash.length || !crypto.timingSafeEqual(Buffer.from(calc), Buffer.from(hash))) return null;
  if (now() / 1000 - Number(p.get('auth_date') || 0) > 7 * 86400) return null;
  try { const u = JSON.parse(p.get('user') || '{}'); return u && u.id ? { ...u, start: p.get('start_param') || '' } : null; } catch (e) { return null; }
}
const upsertUser = db.prepare(`INSERT INTO users (tg_id, first_name, username, lang, ref, created_at, last_seen)
  VALUES (@id, @first_name, @username, @language_code, @ref, @t, @t)
  ON CONFLICT(tg_id) DO UPDATE SET first_name=excluded.first_name, username=excluded.username, lang=excluded.lang, last_seen=excluded.last_seen`);
function touch(u) {
  const ref = /^ref_([a-z0-9_]{2,32})$/i.test(u.start || '') ? u.start.slice(4).toLowerCase() : null;
  upsertUser.run({ id: u.id, first_name: String(u.first_name || '').slice(0, 64), username: String(u.username || '').slice(0, 64), language_code: String(u.language_code || '').slice(0, 8), ref, t: now() });
}
function auth(req, res) {
  const u = checkInitData((req.body || {}).initData);
  if (!u) { res.status(401).json({ error: 'Открой приложение через Telegram-бота' }); return null; }
  touch(u);
  return u;
}

/* ---------- лимиты на ИИ: хранятся в базе, сутки по Оренбургу ---------- */
const LIM = { photo: 30, machine: 20, text: 60, chat: 150, program: 8, meal: 8, barcode: 40 };
const AI_TYPES = new Set(['photo', 'machine', 'text', 'chat', 'program', 'meal', 'barcode']); // что приложение может просить у ИИ
const getUse = db.prepare('SELECT n FROM usage WHERE tg_id=? AND type=? AND day=?');
const incUse = db.prepare(`INSERT INTO usage (tg_id, type, day, n) VALUES (?, ?, ?, 1)
  ON CONFLICT(tg_id, type, day) DO UPDATE SET n = n + 1`);
function overLimit(id, type) {
  const lim = LIM[type];
  if (!lim) return false;
  const r = getUse.get(id, type, today());
  return r && r.n >= lim;
}

/* ---------- приложение ---------- */
const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 'loopback');
app.use(express.json({ limit: '6mb' }));

// картинки упражнений берём из открытой базы, как на Vercel
app.get('/ex/*', (req, res) => {
  const p = req.params[0].replace(/[^A-Za-z0-9_\-./]/g, '');
  res.set('Cache-Control', 'public, max-age=604800');
  res.redirect(302, 'https://raw.githubusercontent.com/yuhonas/free-exercise-db/main/exercises/' + p);
});

// мини-приложение
app.get(['/app', '/app/'], (req, res) => {
  res.set('Cache-Control', 'no-cache');
  res.sendFile(path.join(ROOT, 'index.html'));
});

// страница, оферта, политика
const SITE = path.join(ROOT, 'site');
app.use(express.static(SITE, { extensions: ['html'], maxAge: '1h' }));

// ИИ: проверяем пользователя и лимит здесь, сам запрос — через посредника за рубежом
app.post('/api/ai', async (req, res) => {
  const b = req.body || {};
  const u = auth(req, res);
  if (!u) return;
  if (b.type === 'sub') { // подписка на канал — Telegram доступен из России напрямую
    try {
      const ch = process.env.NEWS_ID || '-1005811785963';
      const r = await (await fetch(`https://api.telegram.org/bot${TOKEN}/getChatMember?chat_id=${ch}&user_id=${u.id}`)).json();
      if (!r.ok) return res.json({ sub: null });
      const st = r.result.status;
      return res.json({ sub: ['creator', 'administrator', 'member'].includes(st) || (st === 'restricted' && !!r.result.is_member) });
    } catch (e) { return res.json({ sub: null }); }
  }
  if (!AI_TYPES.has(b.type)) return res.status(400).json({ error: 'Неизвестный запрос' });
  if (overLimit(u.id, b.type)) return res.status(429).json({ error: 'Лимит на сегодня исчерпан — попробуй завтра' });
  try {
    const ctrl = new AbortController(), timer = setTimeout(() => ctrl.abort(), 58000);
    const { initData, ...anon } = b; // за границу уходит запрос без имени и Telegram ID
    const r = await fetch(AI_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-t24-proxy': PROXY_SIG }, body: JSON.stringify(anon), signal: ctrl.signal });
    clearTimeout(timer);
    const text = await r.text();
    if (r.ok && LIM[b.type]) incUse.run(u.id, b.type, today());
    res.status(r.status).type('application/json').send(text);
  } catch (e) {
    res.status(502).json({ error: 'ИИ временно недоступен' });
  }
});

// синхронизация данных приложения: побеждает более свежая запись
const getAll = db.prepare('SELECT k, v, t FROM kv WHERE tg_id=?');
const getOne = db.prepare('SELECT t FROM kv WHERE tg_id=? AND k=?');
const putOne = db.prepare(`INSERT INTO kv (tg_id, k, v, t) VALUES (?, ?, ?, ?)
  ON CONFLICT(tg_id, k) DO UPDATE SET v=excluded.v, t=excluded.t WHERE excluded.t > kv.t`);
app.post('/api/sync', (req, res) => {
  const u = auth(req, res);
  if (!u) return;
  const set = (req.body || {}).set || {};
  let saved = 0;
  db.transaction(() => {
    for (const [k, o] of Object.entries(set)) {
      if (!SYNCK.has(k) || !o || typeof o.v !== 'string' || o.v.length > 2e6 || !(o.t > 0)) continue;
      try { JSON.parse(o.v); } catch (e) { continue; }
      const t = Math.min(+o.t, now() + 60e3);
      const cur = getOne.get(u.id, k);
      if (!cur || t > cur.t) { putOne.run(u.id, k, o.v, t); saved++; }
    }
  })();
  const out = {};
  if ((req.body || {}).get) for (const r of getAll.all(u.id)) out[r.k] = { v: r.v, t: r.t };
  res.json({ ok: true, saved, data: out });
});

// согласие на обработку персональных данных
app.post('/api/consent', (req, res) => {
  const u = auth(req, res);
  if (!u) return;
  db.prepare('UPDATE users SET consent_at=COALESCE(consent_at, ?) WHERE tg_id=?').run(now(), u.id);
  res.json({ ok: true });
});

// удаление всех данных по запросу пользователя (право по 152-ФЗ)
app.post('/api/forget', (req, res) => {
  const u = auth(req, res);
  if (!u) return;
  db.transaction(() => {
    db.prepare('DELETE FROM kv WHERE tg_id=?').run(u.id);
    db.prepare('DELETE FROM usage WHERE tg_id=?').run(u.id);
    db.prepare('DELETE FROM users WHERE tg_id=? AND tg_id NOT IN (SELECT tg_id FROM subs)').run(u.id);
  })();
  res.json({ ok: true });
});

// бот: тот же обработчик, что на Vercel
const bot = require(path.join(ROOT, 'api', 'bot.js'));
app.all('/api/bot', (req, res) => bot(req, res));

app.get('/health', (req, res) => {
  const users = db.prepare('SELECT COUNT(*) n FROM users').get().n;
  res.json({ ok: true, users });
});

/* ---------- ежедневные посты: 08:00 по Оренбургу ---------- */
let lastDaily = '';
setInterval(async () => {
  const d = new Date(Date.now() + 5 * 3600e3);
  const day = d.toISOString().slice(0, 10);
  if (d.getUTCHours() === 8 && d.getUTCMinutes() < 10 && lastDaily !== day) {
    lastDaily = day;
    try {
      await fetch(`http://127.0.0.1:${PORT}/api/bot?cron=1`, { headers: { authorization: 'Bearer ' + (process.env.CRON_SECRET || '') } });
    } catch (e) { console.error('daily', e.message); }
  }
}, 60e3).unref();

if (require.main === module) {
  if (!TOKEN) console.warn('BOT_TOKEN не задан — проверка пользователей и бот работать не будут');
  app.listen(PORT, '127.0.0.1', () => console.log('Тренер 24 слушает порт', PORT));
}
module.exports = { app, db, checkInitData };
