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

async function openai(messages, json, maxTokens, temp) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: process.env.OPENAI_MODEL || 'gpt-4o-mini',
      messages,
      temperature: temp == null ? 0.3 : temp,
      max_tokens: maxTokens || 600,
      ...(json ? { response_format: { type: 'json_object' } } : {})
    })
  });
  const j = await r.json();
  if (!r.ok) throw new Error((j.error && j.error.message) || 'OpenAI error ' + r.status);
  return j.choices[0].message.content;
}

const num = v => Math.round(+v || 0);
// Короткое описание пользователя для промптов (без лишних токенов)
const who = P => `Пол ${P.sex === 'f' ? 'женский' : 'мужской'}, ${num(P.age)} лет, рост ${num(P.h)} см, вес ${P.w} кг, желаемый ${P.goalW} кг, ` +
  `цель: ${P.goal === 'cut' ? 'похудеть' : P.goal === 'bulk' ? 'набрать массу' : 'держать форму'}, уровень ${P.levelText || '—'}, ` +
  `тренировок в неделю ${P.days || '—'}, где и с чем: ${P.equipText || '—'}, ограничения здоровья: ${P.flagsText || 'нет'}` +
  `${P.health ? '; ' + String(P.health).slice(0, 120) : ''}${P.gentle ? ' (щадящий режим)' : ''}. `;

// Статичные правила идут первым сообщением — так OpenAI кэширует их и запросы дешевле.
const CHAT_RULES = 'Ты — ИИ-тренер приложения «Тренер 24»: тренировки, техника, питание, рецепты, восстановление, сон, мотивация и режим. ' +
  'Пиши по-русски, на «ты», дружелюбно и конкретно, без воды и без markdown (никаких **, # и таблиц). ' +
  'Тема — только фитнес, питание и здоровый образ жизни. Если вопрос не по теме (политика, программирование, учёба, деньги, отношения, новости, развлечения и т. п.), не отвечай на него по существу: ' +
  'одной короткой фразой скажи, что ты фитнес-тренер, и сразу предложи что-то полезное по его цели и данным — рецепт, разбор дня или тренировку. ' +
  'Рецепты: название, ингредиенты с граммами на 1 порцию, 3–5 коротких шагов, в конце КБЖУ на порцию. Подбирай под остаток калорий и белка на сегодня и цель, ' +
  'учитывай ограничения здоровья и продукты, которые человек не ест. При диабете — без сахара, с медленными углеводами. Продукты — из обычного супермаркета. ' +
  'Следи за режимом: если в данных видно перебор калорий, мало белка или пропуски тренировок, мягко отметь это и дай один конкретный шаг. Хвали за соблюдение режима. ' +
  'Не ставь диагнозов и не назначай лекарства; при боли в груди, головокружении, острой боли или травме советуй прекратить тренировку и обратиться к врачу. ' +
  'При ограничениях здоровья — только щадящие рекомендации и совет согласовать нагрузку с врачом. Никогда не советуй тренироваться через боль, голодать ' +
  'или есть меньше 1200 ккал в день женщинам и 1500 ккал мужчинам. Длина: обычный ответ до 6 предложений, рецепт — до 15 строк.';

const MEAL_RULES = 'Ты — нутрициолог приложения «Тренер 24». Составь рацион на 7 дней (понедельник–воскресенье). В каждом дне ровно 4 приёма: Завтрак, Обед, Ужин, Перекус. ' +
  'Простые блюда из продуктов обычного российского супермаркета, разные по дням, без экзотики. Калорийность каждого дня — в пределах ±5% от нормы, белок — не ниже нормы. ' +
  'Учитывай цель, ограничения здоровья и пожелания. При диабете — без сахара, медленные углеводы. При беременности — без сырой рыбы, мяса и яиц. ' +
  'Ответь строго JSON: {"name":"короткое название","why":"1–2 предложения, на чём построен рацион","days":[{"meals":[{"m":"Завтрак","n":"блюдо","g":300,"k":450,"p":25,"f":15,"c":50,"r":"рецепт одним предложением до 90 символов"}]}],"shop":["продукт — количество на неделю"]}. ' +
  'В days ровно 7 элементов. g, k, p, f, c — целые числа: граммы порции, калории, белки, жиры, углеводы. shop — до 20 позиций.';

