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

async function openai(messages, json, maxTokens, temp, model) {
  const r = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + process.env.OPENAI_API_KEY },
    body: JSON.stringify({
      model: model || process.env.OPENAI_MODEL || 'gpt-4o-mini',
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

// Фото еды и тренажёров разбирает более сильная модель: mini часто путает блюда.
const VISION = process.env.VISION_MODEL || 'gpt-4o';
const num = v => Math.round(+v || 0);
// Короткое описание пользователя для промптов (без лишних токенов)
const who = P => `Пол ${P.sex === 'f' ? 'женский' : 'мужской'}, ${num(P.age)} лет, рост ${num(P.h)} см, вес ${P.w} кг, желаемый ${P.goalW} кг, ` +
  `цель: ${P.goal === 'cut' ? 'похудеть' : P.goal === 'bulk' ? 'набрать массу' : 'держать форму'}, уровень ${P.levelText || '—'}, ` +
  `тренировок в неделю ${P.days || '—'}, где и с чем: ${P.equipText || '—'}, ограничения здоровья: ${P.flagsText || 'нет'}` +
  `${P.health ? '; ' + String(P.health).slice(0, 120) : ''}${P.gentle ? ' (щадящий режим)' : ''}${P.noeat ? '; не ест: ' + String(P.noeat).slice(0, 150) : ''}. `;

// Лимиты на человека, чтобы один пользователь не съел бюджет на ИИ. Хранятся в памяти функции —
// это защита от спама; точный суточный учёт появится вместе с базой данных.
const LIM = { photo: [30, 86400], machine: [20, 86400], text: [60, 86400], chat: [60, 3600], program: [8, 86400], meal: [8, 86400] };
const HITS = new Map();
function limited(uid, type) {
  const l = LIM[type]; if (!l) return false;
  const k = uid + ':' + type, now = Date.now(), a = (HITS.get(k) || []).filter(t => now - t < l[1] * 1000);
  if (a.length >= l[0]) { HITS.set(k, a); return true; }
  a.push(now); HITS.set(k, a);
  if (HITS.size > 5000) for (const [kk, v] of HITS) if (!v.length || now - v[v.length - 1] > 86400e3) HITS.delete(kk);
  return false;
}

// Статичные правила идут первым сообщением — так OpenAI кэширует их и запросы дешевле.
const CHAT_RULES = 'Ты — ИИ-тренер приложения «Тренер 24»: тренировки, техника, питание, рецепты, восстановление, сон, мотивация и режим. ' +
  'Ты видишь данные человека из приложения: программу, сегодняшнюю тренировку, историю тренировок с весами, самочувствие, вес, замеры, съеденное сегодня и воду. ' +
  'Отвечай опираясь на эти цифры: называй конкретные упражнения, веса, граммы и калории из его данных, а не общие советы. Если данных не хватает — скажи, что именно записать в приложении. ' +
  'Если самочувствие плохое или человек болеет — советуй облегчить или пропустить тренировку. Не выдумывай данные, которых нет. ' +
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

const MACH_RULES = 'Ты — опытный тренер тренажёрного зала. На фото тренажёр, блок или спортивный снаряд. Определи его и объясни новичку, как на нём заниматься правильно и безопасно. ' +
  'Дай 1–2 основных упражнения для этого тренажёра. Настройку объясняй конкретно: высота сиденья, положение валиков и спинки, ось вращения, хват, стартовый вес. ' +
  'Подходы и повторы подбери под цель, уровень и ограничения здоровья человека. Если упражнение опасно при его ограничениях — скажи об этом в safety. ' +
  'Если на фото нет тренажёра или снаряда, ответь {"error":"На фото не видно тренажёра — сфотографируй его целиком"}. ' +
  'Сначала внимательно рассмотри конструкцию: где сиденье, валики, рукояти, трос и блоки, стек плит или диски, куда направлено движение. Не путай похожие тренажёры ' +
  '(разгибание и сгибание ног, жим ногами и гакк-машина, верхний и нижний блок, бабочка и обратная бабочка). ' +
  'В поле match выбери из списка приложения упражнение, которое выполняется именно на этом тренажёре, и скопируй название символ в символ; если в списке такого нет — пустая строка. ' +
  'Ответь строго JSON: {"machine":"название тренажёра по-русски","ex":[{"n":"название упражнения","match":"точное название из списка приложения или пустая строка","mu":"мышцы через запятую",' +
  '"setup":["2–4 пункта настройки"],"steps":["3–5 коротких шагов"],"mistakes":["2–3 частые ошибки"],"sets":"подходы × повторы и как подобрать вес",' +
  '"video":"поисковый запрос для YouTube на русском, например: техника разгибание ног в тренажёре"}],"safety":"предупреждение или пустая строка"}.';

const FOOD_PROMPT = 'Ты опытный нутрициолог и знаешь русскую, кавказскую, среднеазиатскую и европейскую кухню. Задача — точно определить еду и её калорийность. ' +
  'Порядок работы: 1) внимательно рассмотри фото и назови каждый отдельный продукт или блюдо на тарелке (гарнир, мясо, соус, хлеб, напиток — отдельно); ' +
  '2) оцени вес каждого по размеру тарелки (обычная тарелка 24–26 см), приборов, рук и упаковки; 3) для каждого дай калорийность и БЖУ на 100 г для готового продукта ' +
  'с учётом способа приготовления (жареное — с маслом, салат — с заправкой, напиток — с сахаром, если видно). ' +
  'Если видна упаковка или этикетка — бери значения с неё. Если человек уточнил, что на фото, — доверяй его уточнению. Если в тексте указаны граммы, миллилитры или штуки — используй ровно их, не меняй. ' +
  'Даже если не уверен, дай лучшую догадку и в поле ask напиши короткий вопрос, что уточнить; ошибку возвращай, только если еды на фото точно нет. ' +
  'Ответь строго JSON: {"n":"короткое название всей еды по-русски","items":[{"n":"продукт","g":150,"k100":110,"p100":4,"f100":1,"c100":21}],"conf":"high|mid|low","ask":"вопрос или пустая строка"}. ' +
  'g — граммы продукта в порции, k100/p100/f100/c100 — ккал, белки, жиры, углеводы на 100 г. Только числа. ' +
  'Если на фото нет еды, ответь {"error":"На фото не видно еды — сфотографируй тарелку сверху"}.';

function cleanFood(o) {
  if (o.error) return { error: String(o.error).slice(0, 120) };
  const n = x => { const m = String(x == null ? '' : x).replace(',', '.').match(/\d+(\.\d+)?/); return m ? parseFloat(m[0]) : 0; };
  const v = (...ks) => { for (const k of ks) if (o[k] != null) return o[k]; return 0; };
  const items = (Array.isArray(o.items) ? o.items : []).slice(0, 10).map(x => ({
    n: String(x.n || x.name || 'Продукт').slice(0, 50), g: Math.round(n(x.g)) || 100,
    k100: Math.round(n(x.k100)), p100: Math.round(n(x.p100) * 10) / 10, f100: Math.round(n(x.f100) * 10) / 10, c100: Math.round(n(x.c100) * 10) / 10
  })).filter(x => x.g > 0 && (x.k100 > 0 || x.p100 + x.f100 + x.c100 > 0));
  items.forEach(x => { if (!x.k100) x.k100 = Math.round(x.p100 * 4 + x.f100 * 9 + x.c100 * 4); });
  const meta = { conf: ['high', 'mid', 'low'].includes(o.conf) ? o.conf : 'mid', ask: String(o.ask || '').slice(0, 140) };
  if (items.length) {
    const t = k => Math.round(items.reduce((a, x) => a + x[k + '100'] * x.g / 100, 0));
    return { n: String(o.n || items.map(x => x.n).join(', ')).slice(0, 80), g: items.reduce((a, x) => a + x.g, 0), k: t('k'), p: t('p'), f: t('f'), c: t('c'), items, ...meta };
  }
  return { n: String(o.n || o.name || 'Блюдо').slice(0, 80), g: Math.round(n(v('g', 'weight', 'grams'))) || 250, k: Math.round(n(v('k', 'kcal', 'calories'))),
    p: Math.round(n(v('p', 'protein'))), f: Math.round(n(v('f', 'fat'))), c: Math.round(n(v('c', 'carbs'))), ...meta };
}
// Сопоставляем ответ ИИ со списком упражнений приложения, даже если название записано чуть иначе.
const normEx = t => String(t || '').toLowerCase().replace(/ё/g, 'е').replace(/[^а-яa-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
function matchEx(name, allowed) {
  const a = normEx(name);
  if (!a) return '';
  const exact = allowed.find(x => normEx(x) === a);
  if (exact) return exact;
  const st = w => w.slice(0, Math.max(4, w.length - 2));
  const aw = a.split(' ').filter(w => w.length > 2).map(st);
  const OPP = [['верхн', 'нижн', 'горизонт', 'к поясу'], ['сид', 'леж', 'стоя'], ['сгиб', 'разгиб'], ['узк', 'широк'], ['ног', 'рук']];
  const clash = x => OPP.some(g => { const p = g.filter(w => a.includes(w)), q = g.filter(w => normEx(x).includes(w)); return p.length && q.length && !p.some(w => q.includes(w)); });
  let best = '', bs = 0;
  for (const x of allowed) {
    if (clash(x)) continue;
    const xw = normEx(x).split(' ').filter(w => w.length > 2).map(st);
    const common = aw.filter(w => xw.includes(w)).length, sc = common / Math.max(aw.length, xw.length);
    if (sc > bs) { bs = sc; best = x; }
  }
  return bs >= 0.66 ? best : '';
}

module.exports = async (req, res) => {
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });
  const b = req.body || {};
  const user = checkInitData(b.initData, process.env.BOT_TOKEN);
  if (!user) return res.status(401).json({ error: 'Открой приложение через Telegram-бота' });
  if (b.type === 'sub') { // обязательная подписка на канал новостей; при ошибке не блокируем
    try {
      const ch = process.env.NEWS_ID || '-1005811785963';
      const r = await (await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/getChatMember?chat_id=${ch}&user_id=${user.id}`)).json();
      if (!r.ok) return res.json({ sub: null });
      const st = r.result.status;
      return res.json({ sub: ['creator', 'administrator', 'member'].includes(st) || (st === 'restricted' && !!r.result.is_member) });
    } catch (e) { return res.json({ sub: null }); }
  }
  if (limited(user.id || 'anon', b.type)) return res.status(429).json({ error: b.type === 'chat' ? 'Слишком много сообщений подряд — передохни пару минут' : 'Лимит на сегодня исчерпан — попробуй завтра' });
  try {
    if (b.type === 'photo') {
      if (typeof b.image !== 'string' || !b.image.startsWith('data:image/') || b.image.length > 3e6)
        return res.status(400).json({ error: 'Нет фото' });
      const out = await openai([
        { role: 'system', content: FOOD_PROMPT },
        { role: 'user', content: [{ type: 'text', text: 'Что на фото и сколько это калорий?' + (b.hint ? ' Уточнение от человека: ' + String(b.hint).slice(0, 200) : '') }, { type: 'image_url', image_url: { url: b.image, detail: 'high' } }] }
      ], true, 700, 0.2, VISION);
      return res.json(cleanFood(JSON.parse(out)));
    }
    if (b.type === 'text') {
      const t = String(b.text || '').slice(0, 300);
      if (!t) return res.status(400).json({ error: 'Пустое описание' });
      const out = await openai([{ role: 'system', content: FOOD_PROMPT }, { role: 'user', content: 'Я съел: ' + t }], true, 600, 0.2);
      return res.json(cleanFood(JSON.parse(out)));
    }
    if (b.type === 'machine') {
      if (typeof b.image !== 'string' || !b.image.startsWith('data:image/') || b.image.length > 3e6)
        return res.status(400).json({ error: 'Нет фото' });
      const allowed = (Array.isArray(b.allowed) ? b.allowed : []).slice(0, 150).map(x => String(x).slice(0, 60));
      const out = await openai([
        { role: 'system', content: MACH_RULES + ' Список упражнений приложения: ' + allowed.join('; ') + '.' },
        { role: 'user', content: [{ type: 'text', text: 'Данные человека: ' + who(b.profile || {}) + 'Что это за тренажёр и как на нём заниматься?' }, { type: 'image_url', image_url: { url: b.image, detail: 'high' } }] }
      ], true, 1500, 0.2, VISION);
      const r = JSON.parse(out);
      if (Array.isArray(r.ex)) r.ex.forEach(x => { x.match = allowed.includes(x.match) ? x.match : matchEx(x.match, allowed) || matchEx(x.n, allowed); });
      return res.json(r);
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
        String(P.regime || '').slice(0, 600) + ' ' + (P.strength ? 'Рабочие веса (первый → последний): ' + String(P.strength).slice(0, 500) + '. ' : '') +
        String(b.context || '').slice(0, 3000);
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
