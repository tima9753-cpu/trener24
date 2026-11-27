// Тренер 24 — Telegram-бот (webhook) + сообщество.
// Переменные окружения: BOT_TOKEN, OPENAI_API_KEY; необязательно CRON_SECRET, BOT_USERNAME.
// Один раз открыть https://<адрес>/api/bot?setup=1 — подключит webhook, кнопку меню и команды.
// Ежедневные посты в группы запускает cron Vercel: /api/bot?cron=1 (см. vercel.json).
const crypto = require('crypto');
const secretOf = t => crypto.createHash('sha256').update('t24' + t).digest('hex').slice(0, 40);

/* ---------- настройки сообщества ----------
   id группы узнать так: добавить бота в группу админом и написать там /id.
   Ссылки — «Пригласительная ссылка» из настроек группы. */
const COMMUNITY = {
  open: { id: process.env.GROUP_ID || '-1005846624298', link: process.env.GROUP_LINK || 'https://t.me/+-h81Nt0KHR01NjZi', thread: +process.env.GROUP_THREAD || 0 },
  news: { id: process.env.NEWS_ID || '-1005811785963', link: process.env.NEWS_LINK || 'https://t.me/+rcig49zSCe44YjUy', thread: 0 },
  support: { id: process.env.SUPPORT_ID || '-5277222877', link: '', thread: 0 },
  pro: { id: process.env.PRO_ID || '-1006045569304', link: process.env.PRO_LINK || 'https://t.me/+nwI91ban-4E1YWEy', thread: +process.env.PRO_THREAD || 0 }
};
// Пока нет оплаты: true — в PRO-чат пускаем всех по заявке (тестовый период).
const PRO_OPEN = process.env.PRO_OPEN !== '0';
const BOT = process.env.BOT_USERNAME || 'trener24sportlivebot';

async function tg(method, body) {
  const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  });
  return r.json();
}
const esc = s => String(s == null ? '' : s).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
const kindOf = id => (String(id) === String(COMMUNITY.open.id) ? 'open' : String(id) === String(COMMUNITY.pro.id) ? 'pro' : String(id) === String(COMMUNITY.support.id) ? 'support' : '');
const botBtn = (text, start) => ({ text, url: `https://t.me/${BOT}?start=${start || 'group'}` });

async function ai(system, user, maxTokens, json) {
  // На российском сервере ключа OpenAI нет: идём через посредника на Vercel, подписывая запрос токеном бота.
  if (!process.env.OPENAI_API_KEY && process.env.AI_PROXY) {
    try {
      const sig = require('crypto').createHmac('sha256', process.env.BOT_TOKEN || '').update('t24-proxy').digest('hex');
      const r = await fetch(process.env.AI_PROXY, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-t24-proxy': sig },
        body: JSON.stringify({ type: 'raw', system, user, maxTokens: maxTokens || 500, json: !!json }) });
      const j = await r.json();
      return j.out == null ? null : json ? JSON.parse(j.out) : j.out;
    } catch (e) { return null; }
  }
  if (!process.env.OPENAI_API_KEY) return null;
  try {
    const r = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
      body: JSON.stringify({
        model: process.env.OPENAI_MODEL || 'gpt-4o-mini', temperature: 0.8, max_tokens: maxTokens || 500,
        messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
        ...(json ? { response_format: { type: 'json_object' } } : {})
      })
    });
    const j = await r.json();
    const t = j.choices && j.choices[0] && j.choices[0].message.content;
    return json ? JSON.parse(t) : t;
  } catch (e) { return null; }
}

