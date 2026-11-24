// Тренер 24 — ИИ: распознавание еды по фото/тексту и чат с тренером.
// Переменные окружения: OPENAI_API_KEY, BOT_TOKEN, (необязательно) OPENAI_MODEL
const crypto = require('crypto');

function checkInitData(initData, token) {
  if (!initData || !token) return null;
  const p = new URLSearchParams(initData);
  const hash = p.get('hash');
  if (!hash) return null;
  p.delete('hash');
  const dcs = [...p.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => k + '=' + v).join('\n');
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const calc = crypto.createHmac('sha256', secret).update(dcs).digest('hex');
  if (calc !== hash) return null;
  if (Date.now() / 1000 - Number(p.get('auth_date') || 0) > 7 * 86400) return null;
  try { return JSON.parse(p.get('user') || '{}'); } catch (e) { return {}; }
}

async function openai(messages, json, maxTokens) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      temperature: 0.3,
      max_tokens: maxTokens || 600,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'OpenAI error ' + r.status);
  return j.choices[0].message.content;
}

const FOOD_PROMPT = 'Ты нутрициолог. Определи блюдо и оцени порцию. Ответь строго JSON по образцу: ' +
  '{"n":"Плов с говядиной","g":300,"k":560,"p":22,"f":21,"c":70}, где n — название по-русски, g — вес всей порции в граммах, ' +
  'k — калории всей порции, p — белки, f — жиры, c — углеводы в граммах на всю порцию. Значения g,k,p,f,c — только целые числа без единиц измерения. ' +
  'Если на фото нет еды, ответь {"error":"На фото не видно еды"}.';

function cleanFood(o) {
  if (o.error) return { error: String(o.error).slice(0, 120) };
  const n = x => { const m = String(x == null ? '' : x).replace(',', '.').match(/\d+(\.\d+)?/); return m ? Math.round(parseFloat(m[0])) : 0; };
  const v = (...ks) => { for (const k of ks) if (o[k] != null) return o[k]; return 0; };
  return { n: String(o.n || o.name || 'Блюдо').slice(0, 80), g: n(v('g', 'weight', 'grams')) || 250, k: n(v('k', 'kcal', 'calories')),
    p: n(v('p', 'protein', 'proteins')), f: n(v('f', 'fat', 'fats')), c: n(v('c', 'carbs', 'carbohydrates')) };
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = req.body || {};
  const user = checkInitData(b.initData, process.env.BOT_TOKEN);
  if (!user) return res.status(401).json({ error: 'Открой приложение через Telegram-бота' });
  try {
    if (b.type === 'photo') {
      if (typeof b.image !== 'string' || !b.image.startsWith('data:image/') || b.image.length > 3e6)
        return res.status(400).json({ error: 'Нет фото' });
      const out = await openai([
        { role: 'system', content: FOOD_PROMPT },
        { role: 'user', content: [{ type: 'text', text: 'Что на тарелке?' }, { type: 'image_url', image_url: { url: b.image, detail: 'low' } }] }
      ], true, 300);
      return res.json(cleanFood(JSON.parse(out)));
    }
    if (b.type === 'text') {
      const t = String(b.text || '').slice(0, 300);
      if (!t) return res.status(400).json({ error: 'Пустое описание' });
      const out = await openai([{ role: 'system', content: FOOD_PROMPT }, { role: 'user', content: 'Я съел: ' + t }], true, 300);
      return res.json(cleanFood(JSON.parse(out)));
    }
    if (b.type === 'chat') {
      const P = b.profile || {}, N = b.norm || {}, E = b.eaten || {};
      const sys = 'Ты — ИИ-тренер приложения «Тренер 24». Отвечай по-русски, коротко (до 6 предложений), по делу, дружелюбно, на «ты». ' +
        'Помогаешь с тренировками, техникой, питанием и мотивацией. Не ставишь диагнозов; при острой боли, травме или проблемах со здоровьем советуешь обратиться к врачу. ' +
        `Данные пользователя: пол ${P.sex === 'f' ? 'женский' : 'мужской'}, возраст ${P.age}, рост ${P.h} см, вес ${P.w} кг, цель ${P.goal === 'cut' ? 'похудеть' : P.goal === 'bulk' ? 'набрать массу' : 'держать форму'} (желаемый вес ${P.goalW} кг), ` +
        `тренируется ${P.place === 'home' ? 'дома без железа' : 'в зале'}, ограничения: ${String(P.health || 'нет').slice(0, 100)}. ` +
        `Норма в день: ${N.k} ккал, белки ${N.p} г, жиры ${N.f} г, углеводы ${N.c} г. Сегодня съедено: ${E.k || 0} ккал, белки ${E.p || 0} г, жиры ${E.f || 0} г, углеводы ${E.c || 0} г.`;
      const hist = (Array.isArray(b.messages) ? b.messages : []).slice(-10)
        .map(m => ({ role: m.a ? 'assistant' : 'user', content: String(m.t || '').slice(0, 1000) }));
      const out = await openai([{ role: 'system', content: sys }, ...hist], false, 500);
      return res.json({ reply: out });
    }
    return res.status(400).json({ error: 'Неизвестный запрос' });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'ИИ временно недоступен' });
  }
};
