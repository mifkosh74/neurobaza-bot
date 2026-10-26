import test from 'node:test';
import assert from 'node:assert/strict';
import {createApp} from '../app.mjs';
import {memoryStore} from '../store.mjs';

const ADMIN = 509801940;
const H = 3600e3;

function setup(start = '2026-10-23T15:00:00+03:00') {
  const clock = {t: Date.parse(start)};
  const calls = [];
  const blocked = new Set();
  let id = 1000;
  const api = async (method, payload) => {
    calls.push({method, ...payload});
    if (blocked.has(payload.chat_id)) {const e = new Error('403 Forbidden: bot was blocked by the user'); e.code = 403; throw e;}
    if (/^send|^copyMessage$/.test(method)) return {message_id: ++id, chat: {id: payload.chat_id}};
    return true;
  };
  const app = createApp({api, store: memoryStore(), now: () => clock.t, log: () => {}});
  let upd = 0;
  const from = (uid, extra = {}) => ({id: uid, first_name: `User${uid}`, ...extra});
  const msg = (uid, text, {from: who, ...extra} = {}) => app.handleUpdate({update_id: ++upd, message: {message_id: ++id, from: from(uid, who), chat: {id: uid, type: 'private'}, text, ...extra}});
  const tap = (uid, data, extra = {}) => app.handleUpdate({update_id: ++upd, callback_query: {id: String(++id), from: from(uid, extra.from), data, message: {message_id: 1, chat: {id: uid}}}});
  const to = chat => calls.filter(c => c.chat_id === chat);
  const texts = chat => to(chat).filter(c => c.method === 'sendMessage').map(c => c.text);
  const clear = () => calls.splice(0);
  return {app, clock, calls, blocked, msg, tap, to, texts, clear};
}

async function loadMedia(t) {
  await t.msg(ADMIN, '/set lesson_video');
  await t.msg(ADMIN, undefined, {video: {file_id: 'LESSON'}});
  await t.msg(ADMIN, '/set guide_claude');
  await t.msg(ADMIN, undefined, {document: {file_id: 'ZIP', file_name: 'seedance-env-swap.zip'}});
  await t.msg(ADMIN, '/set guide_chatgpt');
  await t.msg(ADMIN, undefined, {document: {file_id: 'TXT', file_name: 'ChatGPT.txt'}});
  t.clear();
}

test('вход, урок, бонус через 15 минут, гайд', async () => {
  const t = setup();
  await t.msg(ADMIN, '/clear lesson_video'); // урок прописан в content.mjs — убираем, чтобы проверить «урока нет»
  await t.msg(1, '/start reels_oct');
  assert.match(t.texts(1)[0], /^Привет! Меня зовут Николай Константинов./, 'первое сообщение без заголовка (правка Крис 23.10)');
  assert.equal(t.app.db.users[1].source, 'reels_oct');

  await t.tap(1, 'a:take_lesson');
  assert.match(t.texts(1).at(-1), /Урок загружается/, 'пока урока нет — честный ответ человеку');
  assert.match(t.texts(ADMIN).at(-1), /не готов/, 'и предупреждение Николаю');

  await loadMedia(t);
  assert.equal(t.app.db.media.lesson_video.file_id, 'LESSON');
  await t.tap(1, 'a:take_lesson');
  assert.match(t.texts(1).at(-1), /На уроке покажу всю связку/);
  await t.tap(1, 'a:lesson');
  assert.equal(t.to(1).find(c => c.method === 'sendVideo').video, 'LESSON');

  t.clock.t += 10 * 60e3;
  await t.app.tick();
  assert.equal(t.texts(1).some(x => /бонус к уроку/.test(x)), false);
  t.clock.t += 6 * 60e3;
  await t.app.tick();
  assert.match(t.texts(1).at(-1), /Обещанный бонус к уроку уже здесь/);

  t.clear();
  await t.tap(1, 'a:guide');
  assert.deepEqual(t.to(1).filter(c => c.method === 'sendDocument').map(c => c.document), ['ZIP', 'TXT']);
  assert.match(t.texts(1).at(-1), /Как установить гайд/);
});