/* ---------- ежедневные посты ---------- */
const FALLBACK = [
  { title: 'Всё тело за 20 минут', ex: [['Приседания', '3×15'], ['Отжимания (можно с колен)', '3×10'], ['Ягодичный мост', '3×15'], ['Планка', '3×30 сек'], ['Выпады', '3×10 на ногу']], tip: 'Отдых между подходами 45–60 секунд. Спина ровная в каждом упражнении.' },
  { title: 'Ноги и ягодицы дома', ex: [['Приседания', '4×15'], ['Выпады назад', '3×12 на ногу'], ['Ягодичный мост на одной ноге', '3×10'], ['Подъём на носки', '3×20']], tip: 'Колени идут по линии носков, не заваливаются внутрь.' },
  { title: 'Верх тела без инвентаря', ex: [['Отжимания', '4×max'], ['Обратные отжимания от стула', '3×12'], ['Лодочка', '3×12'], ['Мёртвый жук', '3×10 на сторону']], tip: 'Если отжимания тяжело — делай от стола или с колен, это тоже засчитывается.' }
];
async function workout(day) {
  const r = await ai('Ты — тренер приложения «Тренер 24». Пишешь «Тренировку дня» для Telegram-сообщества новичков и среднего уровня. Только домашние упражнения без инвентаря или с гантелями, безопасные, с понятной дозировкой. Ответ — строго JSON.',
    `День недели: ${day}. Придумай тренировку на 20–30 минут. JSON: {"title":"название до 40 символов","ex":[["упражнение","подходы×повторы"]],"tip":"один совет по технике до 140 символов","food":"совет по питанию дня до 160 символов"}. Упражнений 4–6.`, 500, true);
  if (r && Array.isArray(r.ex) && r.ex.length) return r;
  return FALLBACK[Math.floor(Date.now() / 864e5) % FALLBACK.length];
}
async function challenge() {
  const r = await ai('Ты — тренер приложения «Тренер 24». Придумываешь челлендж недели для фитнес-сообщества: простой, измеримый, выполнимый новичком за 7 дней, без риска для здоровья. Ответ — строго JSON.',
    'JSON: {"title":"название до 40 символов","rules":["3 коротких правила"],"tag":"#хэштег_одним_словом"}', 300, true);
  return (r && r.title && Array.isArray(r.rules)) ? r : { title: '7 дней по 8 000 шагов', rules: ['Каждый день проходи минимум 8 000 шагов', 'Вечером присылай скрин шагомера в тему «Мой прогресс»', 'Пропустил день — догоняй на следующий, сдаваться нельзя'], tag: '#челлендж' };
}
async function postTo(kind, payload) {
  const c = COMMUNITY[kind];
  if (!c.id) return { kind, skipped: true };
  const base = { chat_id: c.id, ...(c.thread ? { message_thread_id: c.thread } : {}) };
  const r = await tg(payload.method || 'sendMessage', { ...base, ...payload.body });
  return { kind, ok: r.ok, err: r.description };
}
async function daily() {
  const now = new Date(Date.now() + 5 * 3600e3); // Екатеринбург/Оренбург, UTC+5
  const dow = now.getUTCDay(), days = ['воскресенье', 'понедельник', 'вторник', 'среда', 'четверг', 'пятница', 'суббота'];
  const kb = { inline_keyboard: [[botBtn('🔥 Открыть Тренер 24', 'daily')]] };
  if (dow === 0) {
    const poll = an => ({ method: 'sendPoll', body: { question: 'Сколько тренировок было у тебя на этой неделе?', options: [{ text: '0 — начну с понедельника' }, { text: '1–2' }, { text: '3–4' }, { text: '5 и больше 💪' }], is_anonymous: an } });
    return Promise.all([postTo('news', poll(true)), postTo('pro', poll(false))]); // в канале опрос только анонимный
  }
  if (dow === 1) {
    const c = await challenge();
    const text = `🏆 <b>Челлендж недели: ${esc(c.title)}</b>\n\n${c.rules.map((r, i) => `${i + 1}. ${esc(r)}`).join('\n')}\n\nОтчитывайся с хэштегом ${esc(c.tag)} — в воскресенье подведём итоги!`;
    return Promise.all(['news', 'pro'].map(k => postTo(k, { body: { text, parse_mode: 'HTML', reply_markup: kb } })));
  }
  const w = await workout(days[dow]);
  const list = w.ex.map(([n, d]) => `• ${esc(n)} — <b>${esc(d)}</b>`).join('\n');
  const open = `💪 <b>Тренировка дня: ${esc(w.title)}</b>\n\n${list}\n\n💡 ${esc(w.tip)}\n\nСделал — поставь 🔥 под этим постом!`;
  const pro = open + (w.food ? `\n\n🥗 <b>Питание дня:</b> ${esc(w.food)}` : '') + `\n\nЕсть вопрос по технике — отметь @${BOT} в сообщении, отвечу здесь.`;
  return Promise.all([postTo('news', { body: { text: open, parse_mode: 'HTML', reply_markup: kb } }), postTo('pro', { body: { text: pro, parse_mode: 'HTML', reply_markup: kb } })]);
}

