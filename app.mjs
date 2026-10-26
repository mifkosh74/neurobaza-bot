// Поведение бота: вход, кнопки, анкеты, заявки Николаю, расписание и админ-команды.
// Сеть и диск приходят снаружи (api, store), поэтому всё это гоняется в тестах без Telegram.
import {steps, slots, forms, replies, order, media as baseMedia, settings as base} from './content.mjs';
import {plan, render, mskWeek, mskAt, parseDeadline, BONUS_DELAY, DAILY} from './funnel.mjs';

const HOUR = 3600e3, DAY = 24 * HOUR;
const SENDERS = {photo: 'sendPhoto', video: 'sendVideo', animation: 'sendAnimation', document: 'sendDocument', voice: 'sendVoice', video_note: 'sendVideoNote', audio: 'sendAudio'};
const CONFIG_KEYS = ['deadline', 'contest_until', 'lesson_url', 'works_post_url', 'instagram', 'instagram_url', 'channel_url', 'site_url', 'contact_url', 'razbor_per_week', 'leads_chat'];
const WALK = ['d1_hello', 'd1_lesson', 'bonus', ...DAILY, 'final'];
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

const ADMIN_HELP = `<b>Управление ботом</b>
/stats — статистика
/steps — какие шаги готовы и чего не хватает
/preview d5 — прислать шаг себе как есть
/next — прислать себе следующий шаг воронки (проверка цепочки; сначала /start)
/reset_me — начать воронку заново для себя
/users — кто заходил последним (id и ник)
/reset @username — сбросить воронку человеку
/tester @username — дать человеку /reset_me и /next для проверки бота; /untester — забрать

/media — файлы по слотам
/set lesson_video — следующий присланный файл ляжет в слот
/clear d3_media — убрать файл из слота

/config — настройки; /config works_post_url https://t.me/neurokean_ch/1632
/config deadline 2026-10-31 23:59 — дата повышения (МСК), /config deadline off — убрать
/config contest_until 2026-11-20 — до какого дня идёт конкурс работ (день 2)

/paid 123456 или /paid @username — купил, убрать из продающей цепочки
/unpaid 123456 — вернуть в цепочку
/user 123456 — карточка человека
/broadcast — ответом на любое сообщение: разослать его всем

Ответ (reply) на заявку или пересланное сообщение уходит этому человеку от имени бота.`;