test('по дням: неготовые шаги пропускаются, одно письмо в день, купившим тишина', async () => {
  const t = setup();
  await loadMedia(t);
  await t.msg(2, '/start');
  await t.tap(2, 'a:take_lesson');
  t.clear();

  await t.msg(ADMIN, '/config contest_until off'); // без конкурса день 2 не собирается — проверяем пропуск
  t.clock.t = Date.parse('2026-10-24T15:05:00+03:00');
  await t.app.tick();
  assert.equal(t.texts(2).length, 0);
  assert.ok(t.app.db.users[2].skipped.d2);

  t.clock.t = Date.parse('2026-10-25T15:05:00+03:00');
  await t.app.tick();
  await t.app.tick();
  assert.equal(t.texts(2).length, 1);
  assert.match(t.texts(2)[0], /Одна замена окружения может сэкономить целую съёмку/);

  await t.app.handleUpdate({update_id: 99, callback_query: {id: 'p', from: {id: ADMIN}, data: 'paid:2', message: {message_id: 5, chat: {id: ADMIN}}}});
  assert.ok(t.app.db.users[2].paid);
  t.clock.t = Date.parse('2026-10-26T15:05:00+03:00');
  t.clear();
  await t.app.tick();
  assert.equal(t.texts(2).length, 0);
});

test('запись на разбор: три вопроса, контакт без ника, заявка Николаю, лимит в неделю', async () => {
  const t = setup();
  await t.msg(3, '/start', {from: {username: 'ivan'}});
  await t.tap(3, 'a:razbor', {from: {username: 'ivan'}});
  assert.match(t.texts(3).at(-1), /Бесплатный разбор твоей задачи/);
  await t.tap(3, 'a:razbor_go', {from: {username: 'ivan'}});
  assert.equal(t.texts(3).at(-1), 'Чем ты сейчас занимаешься?');
  await t.msg(3, 'Монтажёр', {from: {username: 'ivan'}});
  await t.msg(3, 'Реклама', {from: {username: 'ivan'}});
  await t.msg(3, 'Первые заказы', {from: {username: 'ivan'}});
  assert.match(t.texts(3).at(-1), /Посмотрю твои ответы/);
  const lead = t.texts(ADMIN).at(-1);
  assert.match(lead, /Заявка на бесплатный разбор/);
  assert.match(lead, /@ivan/);
  assert.match(lead, /→ Первые заказы/);

  await t.msg(ADMIN, '/config razbor_per_week 1');
  await t.msg(4, '/start');
  await t.tap(4, 'a:razbor_go');
  assert.match(t.texts(4).at(-1), /все места на бесплатный разбор уже заняты/);
});

test('фиксация цены: тариф, контакт, отметка; после повышения закрыто', async () => {
  const t = setup();
  await t.msg(5, '/start');
  await t.tap(5, 'a:fix_price');
  assert.equal(t.to(5).at(-1).reply_markup.inline_keyboard.length, 3);
  await t.tap(5, 'fx:1');
  assert.match(t.texts(5).at(-1), /Как с тобой связаться/);
  await t.msg(5, '+7 900 000-00-00');
  assert.match(t.texts(5).at(-1), /помогу закрепить прежнюю стоимость/);
  assert.match(t.texts(ADMIN).at(-1), /Тариф: Комфортный — 13 000 ₽\nКонтакт: \+7 900/);
  assert.ok(t.app.db.users[5].fixed);

  t.clock.t = Date.parse('2026-11-01T10:00:00+03:00');
  await t.tap(5, 'a:fix_price');
  assert.match(t.texts(5).at(-1), /Прежняя стоимость уже не действует/);
});

test('сообщения людей уходят Николаю, ответ реплаем возвращается человеку', async () => {
  const t = setup();
  await t.msg(6, '/start');
  t.clear();
  await t.msg(6, 'А урок на телефоне откроется?');
  assert.match(t.texts(ADMIN)[0], /Сообщение в боте/);
  const copy = t.calls.find(c => c.method === 'copyMessage');
  assert.equal(copy.chat_id, ADMIN);
  assert.match(t.texts(6).at(-1), /Передал твоё сообщение Николаю/);

  const replyTarget = Object.entries(t.app.db.replies).find(([, uid]) => uid === 6)[0].split(':')[1];
  t.clear();
  await t.msg(ADMIN, 'Да, откроется', {reply_to_message: {message_id: Number(replyTarget)}});
  assert.equal(t.calls.find(c => c.method === 'copyMessage').chat_id, 6);
  assert.match(t.texts(ADMIN).at(-1), /Отправил/);
});