/* ---------- обработка сообщений ---------- */
const COACH = 'Ты — Тренер 24, ИИ-тренер в чате фитнес-сообщества. Отвечай по-русски, коротко (до 600 символов), дружелюбно и по делу: тренировки, техника, питание, восстановление, мотивация. ' +
  'Вопросы не о фитнесе и здоровом образе жизни мягко возвращай к теме. Не ставь диагнозы и не назначай лекарства: при боли, травмах и болезнях советуй обратиться к врачу. Не обещай быстрых результатов. Без markdown.';
const isAdmin = async (chatId, userId) => {
  const r = await tg('getChatMember', { chat_id: chatId, user_id: userId });
  return r.ok && ['creator', 'administrator'].includes(r.result.status);
};
const hasLink = m => (m.entities || m.caption_entities || []).some(e => ['url', 'text_link'].includes(e.type)) || /(https?:\/\/|t\.me\/|www\.)/i.test(m.text || m.caption || '') || !!(m.forward_origin && m.forward_origin.type === 'channel');

async function onGroup(m) {
  const chat = m.chat.id, kind = kindOf(chat), text = m.text || m.caption || '', thread = m.is_topic_message ? { message_thread_id: m.message_thread_id } : {};
  if (/^\/id(@\w+)?\b/.test(text)) {
    return tg('sendMessage', { chat_id: chat, ...thread, text: `id этой группы: ${chat}${m.message_thread_id ? `\nid этой темы: ${m.message_thread_id}` : ''}` });
  }
  if (!kind) return; // бот в чужой группе — молчим
  if (kind === 'support') return onSupportReply(m);
  if (m.new_chat_members || m.left_chat_member) {
    await tg('deleteMessage', { chat_id: chat, message_id: m.message_id });
    if (m.new_chat_members) {
      const names = m.new_chat_members.filter(u => !u.is_bot).map(u => esc(u.first_name)).join(', ');
      if (names) await tg('sendMessage', { chat_id: chat, parse_mode: 'HTML', text: kind === 'pro'
        ? `👋 ${names}, добро пожаловать в <b>Тренер 24 PRO</b>!\n\nЗдесь челленджи, разборы техники и ответы тренера: отметь @${BOT} в сообщении — отвечу. Начни с темы «Мой прогресс»: напиши свою цель 🎯`
        : `👋 ${names}, добро пожаловать в сообщество <b>Тренер 24</b>!\n\nКаждый день здесь тренировка дня, по понедельникам — челлендж. Расскажи в «Новичках», какая у тебя цель 🎯` });
    }
    return;
  }
  if (kind === 'open' && hasLink(m) && !(await isAdmin(chat, m.from.id))) {
    return tg('deleteMessage', { chat_id: chat, message_id: m.message_id });
  }
  const mentioned = text.toLowerCase().includes('@' + BOT.toLowerCase()) || (m.reply_to_message && m.reply_to_message.from && m.reply_to_message.from.username === BOT);
  if (!mentioned || !text.trim()) return;
  if (kind === 'open') {
    return tg('sendMessage', { chat_id: chat, ...thread, reply_to_message_id: m.message_id, text: 'Ответы тренера прямо в чате — для участников PRO. Пока задай вопрос мне в личке — там я отвечу 👇', reply_markup: { inline_keyboard: [[botBtn('💬 Спросить тренера', 'ask')]] } });
  }
  await tg('sendChatAction', { chat_id: chat, ...thread, action: 'typing' });
  const q = text.replace(new RegExp('@' + BOT, 'ig'), '').trim().slice(0, 1200);
  const ctx = m.reply_to_message && m.reply_to_message.text ? `Сообщение, на которое отвечают: «${m.reply_to_message.text.slice(0, 600)}»\n` : '';
  const a = await ai(COACH, ctx + `Вопрос от ${m.from.first_name || 'участника'}: ${q}`, 400);
  return tg('sendMessage', { chat_id: chat, ...thread, reply_to_message_id: m.message_id, text: a || 'Сейчас не получилось ответить — попробуй чуть позже 🙏' });
}

