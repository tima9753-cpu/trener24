// Тренер 24 — Telegram-бот (webhook). Переменная окружения: BOT_TOKEN
// Один раз открыть https://<адрес>/api/bot?setup=1 — подключит webhook и кнопку меню.
const crypto = require('crypto');
const secretOf = t => crypto.createHash('sha256').update('t24' + t).digest('hex').slice(0, 40);

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}

module.exports = async (req, res) => {
  const token = process.env.BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'BOT_TOKEN не задан' });
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const app = `https://${host}/`;

  if (req.method === 'GET') {
    if (req.query && req.query.setup === '1') {
      const hook = await tg('setWebhook', { url: `https://${host}/api/bot`, secret_token: secretOf(token), allowed_updates: ['message'] });
      const menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: app } } });
      await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть Тренер 24' }] });
      return res.json({ webhook: hook.ok, menu: menu.ok, app, info: hook.description });
    }
    return res.json({ ok: true });
  }

  if (req.headers['x-telegram-bot-api-secret-token'] !== secretOf(token)) return res.status(401).end();
  const m = (req.body || {}).message;
  if (m && m.chat) {
    const name = (m.from && m.from.first_name) || '';
    await tg('sendMessage', {
      chat_id: m.chat.id,
      text: `Привет${name ? ', ' + name : ''}! 👋 Я — Тренер 24, твой ИИ-тренер в кармане.\n\n` +
        '📸 Считаю калории и БЖУ по фото еды\n🏋️ Даю программу тренировок под твою цель\n📊 Слежу за весом, водой и прогрессом\n💬 Отвечаю на вопросы 24/7\n\n' +
        'Жми кнопку ниже — займёт 1 минуту, чтобы рассчитать твой план 👇',
      reply_markup: { inline_keyboard: [[{ text: '🔥 Открыть Тренер 24', web_app: { url: app } }]] }
    });
  }
  return res.json({ ok: true });
};