const FOOD_PROMPT = 'Ты опытный нутрициолог. Определи блюдо и реалистично оцени вес порции: ориентируйся на размер тарелки, столовых приборов и рук. ' +
  'Учитывай скрытые калории: масло при жарке, соусы, сахар в напитках. Если продуктов несколько, посчитай сумму по всей тарелке и перечисли их в названии через запятую. ' +
  'Ответь строго JSON по образцу: ' +
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
        { role: 'user', content: [{ type: 'text', text: 'Что на тарелке?' }, { type: 'image_url', image_url: { url: b.image, detail: 'high' } }] }
      ], true, 400);
      return res.json(cleanFood(JSON.parse(out)));
    }
    if (b.type === 'text') {
      const t = String(b.text || '').slice(0, 300);
      if (!t) return res.status(400).json({ error: 'Пустое описание' });
      const out = await openai([{ role: 'system', content: FOOD_PROMPT }, { role: 'user', content: 'Я съел: ' + t }], true, 300);
      return res.json(cleanFood(JSON.parse(out)));
    }
    if (b.type === 'program') {
      const P = b.profile || {};
      const allowed = (Array.isArray(b.allowed) ? b.allowed : []).slice(0, 150).map(x => String(x).slice(0, 60));
      if (!allowed.length) return res.status(400).json({ error: 'Нет доступных упражнений' });
      const sys = 'Ты — опытный тренер приложения «Тренер 24». Составь программу тренировок на неделю по запросу пользователя с учётом его данных. ' +
        'Используй ТОЛЬКО упражнения из этого списка, копируя названия точно: ' + allowed.join('; ') + '. ' +
        'Учитывай цель, уровень, число тренировок, инвентарь и ограничения здоровья. Если есть ограничения — умеренная нагрузка, 2–3 подхода, без опасных для этого состояния упражнений. ' +
        'Новичкам — 2–3 подхода и простые варианты. Между тренировками одних и тех же мышц — минимум 48 часов. В день 4–7 упражнений: сначала базовые, затем изолирующие, кардио — в конце. ' +
        'Ответь строго JSON: {"name":"короткое название","why":"2–3 предложения, почему программа именно такая","days":[{"dow":0,"t":"название дня","why":"почему этот день и в таком порядке","ex":[{"n":"название из списка","s":3,"r":"10–12","rest":60,"why":"зачем это упражнение, одно предложение"}]}]}. ' +
        'dow — день недели: 0 понедельник, 1 вторник, 2 среда, 3 четверг, 4 пятница, 5 суббота, 6 воскресенье. r — повторения или время строкой, rest — отдых в секундах.';
      const user = `Запрос: ${String(b.wish || '').slice(0, 500)}\nДанные: пол ${P.sex === 'f' ? 'женский' : 'мужской'}, возраст ${P.age}, рост ${P.h} см, вес ${P.w} кг, желаемый вес ${P.goalW} кг, ` +
        `цель ${P.goal === 'cut' ? 'похудеть' : P.goal === 'bulk' ? 'набрать массу' : 'держать форму'}, уровень ${P.levelText || 'новичок'}, тренировок в неделю ${P.days || 3}, ` +
        `где и с чем: ${P.equipText || 'свой вес'}, ограничения здоровья: ${P.flagsText || 'нет'}${P.health ? '; ' + String(P.health).slice(0, 120) : ''}.`;
      const out = await openai([{ role: 'system', content: sys }, { role: 'user', content: user }], true, 2200);
      return res.json({ program: JSON.parse(out) });
    }
    if (b.type === 'meal') {
      const P = b.profile || {}, N = b.norm || {};
      const out = await openai([{ role: 'system', content: MEAL_RULES }, { role: 'user', content:
        `Норма: ${num(N.k)} ккал, белки ${num(N.p)} г, жиры ${num(N.f)} г, углеводы ${num(N.c)} г. ${who(P)}` +
        `Пожелания: ${String(b.wish || P.foodWish || 'нет').slice(0, 300)}.` }], true, 3600, 0.6);
      return res.json({ meal: JSON.parse(out) });
    }
    if (b.type === 'chat') {
      const P = b.profile || {}, N = b.norm || {}, E = b.eaten || {};
      const data = `${who(P)}Текущая программа: ${String(P.planName || '—').slice(0, 60)}. Рацион: ${String(P.mealName || '—').slice(0, 60)}. ` +
        `Местное время: ${String(P.localTime || '').slice(0, 30)} (${String(P.tz || '').slice(0, 40)}). ` +
        `Норма в день: ${num(N.k)} ккал, белки ${num(N.p)} г, жиры ${num(N.f)} г, углеводы ${num(N.c)} г. Сегодня съедено: ${num(E.k)} ккал, белки ${num(E.p)} г, жиры ${num(E.f)} г, углеводы ${num(E.c)} г. ` +
        String(P.regime || '').slice(0, 600);
      const hist = (Array.isArray(b.messages) ? b.messages : []).slice(-8)
        .map(m => ({ role: m.a ? 'assistant' : 'user', content: String(m.t || '').slice(0, 600) }));
      const out = await openai([{ role: 'system', content: CHAT_RULES }, { role: 'system', content: 'Данные пользователя: ' + data }, ...hist], false, 700, 0.5);
      return res.json({ reply: out });
    }
    return res.status(400).json({ error: 'Неизвестный запрос' });
  } catch (e) {
    console.error(e);
    return res.status(502).json({ error: 'ИИ временно недоступен' });
  }
};