/* ---------- поддержка: клиент пишет боту → сообщение в группу поддержки → ответ реплаем уходит клиенту ---------- */
const SUP_ON = () => /^-?\d+$/.test(String(COMMUNITY.support.id));
async function toSupport(m) {
  const f = m.from || {}, head = `🆘 ${esc(f.first_name || '')} ${esc(f.last_name || '')}${f.username ? ' @' + esc(f.username) : ''} · id:${f.id}`;
  const note = '\n\n<i>Ответь реплаем на это сообщение — ответ уйдёт клиенту</i>';
  const sid = COMMUNITY.support.id;
  let r;
  if (m.text) r = await tg('sendMessage', { chat_id: sid, parse_mode: 'HTML', text: `${head}\n\n${esc(m.text).slice(0, 3500)}${note}` });
  else r = await tg('copyMessage', { chat_id: sid, from_chat_id: m.chat.id, message_id: m.message_id, parse_mode: 'HTML', caption: `${head}${m.caption ? '\n\n' + esc(m.caption).slice(0, 800) : ''}${note}` });
  return tg('sendMessage', { chat_id: m.chat.id, text: r && r.ok ? '✅ Передал в поддержку. Ответ придёт сюда, обычно в течение дня. Можешь дописать подробности или прислать скриншот.' : 'Не получилось отправить в поддержку — попробуй через пару минут 🙏' });
}
async function onSupportReply(m) {
  const rt = m.reply_to_message;
  if (!rt || !rt.from || rt.from.username !== BOT) return;
  const id = ((rt.text || rt.caption || '').match(/id:(\d+)/) || [])[1];
  if (!id) return;
  let r;
  if (m.text) r = await tg('sendMessage', { chat_id: id, text: '💬 Поддержка Тренер 24:\n\n' + m.text.slice(0, 3800) });
  else r = await tg('copyMessage', { chat_id: id, from_chat_id: m.chat.id, message_id: m.message_id });
  if (r && r.ok) return tg('setMessageReaction', { chat_id: m.chat.id, message_id: m.message_id, reaction: [{ type: 'emoji', emoji: '👍' }] });
  return tg('sendMessage', { chat_id: m.chat.id, reply_to_message_id: m.message_id, text: 'Не доставлено: ' + (r && r.description || 'ошибка') });
}

async function onJoinRequest(j) {
  if (kindOf(j.chat.id) !== 'pro') return;
  if (PRO_OPEN) {
    await tg('approveChatJoinRequest', { chat_id: j.chat.id, user_id: j.from.id });
    return tg('sendMessage', { chat_id: j.user_chat_id, text: '✅ Ты в Тренер 24 PRO! Сейчас доступ бесплатный — это тестовый период. Загляни в чат и напиши свою цель 🎯' });
  }
  // TODO: после подключения оплаты — одобрять, только если подписка активна (проверка по базе).
  return tg('sendMessage', { chat_id: j.user_chat_id, text: '🔒 Тренер 24 PRO — закрытый чат для подписчиков. Оформи подписку в приложении, и заявка одобрится автоматически.', reply_markup: { inline_keyboard: [[botBtn('Открыть Тренер 24', 'pro')]] } });
}