export function createApp({api, store, now = () => Date.now(), overrides = {}, log = console.log}) {
  const db = store.data;
  const cfg = () => ({...base, ...overrides, ...db.config});
  const isAdmin = id => [].concat(cfg().admins).map(Number).includes(Number(id));
  // Тестировщик (например, Крис) может сбросить себя и промотать дни, но не управляет ботом.
  const isTester = id => isAdmin(id) || [].concat(db.config.testers || []).map(Number).includes(Number(id));
  const files = () => Object.fromEntries(Object.entries({...baseMedia, ...db.media}).filter(([, f]) => f));

  function fail(user, method, e) {
    if (user && e.code === 403) {user.blocked = now(); store.save(); return;}
    log(`${method} → ${user?.id ?? ''}: ${e.message}`);
  }
  async function call(method, payload, user) {
    try {return await api(method, payload);} catch (e) {fail(user, method, e); return null;}
  }
  const say = (chat, text, keyboard, user) => call('sendMessage', {chat_id: chat, text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, reply_markup: keyboard}, user);
  const sendFile = (chat, file, extra = {}) => api(SENDERS[file.type], {chat_id: chat, [file.type]: file.file_id, ...extra});
  const linkKb = (text, url) => ({inline_keyboard: [[{text, url}]]});

  // 'sent' | 'unready' (не хватает текста/файлов — шаг пропускаем) | 'failed' (сеть/Telegram — повторим)
  async function sendStep(user, id, opts = {}) {
    const r = render(id, {settings: cfg(), media: files(), now: now(), early: opts.early});
    if (!r.ok && !opts.force) return 'unready';
    try {
      for (const f of r.media || []) await sendFile(user.id, f);
      await api('sendMessage', {chat_id: user.id, text: r.text, parse_mode: 'HTML', link_preview_options: {is_disabled: true}, reply_markup: r.keyboard});
      return 'sent';
    } catch (e) {fail(user, id, e); return 'failed';}
  }

  function touch(from) {
    const user = db.users[from.id] ??= {id: from.id, sent: {}, skipped: {}};
    user.name = [from.first_name, from.last_name].filter(Boolean).join(' ');
    user.username = from.username || undefined;
    return user;
  }
  const label = u => `<a href="tg://user?id=${u.id}">${esc(u.name || u.id)}</a>${u.username ? ` @${esc(u.username)}` : ''} · id ${u.id}`;
  const funnelDay = u => u.startedAt ? Math.round((mskAt(now(), 0, 0) - mskAt(u.startedAt, 0, 0)) / DAY) + 1 : '—';
  function remember(msg, userId) {
    if (!msg) return;
    db.replies[`${msg.chat?.id ?? cfg().leads_chat}:${msg.message_id}`] = userId;
    const keys = Object.keys(db.replies);
    for (const k of keys.slice(0, Math.max(0, keys.length - 3000))) delete db.replies[k];
  }
  const paidKb = id => ({inline_keyboard: [[{text: '✅ Купил курс', callback_data: `paid:${id}`}]]});
  async function lead(user, title, lines) {
    const text = `<b>${title}</b>\n${label(user)}\nИсточник: ${esc(user.source || '—')} · день воронки: ${funnelDay(user)}\n\n${lines.map(esc).join('\n')}`;
    const msg = await say(cfg().leads_chat, text, paidKb(user.id));
    if (msg) remember({...msg, chat: msg.chat ?? {id: cfg().leads_chat}}, user.id);
    store.save();
  }
  let warnedAt = 0;
  async function warn(text) {
    if (now() - warnedAt < HOUR) return;
    warnedAt = now();
    await say(cfg().leads_chat, `⚠️ ${text}`);
  }

  // ——— вход и кнопки ———
  async function onStart(from, payload) {
    let user = db.users[from.id];
    if (!user?.startedAt) {
      user = touch(from);
      Object.assign(user, {startedAt: now(), source: payload || 'direct', sent: user.sent || {}, skipped: user.skipped || {}});
    } else {
      touch(from);
      if (payload && payload !== user.source) (user.sources ??= []).includes(payload) || user.sources.push(payload);
    }
    user.blocked = undefined;
    user.stopped = undefined;
    user.form = undefined;
    // «Старт» = согласие (условия — в описании бота). Пишем, когда и с какой редакцией документов.
    const version = cfg().consent_version;
    if (user.consent?.version !== version) {
      user.consent = {version, at: now()};
      (user.consents ??= []).push({version, at: now(), how: 'start'});
    }
    const id = user.sent.d1_lesson ? 'd1_lesson' : 'd1_hello';
    if (await sendStep(user, id, {force: true}) === 'sent') user.sent[id] ??= now();
    store.save();
  }

  const razborFull = () => {
    const limit = Number(cfg().razbor_per_week) || 0;
    return limit > 0 && (db.razbor[mskWeek(now())] || 0) >= limit;
  };
  const formQuestions = (user, kind) => kind === 'razbor' ? [...forms.razbor, ...(user.username ? [] : [forms.contact])] : [forms.contact];

  async function giveLesson(user) {
    const s = cfg();
    if (s.lesson_url) return say(user.id, 'Бесплатный урок по ссылке:', linkKb('Смотреть урок', s.lesson_url), user);
    if (!files().lesson_video) {
      await say(user.id, replies.lesson_missing, undefined, user);
      return warn('Человек нажал «Смотреть урок», а видео урока нет. Загрузи: /set lesson_video или /config lesson_url ссылка');
    }
    try {await sendFile(user.id, files().lesson_video, {caption: 'Бесплатный урок: замена окружения в Seedance', supports_streaming: true});} catch (e) {return fail(user, 'lesson', e);}
    user.lessonAt ??= now();
    user.bonusAt ??= now() + BONUS_DELAY;
    store.save();
  }

  async function act(user, name) {
    switch (name) {
      case 'take_lesson': {
        const res = await sendStep(user, 'd1_lesson');
        if (res === 'unready') {
          await say(user.id, replies.lesson_missing, undefined, user);
          return warn('Человек нажал «Забрать бесплатный урок», а шаг d1_lesson не готов. Проверь /steps');
        }
        if (res === 'sent') {
          user.sent.d1_lesson ??= now();
          if (cfg().lesson_url) user.bonusAt ??= now() + BONUS_DELAY; // переход по ссылке не виден боту, бонус по таймеру
        }
        return store.save();
      }
      case 'lesson': return giveLesson(user);
      case 'guide': {
        for (const slot of ['guide_claude', 'guide_chatgpt']) {
          if (!files()[slot]) continue;
          try {await sendFile(user.id, files()[slot]);} catch (e) {return fail(user, slot, e);}
        }
        await sendStep(user, 'guide_howto', {force: true});
        user.guideAt ??= now();
        return store.save();
      }
      case 'agent001': return sendStep(user, 'agent001', {force: true});
      case 'razbor':
        if (razborFull()) return say(user.id, replies.razbor_full, linkKb('Написать Николаю', cfg().contact_url), user);
        return sendStep(user, 'razbor_info', {force: true});
      case 'razbor_go':
        if (razborFull()) return say(user.id, replies.razbor_full, linkKb('Написать Николаю', cfg().contact_url), user);
        user.form = {kind: 'razbor', answers: []};
        store.save();
        return say(user.id, formQuestions(user, 'razbor')[0], undefined, user);
      case 'fix_price': {
        const dl = parseDeadline(cfg().deadline);
        if (!dl || now() >= dl) return say(user.id, replies.fix_closed, linkKb('Написать Николаю', cfg().contact_url), user);
        return say(user.id, replies.fix_ask, {inline_keyboard: forms.tariffs.map((t, i) => [{text: t, callback_data: `fx:${i}`}])}, user);
      }
    }
  }

  async function finishForm(user) {
    const {kind, answers} = user.form;
    const questions = formQuestions(user, kind);
    user.form = undefined;
    if (kind === 'razbor') {
      const week = mskWeek(now());
      db.razbor[week] = (db.razbor[week] || 0) + 1;
      user.razborAt = now();
      user.razborAnswers = answers;
      await lead(user, '🗓 Заявка на бесплатный разбор', questions.map((q, i) => `${q}\n→ ${answers[i]}\n`));
      return say(user.id, replies.razbor_done, undefined, user);
    }
    if (answers[0]) user.contact = answers[0];
    return finishFix(user);
  }
  async function finishFix(user) {
    user.fixed = now();
    await lead(user, '📌 Хочет зафиксировать прежнюю стоимость', [`Тариф: ${user.fixTariff}`, ...(user.contact ? [`Контакт: ${user.contact}`] : [])]);
    return say(user.id, replies.fix_done, undefined, user);
  }

  async function onForm(user, m) {
    if (!m.text) return say(user.id, replies.answer_text, undefined, user);
    user.form.answers.push(m.text.slice(0, 1500));
    store.save();
    const questions = formQuestions(user, user.form.kind);
    if (user.form.answers.length < questions.length) return say(user.id, questions[user.form.answers.length], undefined, user);
    return finishForm(user);
  }

  async function relay(user, m) {
    const head = await say(cfg().leads_chat, `💬 <b>Сообщение в боте</b>\n${label(user)}\nОтветь реплаем, и бот перешлёт ответ.`, paidKb(user.id));
    remember(head && {...head, chat: head.chat ?? {id: cfg().leads_chat}}, user.id);
    const copy = await call('copyMessage', {chat_id: cfg().leads_chat, from_chat_id: m.chat.id, message_id: m.message_id});
    if (copy) remember({message_id: copy.message_id, chat: {id: cfg().leads_chat}}, user.id);
    if (!user.relayAt || now() - user.relayAt > 6 * HOUR) await say(user.id, replies.unknown, undefined, user);
    user.relayAt = now();
    store.save();
  }

  // ——— админка ———
  function findUser(arg) {
    if (!arg) return null;
    if (/^\d+$/.test(arg)) return db.users[arg] || null;
    const name = arg.replace(/^@/, '').toLowerCase();
    return Object.values(db.users).find(u => u.username?.toLowerCase() === name) || null;
  }
  function fileOf(m) {
    if (m.photo) return {type: 'photo', file_id: m.photo.at(-1).file_id};
    for (const type of ['video_note', 'voice', 'video', 'animation', 'audio', 'document']) {
      if (m[type]) return {type, file_id: m[type].file_id, name: m[type].file_name};
    }
    return null;
  }
  function stats() {
    const users = Object.values(db.users).filter(u => u.startedAt);
    const t = now(), count = f => users.filter(f).length;
    const sources = {};
    for (const u of users) sources[u.source] = (sources[u.source] || 0) + 1;
    const top = Object.entries(sources).sort((a, b) => b[1] - a[1]).slice(0, 10).map(([s, n]) => `  ${esc(s)}: ${n}`).join('\n');
    const perStep = WALK.map(id => `${id}: ${count(u => u.sent?.[id])}`).join(' · ');
    const limit = Number(cfg().razbor_per_week) || '∞';
    return `<b>Статистика</b>
Всего зашли: ${users.length} (заблокировали бота: ${count(u => u.blocked)}, отключили сообщения: ${count(u => u.stopped)})
За сутки: ${count(u => t - u.startedAt < DAY)} · за 7 дней: ${count(u => t - u.startedAt < 7 * DAY)}

Получили сообщение с уроком: ${count(u => u.sent?.d1_lesson)}
Открыли видео урока: ${count(u => u.lessonAt)}
Забрали гайд: ${count(u => u.guideAt)}
Заявки на разбор: ${count(u => u.razborAt)} (эта неделя: ${db.razbor[mskWeek(t)] || 0} из ${limit})
Зафиксировали цену: ${count(u => u.fixed)}
Купили: ${count(u => u.paid)}

Источники:
${top || '  —'}

Отправлено по шагам:
${perStep}`;
  }
  function stepsReport() {
    const s = cfg(), t = now();
    const lines = order.map(id => {
      const r = render(id, {settings: s, media: files(), now: t});
      return `${r.ok ? '✅' : '❌'} <b>${id}</b> ${esc(steps[id].name)}${r.ok ? '' : `\n    не хватает: ${esc(r.missing.join(', '))}`}`;
    });
    return `<b>Готовность шагов</b>\nНеготовый шаг не уходит: человек получает следующий день по расписанию.\n\n${lines.join('\n')}`;
  }
  function configReport() {
    const s = cfg();
    return `<b>Настройки</b>\n${CONFIG_KEYS.map(k => `${k}: ${esc(s[k] === '' || s[k] == null ? '—' : s[k])}${db.config[k] !== undefined ? ' (из /config)' : ''}`).join('\n')}`;
  }
  function setConfig(key, raw) {
    if (!CONFIG_KEYS.includes(key)) return `Нет такой настройки. Можно: ${CONFIG_KEYS.join(', ')}`;
    let value = raw.trim();
    if (['off', '-', 'нет'].includes(value.toLowerCase())) value = '';
    if (key === 'deadline' && value) {
      const m = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{1,2}):(\d{2}))?$/);
      if (m) value = `${m[1]}-${m[2]}-${m[3]}T${(m[4] || '23').padStart(2, '0')}:${m[5] || '59'}:00+03:00`;
      if (!parseDeadline(value)) return 'Не понял дату. Пример: /config deadline 2026-10-31 23:59';
    }
    if (key === 'contest_until' && value && !/^\d{4}-\d{2}-\d{2}$/.test(value)) return 'Нужна дата. Пример: /config contest_until 2026-11-20';
    if (['razbor_per_week', 'leads_chat'].includes(key) && value && !/^-?\d+$/.test(value)) return 'Нужно число.';
    if (/_url$/.test(key) && value && !/^https?:\/\//.test(value)) return 'Ссылка должна начинаться с https://';
    db.config[key] = ['razbor_per_week', 'leads_chat'].includes(key) && value ? Number(value) : value;
    store.save();
    return `Готово: ${key} = ${value || '—'}`;
  }
  async function startBroadcast(m) {
    const src = m.reply_to_message;
    if (!src) return say(m.chat.id, 'Ответь командой /broadcast на сообщение, которое нужно разослать (текст, фото, видео — как есть).');
    const users = Object.values(db.users).filter(u => u.startedAt && !u.blocked && !u.stopped);
    const all = users.length, nopaid = users.filter(u => !u.paid).length;
    return say(m.chat.id, `Разослать это сообщение?`, {inline_keyboard: [
      [{text: `Всем (${all})`, callback_data: `bc:all:${m.chat.id}:${src.message_id}`}],
      [{text: `Кроме купивших (${nopaid})`, callback_data: `bc:np:${m.chat.id}:${src.message_id}`}],
      [{text: 'Отмена', callback_data: 'bc:no'}],
    ]});
  }
  async function runBroadcast(adminChat, mode, fromChat, messageId) {
    const users = Object.values(db.users).filter(u => u.startedAt && !u.blocked && !u.stopped && (mode === 'all' || !u.paid));
    let ok = 0;
    for (const u of users) {
      if (await call('copyMessage', {chat_id: u.id, from_chat_id: fromChat, message_id: messageId}, u)) ok++;
      await new Promise(r => setTimeout(r, 40));
    }
    store.save();
    return say(adminChat, `Рассылка готова: доставлено ${ok} из ${users.length}.`);
  }

  async function onAdmin(m) {
    const chat = m.chat.id, text = (m.text || m.caption || '').trim();
    const pending = db.pending[m.from.id];
    const file = fileOf(m);
    if (pending && file) {
      db.media[pending] = file;
      delete db.pending[m.from.id];
      store.save();
      await say(chat, `Сохранил в слот <b>${pending}</b> (${file.type}). Проверить: /steps`);
      return true;
    }
    if (m.reply_to_message && !text.startsWith('/')) {
      const target = db.replies[`${chat}:${m.reply_to_message.message_id}`];
      if (target) {
        const sent = await call('copyMessage', {chat_id: target, from_chat_id: chat, message_id: m.message_id}, db.users[target]);
        await say(chat, sent ? '✓ Отправил' : 'Не получилось отправить: человек мог заблокировать бота.');
        return true;
      }
    }
    if (!text.startsWith('/')) return false;
    const [head, ...args] = text.split(/\s+/);
    const cmd = head.split('@')[0].toLowerCase();
    const reply = t => say(chat, t);
    switch (cmd) {
      case '/admin': case '/help': await reply(ADMIN_HELP); return true;
      case '/stats': await reply(stats()); return true;
      case '/steps': await reply(stepsReport()); return true;
      case '/config':
        await reply(args.length < 2 ? configReport() : setConfig(args[0], text.slice(text.indexOf(args[0]) + args[0].length)));
        return true;
      case '/media':
        await reply(`<b>Файлы</b>\n${Object.entries(slots).map(([k, d]) => `${files()[k] ? '✅' : '—'} <b>${k}</b> ${esc(d)}`).join('\n')}\n\nЗагрузить: /set имя_слота, затем прислать файл.`);
        return true;
      case '/set':
        if (!slots[args[0]]) {await reply(`Слоты: ${Object.keys(slots).join(', ')}`); return true;}
        db.pending[m.from.id] = args[0];
        store.save();
        await reply(`Пришли файл для <b>${args[0]}</b>: ${esc(slots[args[0]])}`);
        return true;
      case '/clear':
        if (slots[args[0]]) db.media[args[0]] = null; // null перекрывает и файл, прописанный в content.mjs
        store.save();
        await reply(`Слот ${esc(args[0] || '')} очищен.`);
        return true;
      case '/paid': case '/unpaid': {
        const user = findUser(args[0]);
        if (!user) {await reply('Не нашёл. Нужен id или @username человека, который заходил в бота.'); return true;}
        user.paid = cmd === '/paid' ? now() : undefined;
        store.save();
        await reply(`${label(user)}: ${user.paid ? 'купил, продающая цепочка остановлена' : 'возвращён в цепочку'}`);
        return true;
      }
      case '/user': {
        const user = findUser(args[0]);
        if (!user) {await reply('Не нашёл.'); return true;}
        const got = Object.keys(user.sent || {}).join(', ') || '—';
        await reply(`${label(user)}\nИсточник: ${esc(user.source || '—')}${user.sources ? ` (+ ${esc(user.sources.join(', '))})` : ''}\nДень воронки: ${funnelDay(user)}\nПолучил: ${esc(got)}\nУрок: ${user.lessonAt ? 'открыл' : '—'} · гайд: ${user.guideAt ? 'забрал' : '—'} · разбор: ${user.razborAt ? 'записался' : '—'} · цена: ${user.fixed ? `фиксирует (${esc(user.fixTariff)})` : '—'} · ${user.paid ? 'купил' : 'не купил'}${user.blocked ? ' · заблокировал бота' : ''}`);
        return true;
      }
      case '/preview': {
        const id = args[0];
        if (!steps[id]) {await reply(`Шаги: ${order.join(', ')}`); return true;}
        const r = render(id, {settings: cfg(), media: files(), now: now()});
        if (!r.ok) await reply(`Шаг ещё не уйдёт людям, не хватает: ${esc(r.missing.join(', '))}`);
        await sendStep({id: chat}, id, {force: true});
        return true;
      }
      case '/next': case '/reset_me': return selfTest(m, cmd);
      case '/users': {
        const list = Object.values(db.users).filter(u => u.startedAt).sort((a, b) => b.startedAt - a.startedAt).slice(0, 15);
        await reply(list.length ? `<b>Последние зашедшие</b>\n${list.map(u => `${label(u)}${isTester(u.id) && !isAdmin(u.id) ? ' · тестировщик' : ''}`).join('\n')}` : 'Пока никто не заходил.');
        return true;
      }
      case '/reset': {
        const user = findUser(args[0]);
        if (!user) {await reply('Не нашёл. Нужен id или @username человека, который заходил в бота (см. /users).'); return true;}
        delete db.users[user.id];
        store.save();
        await reply(`${label(user)}: воронка сброшена, следующий /start — как в первый раз.`);
        return true;
      }
      case '/tester': case '/untester': {
        const user = findUser(args[0]);
        if (!user) {await reply('Не нашёл. Человек должен сначала зайти в бота (/start), потом /tester @username или id (см. /users).'); return true;}
        const set = new Set([].concat(db.config.testers || []).map(Number));
        if (cmd === '/tester') set.add(Number(user.id)); else set.delete(Number(user.id));
        db.config.testers = [...set];
        store.save();
        await reply(cmd === '/tester'
          ? `${label(user)} теперь тестировщик. Ему доступны:\n/reset_me — начать воронку заново\n/next — следующий день сразу, без ожидания`
          : `${label(user)} больше не тестировщик.`);
        return true;
      }
      case '/broadcast': await startBroadcast(m); return true;
    }
    return false;
  }

  // /next и /reset_me — у админа и у тестировщиков.
  async function selfTest(m, cmd) {
    const reply = t => say(m.chat.id, t);
    if (cmd === '/reset_me') {
      delete db.users[m.from.id];
      store.save();
      await reply('Твоя воронка сброшена. /start — пройти заново.');
      return true;
    }
    const user = db.users[m.from.id];
    if (!user?.startedAt) {await reply('Сначала /start, потом /next.'); return true;}
    const id = WALK.find(s => !user.sent[s]);
    if (!id) {await reply('Цепочка пройдена. /reset_me — начать заново.'); return true;}
    const r = render(id, {settings: cfg(), media: files(), now: now()});
    await reply(`<b>${id}</b> · ${esc(steps[id].name)}${r.ok ? '' : `\nЛюдям не уйдёт, не хватает: ${esc(r.missing.join(', '))}`}`);
    await sendStep(user, id, {force: true});
    user.sent[id] = now();
    store.save();
    return true;
  }

  async function onCallback(q) {
    const data = q.data || '';
    await call('answerCallbackQuery', {callback_query_id: q.id});
    if (data.startsWith('paid:') && isAdmin(q.from.id)) {
      const user = db.users[data.slice(5)];
      if (user) {user.paid = now(); store.save();}
      return call('editMessageReplyMarkup', {chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: {inline_keyboard: [[{text: '✅ Отмечен как купивший', callback_data: 'noop'}]]}});
    }
    if (data.startsWith('bc:') && isAdmin(q.from.id)) {
      await call('editMessageReplyMarkup', {chat_id: q.message.chat.id, message_id: q.message.message_id, reply_markup: {inline_keyboard: []}});
      const [, mode, fromChat, messageId] = data.split(':');
      if (mode === 'no') return say(q.message.chat.id, 'Рассылка отменена.');
      await say(q.message.chat.id, 'Рассылаю, напишу, когда закончу.');
      runBroadcast(q.message.chat.id, mode === 'all' ? 'all' : 'nopaid', fromChat, Number(messageId)).catch(e => log(`broadcast: ${e.message}`));
      return;
    }
    const user = touch(q.from);
    if (data.startsWith('fx:')) {
      const dl = parseDeadline(cfg().deadline);
      if (!dl || now() >= dl) return say(user.id, replies.fix_closed, linkKb('Написать Николаю', cfg().contact_url), user);
      user.fixTariff = forms.tariffs[Number(data.slice(3))] || forms.tariffs[0];
      if (!user.username) {
        user.form = {kind: 'fix', answers: []};
        store.save();
        return say(user.id, forms.contact, undefined, user);
      }
      return finishFix(user);
    }
    if (data.startsWith('a:')) return act(user, data.slice(2));
  }

  async function onMessage(m) {
    if (!m.from) return;
    const text = m.text || '';
    if (isAdmin(m.from.id) && await onAdmin(m)) return;
    if (m.chat.type !== 'private') return;
    const testCmd = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    if (['/next', '/reset_me'].includes(testCmd) && isTester(m.from.id)) return selfTest(m, testCmd);
    if (text.startsWith('/start')) return onStart(m.from, text.split(/\s+/)[1]);
    const user = touch(m.from);
    if (user.form) {
      if (!text.startsWith('/')) return onForm(user, m);
      user.form = undefined;
      store.save();
    }
    if (await personalData(user, text)) return;
    if (text.startsWith('/')) return;
    if (isAdmin(m.from.id)) return say(m.chat.id, 'Это сообщение никуда не ушло: от админа бот пересылает только ответы реплаем. Команды: /admin');
    return relay(user, m);
  }

  // Команды про персональные данные — для всех.
  async function personalData(user, text) {
    const cmd = text.trim().split(/\s+/)[0].split('@')[0].toLowerCase();
    if (cmd === '/privacy') {await say(user.id, replies.privacy(cfg()), undefined, user); return true;}
    if (cmd === '/stop' || cmd === '/unsubscribe') {
      user.stopped = now();
      (user.consents ??= []).push({at: now(), how: 'stop'});
      store.save();
      await say(user.id, replies.stopped, undefined, user);
      return true;
    }
    if (cmd === '/delete') {
      delete db.users[user.id];
      for (const [k, uid] of Object.entries(db.replies)) if (Number(uid) === Number(user.id)) delete db.replies[k];
      store.save();
      await say(user.id, replies.deleted);
      return true;
    }
    return false;
  }

  async function handleUpdate(u) {
    if (u.message) return onMessage(u.message);
    if (u.callback_query) return onCallback(u.callback_query);
    const cm = u.my_chat_member;
    if (cm?.chat.type === 'private' && db.users[cm.chat.id]) {
      db.users[cm.chat.id].blocked = cm.new_chat_member.status === 'kicked' ? now() : undefined;
      store.save();
    }
  }

  // ——— расписание ———
  let ticking = false;
  async function tick() {
    if (ticking) return;
    ticking = true;
    try {
      for (const user of Object.values(db.users)) {
        for (let guard = 0; guard < 5; guard++) {
          const t = now();
          const next = plan(user, t, cfg());
          if (!next) break;
          const res = await sendStep(user, next.id, {early: next.early});
          if (res === 'failed') {
            user.fails ??= {};
            user.fails[next.id] = (user.fails[next.id] || 0) + 1;
            if (user.fails[next.id] >= 3 || user.blocked) (user.skipped ??= {})[next.id] = t;
            store.save();
            break;
          }
          if (res === 'sent') {
            user.sent[next.id] = t;
            if (next.daily) user.lastDaily = t;
            if (next.id === 'd1_lesson' && cfg().lesson_url) user.bonusAt ??= t + BONUS_DELAY;
          } else (user.skipped ??= {})[next.id] = t;
          store.save();
          if (res === 'sent') break;
        }
      }
    } finally {ticking = false;}
  }

  return {handleUpdate, tick, db, cfg};
}