test('заблокировал бота — дальше не пишем; рассылка кроме купивших', async () => {
  const t = setup();
  await loadMedia(t);
  for (const uid of [7, 8, 9]) await t.msg(uid, '/start');
  t.app.db.users[9].paid = Date.now();
  t.blocked.add(8);
  await t.tap(8, 'a:take_lesson');
  assert.ok(t.app.db.users[8].blocked);

  t.clear();
  await t.msg(ADMIN, '/broadcast', {reply_to_message: {message_id: 777}});
  const confirm = t.to(ADMIN).at(-1).reply_markup.inline_keyboard;
  assert.match(confirm[0][0].text, /Всем \(2\)/);
  await t.app.handleUpdate({update_id: 50, callback_query: {id: 'b', from: {id: ADMIN}, data: confirm[1][0].callback_data, message: {message_id: 9, chat: {id: ADMIN}}}});
  await new Promise(r => setTimeout(r, 200));
  const copies = t.calls.filter(c => c.method === 'copyMessage').map(c => c.chat_id);
  assert.deepEqual(copies, [7]);
});

test('файлы из content.mjs работают без загрузки, /clear их перекрывает', async () => {
  const t = setup();
  await t.msg(10, '/start');
  await t.tap(10, 'a:lesson');
  assert.match(t.to(10).find(c => c.method === 'sendVideo').video, /^BAACAgIAAxkBAANW/);
  await t.msg(ADMIN, '/clear lesson_video');
  await t.tap(10, 'a:take_lesson');
  assert.match(t.texts(10).at(-1), /Урок загружается/);
});

test('тестировщик сам сбрасывает себя и проматывает дни; админ сбрасывает любого', async () => {
  const t = setup();
  const KRIS = {username: 'kris_rr'};
  await t.msg(20, '/start', {from: KRIS});
  await t.msg(20, '/next', {from: KRIS});
  assert.equal(t.texts(20).length, 1, 'пока не тестировщик, /next молча игнорируется');
  await t.msg(ADMIN, '/users');
  assert.match(t.texts(ADMIN).at(-1), /@kris_rr/);
  await t.msg(ADMIN, '/tester @kris_rr');
  assert.match(t.texts(ADMIN).at(-1), /теперь тестировщик/);
  await t.msg(20, '/next', {from: KRIS});
  assert.match(t.texts(20).at(-2), /d1_lesson/);
  await t.msg(20, '/reset_me', {from: KRIS});
  assert.equal(t.app.db.users[20], undefined);
  await t.msg(20, '/start', {from: KRIS});
  assert.match(t.texts(20).at(-1), /^Привет! Меня зовут/);
  await t.msg(20, '/stats', {from: KRIS});
  assert.doesNotMatch(t.texts(20).at(-1), /Статистика/, 'админские команды тестировщику недоступны');
  await t.msg(ADMIN, '/reset @kris_rr');
  assert.equal(t.app.db.users[20], undefined);
  await t.msg(ADMIN, '/config contest_until 20.11');
  assert.match(t.texts(ADMIN).at(-1), /Нужна дата/);
});

test('админка: готовность шагов, настройки, проход цепочки себе', async () => {
  const t = setup();
  await t.msg(ADMIN, '/steps');
  const report = t.texts(ADMIN).at(-1);
  assert.match(report, /❌ <b>d5<\/b>/);
  assert.match(report, /✅ <b>d3<\/b>/);
  await t.msg(ADMIN, '/config deadline 2026-11-15 20:00');
  assert.equal(t.app.cfg().deadline, '2026-11-15T20:00:00+03:00');
  await t.msg(ADMIN, '/config works_post_url t.me/x');
  assert.match(t.texts(ADMIN).at(-1), /https/);
  await t.msg(ADMIN, '/start');
  await t.msg(ADMIN, '/next');
  assert.match(t.texts(ADMIN).at(-2), /d1_lesson/);
  await t.msg(ADMIN, 'просто текст');
  assert.match(t.texts(ADMIN).at(-1), /никуда не ушло/);
});