/* ---------- бот сам считает калории в чате: фото еды, текст, штрихкод ---------- */
const BOTLIM = new Map();
function botLimited(uid, kind, max) {
  const k = uid + ':' + kind + ':' + new Date().toISOString().slice(0, 10), n = (BOTLIM.get(k) || 0) + 1;
  if (BOTLIM.size > 20000) BOTLIM.clear(); BOTLIM.set(k, n); return n > max;
}
// Запрос к ИИ-модулю: на Vercel — к себе же, на своём сервере — через посредника. Подпись HMAC от токена, без имени и ID.
async function foodAPI(body, host) {
  const url = process.env.AI_PROXY || `https://${host}/api/ai`;
  const sig = crypto.createHmac('sha256', process.env.BOT_TOKEN || '').update('t24-proxy').digest('hex');
  try {
    const ac = new AbortController(), t = setTimeout(() => ac.abort(), 50000);
    const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-t24-proxy': sig }, body: JSON.stringify(body), signal: ac.signal });
    clearTimeout(t);
    const j = await r.json().catch(() => ({}));
    return r.ok ? j : { error: j.error || 'ИИ недоступен' };
  } catch (e) { return { error: 'ИИ недоступен' }; }
}
async function photoData(m) {
  const best = m.photo.filter(p => Math.max(p.width, p.height) <= 1280).pop() || m.photo[0];
  const f = await tg('getFile', { file_id: best.file_id });
  if (!f.ok) return '';
  const r = await fetch(`https://api.telegram.org/file/bot${process.env.BOT_TOKEN}/${f.result.file_path}`);
  if (!r.ok) return '';
  return 'data:image/jpeg;base64,' + Buffer.from(await r.arrayBuffer()).toString('base64');
}
const R0 = x => Math.round(+x || 0), R1 = x => Math.round((+x || 0) * 10) / 10;
function foodReply(o, exact) {
  const items = (o.items || []).filter(x => x.g > 0);
  const lines = items.map(x => `• ${x.n} — ${R0(x.g)} г → ${R0(x.k100 * x.g / 100)} ккал`);
  return `🍽 ${o.n || 'Блюдо'}\n\n` + (lines.length ? lines.join('\n') + '\n\n' : '') +
    `Итого: ${R0(o.k)} ккал · ${R0(o.g)} г\nБ ${R0(o.p)} · Ж ${R0(o.f)} · У ${R0(o.c)}` + (o.ask ? `\n\n❓ ${o.ask}` : '') +
    (exact ? '\n\nПосчитал по твоим граммам.' : '\n\nВес я оцениваю на глаз. Знаешь граммы — напиши так: «гречка 180 г, курица 150 г», посчитаю точно.') + ' Чтобы сохранить в дневник, добавь блюдо в приложении 👇';
}
function packReply(o) {
  return `🏷 ${o.n || 'Продукт'}${o.code ? ` (штрихкод ${o.code})` : ''}\n\nНа 100 г: ${R0(o.k100)} ккал · Б ${R1(o.p100)} · Ж ${R1(o.f100)} · У ${R1(o.c100)}\n\n` +
    [50, 100, 200].map(g => `${g} г → ${R0(o.k100 * g / 100)} ккал`).join('\n') +
    `\n\n${o.src === 'label' ? 'Значения прочитал с этикетки.' : 'Данные из базы Open Food Facts — сверь с упаковкой.'} Напиши, сколько граммов съел, например «${(o.n || 'продукт').split(' · ')[0].toLowerCase()} 120 г» — посчитаю.`;
}
const isQuestion = t => /\?|^(как|что|почему|зачем|сколько|можно|какой|какая|какие|когда|где|посоветуй|подскажи|помоги|составь|расскажи|объясни|нужно ли|стоит ли|привет|здравствуй|спасибо)/i.test(t.trim());
async function onFood(m, host, rows) {
  const chat = m.chat.id, uid = m.from && m.from.id || chat, txt = (m.text || m.caption || '').trim();
  const kb = { reply_markup: { inline_keyboard: rows } };
  if (m.photo) {
    if (botLimited(uid, 'photo', 20)) return tg('sendMessage', { chat_id: chat, text: 'На сегодня лимит фото исчерпан (20). Опиши блюдо словами — посчитаю.' });
    await tg('sendChatAction', { chat_id: chat, action: 'typing' });
    const img = await photoData(m);
    if (!img) return tg('sendMessage', { chat_id: chat, text: 'Не получилось скачать фото — пришли его ещё раз.' });
    const pack = /штрих|этикет|упаков|состав|кбжу|баркод|barcode/i.test(txt);
    if (!pack) {
      const r = await foodAPI({ type: 'photo', image: img, hint: txt.slice(0, 200) }, host);
      if (r && !r.error && r.k) return tg('sendMessage', { chat_id: chat, text: foodReply(r), ...kb });
    }
    const b = await foodAPI({ type: 'barcode', image: img }, host);
    if (b && b.found) return tg('sendMessage', { chat_id: chat, text: packReply(b), ...kb });
    if (b && b.error === 'ИИ недоступен') return tg('sendMessage', { chat_id: chat, text: 'ИИ сейчас не отвечает 😔 Попробуй через минуту или опиши блюдо словами.' });
    return tg('sendMessage', { chat_id: chat, text: b && b.code ? `Штрихкод ${b.code} не нашёл в базе. Сфотографируй таблицу «Пищевая ценность» на упаковке — прочитаю с неё.` : 'Не разобрал, что на фото. Сфотографируй тарелку сверху при хорошем свете или опиши словами: «плов 300 г, салат 150 г».' });
  }
  if (!txt) return;
  if (/^\d{8,14}$/.test(txt.replace(/\s/g, ''))) {
    if (botLimited(uid, 'text', 60)) return tg('sendMessage', { chat_id: chat, text: 'На сегодня лимит запросов исчерпан — продолжим завтра.' });
    const b = await foodAPI({ type: 'barcode', code: txt.replace(/\s/g, '') }, host);
    return tg('sendMessage', { chat_id: chat, text: b && b.found ? packReply(b) : 'Такого штрихкода нет в базе. Сфотографируй таблицу «Пищевая ценность» на упаковке — прочитаю с неё.', ...(b && b.found ? kb : {}) });
  }
  await tg('sendChatAction', { chat_id: chat, action: 'typing' });
  if (!isQuestion(txt)) {
    if (botLimited(uid, 'text', 60)) return tg('sendMessage', { chat_id: chat, text: 'На сегодня лимит запросов исчерпан — продолжим завтра.' });
    const r = await foodAPI({ type: 'text', text: txt.slice(0, 300) }, host);
    if (r && !r.error && r.k) return tg('sendMessage', { chat_id: chat, text: foodReply(r, /\d\s*(г|гр|грамм\S*|кг|мл|л|шт)(?![а-яё])/i.test(txt)), ...kb });
  }
  if (botLimited(uid, 'chat', 40)) return tg('sendMessage', { chat_id: chat, text: 'Давай продолжим завтра — на сегодня лимит вопросов исчерпан. В приложении есть ИИ-тренер с полным контекстом твоего плана 👇', ...kb });
  const a = await ai(COACH + ' Это личный чат с пользователем приложения. Если просят рацион или программу — дай короткий пример и скажи, что полный план под его норму есть в приложении.', 'Вопрос: ' + txt.slice(0, 1200), 500);
  return tg('sendMessage', { chat_id: chat, text: a || 'Сейчас не получилось ответить — попробуй чуть позже 🙏', ...kb });
}

async function onPrivate(m, app, host) {
  const name = (m.from && m.from.first_name) || '';
  const rows = [[{ text: '🔥 Открыть Тренер 24', web_app: { url: app } }]];
  const comm = [];
  if (COMMUNITY.news.link) comm.push({ text: '📢 Канал новостей', url: COMMUNITY.news.link });
  if (COMMUNITY.pro.link) comm.push({ text: '⭐ PRO-чат', url: COMMUNITY.pro.link });
  if (comm.length) rows.push(comm);
  const txt = m.text || '';
  if (/^\/(start support|support)/.test(txt)) {
    return tg('sendMessage', { chat_id: m.chat.id, text: '💬 Поддержка Тренер 24\n\nНапиши свой вопрос ответом на это сообщение — можно с фото или скриншотом. Я передам его команде, ответ придёт сюда же.', reply_markup: { force_reply: true, input_field_placeholder: 'Опиши, что случилось' } });
  }
  const rt = m.reply_to_message;
  if (SUP_ON() && rt && rt.from && rt.from.username === BOT && /^💬 Поддержка Тренер 24/.test(rt.text || '')) return toSupport(m);
  if (m.photo || (txt && !txt.startsWith('/'))) return onFood(m, host, rows);
  if (/^\/(chat|community)/.test(txt)) {
    return tg('sendMessage', { chat_id: m.chat.id, text: comm.length ? 'Канал «Тренер 24»: тренировка дня, челленджи и новости приложения 💪' : 'Сообщество скоро откроется — следи за новостями!', reply_markup: { inline_keyboard: rows.slice(1).length ? rows.slice(1) : rows } });
  }
  return tg('sendMessage', {
    chat_id: m.chat.id,
    text: `Привет${name ? ', ' + name : ''}! 👋 Я — Тренер 24, твой ИИ-тренер в кармане.\n\n` +
      '📸 Считаю калории и БЖУ по фото еды — можно прямо здесь, пришли фото или напиши «гречка 200 г»\n🏷 Пришли фото штрихкода или этикетки — найду КБЖУ продукта\n🏋️ Даю программу тренировок под твою цель\n📊 Слежу за весом, водой и прогрессом\n💬 Отвечаю на вопросы 24/7\n\n' +
      'Жми кнопку ниже — займёт 1 минуту, чтобы рассчитать твой план 👇',
    reply_markup: { inline_keyboard: rows }
  });
}

module.exports = async (req, res) => {
  const token = process.env.BOT_TOKEN;
  if (!token) return res.status(500).json({ error: 'BOT_TOKEN не задан' });
  const host = req.headers['x-forwarded-host'] || req.headers.host;
  const app = process.env.APP_URL || `https://${host}/`;
  const q = req.query || {};

  if (req.method === 'GET') {
    if (q.cfg === '1') return res.json({ open: COMMUNITY.open.link, news: COMMUNITY.news.link, pro: COMMUNITY.pro.link });
    if (q.cron === '1') {
      const auth = req.headers.authorization || '', ua = req.headers['user-agent'] || '';
      const okCron = process.env.CRON_SECRET ? auth === 'Bearer ' + process.env.CRON_SECRET : /vercel-cron/i.test(ua);
      if (!okCron) return res.status(401).end();
      return res.json({ posted: await daily() });
    }
    if (q.setup === '1') {
      const hook = await tg('setWebhook', { url: `https://${host}/api/bot`, secret_token: secretOf(token), allowed_updates: ['message', 'chat_join_request'] });
      const menu = await tg('setChatMenuButton', { menu_button: { type: 'web_app', text: 'Открыть', web_app: { url: app } } });
      await tg('setMyCommands', { commands: [{ command: 'start', description: 'Открыть Тренер 24' }, { command: 'support', description: 'Написать в поддержку' }, { command: 'chat', description: 'Канал и PRO-чат' }] });
      return res.json({ webhook: hook.ok, menu: menu.ok, app, info: hook.description });
    }
    return res.json({ ok: true });
  }

  if (req.headers['x-telegram-bot-api-secret-token'] !== secretOf(token)) return res.status(401).end();
  const u = req.body || {};
  try {
    if (u.chat_join_request) await onJoinRequest(u.chat_join_request);
    const m = u.message;
    if (m && m.chat) {
      if (m.chat.type === 'private') await onPrivate(m, app, host);
      else if (m.chat.type === 'group' || m.chat.type === 'supergroup') await onGroup(m);
    }
  } catch (e) { console.error(e); }
  return res.json({ ok: true });
};
