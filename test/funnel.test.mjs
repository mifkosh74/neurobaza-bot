import test from 'node:test';
import assert from 'node:assert/strict';
import {dayDue, plan, render, vars, siteLink, msk, earlyOfferAt, finalAt} from '../funnel.mjs';
import {settings, steps} from '../content.mjs';

const at = s => Date.parse(s);
const H = 3600e3;

test('день n приходит во время входа, но в окне 10:00–20:00 МСК', () => {
  assert.equal(dayDue(at('2026-10-23T15:30:00+03:00'), 2), at('2026-10-24T15:30:00+03:00'));
  assert.equal(dayDue(at('2026-10-23T23:30:00+03:00'), 2), at('2026-10-24T20:00:00+03:00'));
  assert.equal(dayDue(at('2026-10-23T03:00:00+03:00'), 3), at('2026-10-25T10:00:00+03:00'));
});

test('подстановки даты повышения', () => {
  const v = vars(settings, at('2026-10-23T12:00:00+03:00'));
  assert.equal(v.deadline_date, '31 октября');
  assert.equal(v.deadline_next, '1 ноября');
  assert.equal(v.deadline_time, '23:59 по Москве');
  assert.equal(vars(settings, at('2026-10-31T22:00:00+03:00')).deadline_date, '', 'за 2 часа до повышения оффер уже не шлём');
  assert.equal(vars(settings, at('2026-10-31T22:00:00+03:00'), {final: true}).deadline_time, '23:59 по Москве');
});

test('шаги с дырами из ТЗ не готовы, готовые собираются', () => {
  const t = at('2026-10-23T12:00:00+03:00');
  const d5 = render('d5', {settings, now: t});
  assert.equal(d5.ok, false);
  assert.ok(d5.missing.includes('[ОБЩЕЕ КОЛИЧЕСТВО]'));
  assert.equal(render('d7', {settings, now: t}).missing[0], 'файл d7_voice');
  const d2 = render('d2', {settings, now: t});
  assert.equal(d2.ok, true, 'день 2: конкурс до 20 ноября и пост для работ заданы');
  assert.match(d2.text, /подарю один Самостоятельный тариф НЕЙРОБАЗЫ 3\.0\. Работы принимаю до 20 ноября\./);
  assert.equal(d2.keyboard.inline_keyboard[0][0].url, 'https://t.me/neurokean_ch/1632');
  assert.deepEqual(render('d2', {settings, now: at('2026-11-21T10:00:00+03:00')}).missing, ['{contest_until}'], 'после конкурса день 2 не уходит');
  const d3 = render('d3', {settings, now: t});
  assert.equal(d3.ok, true);
  assert.match(d3.text, /^<b>Одна замена окружения/);
  assert.match(d3.keyboard.inline_keyboard[0][0].url, /utm_content=d3#program$/);
  const d12 = render('d12', {settings, now: t});
  assert.equal(d12.ok, true);
  assert.match(d12.text, /до 31 октября<\/b>/);
  assert.match(d12.text, /За эти 12 дней ты уже увидел/);
  assert.match(d12.text, /С 1 ноября стоимость/);
  assert.match(render('d12', {settings, now: t, early: true}).text, /За эти дни ты уже увидел/);
  assert.equal(render('d12', {settings, now: at('2026-11-02T12:00:00+03:00')}).ok, false, 'после повышения оффер со старой ценой не уходит');
});

test('урок: ссылка или файл', () => {
  const t = at('2026-10-23T12:00:00+03:00');
  assert.equal(render('d1_lesson', {settings, now: t}).ok, false);
  const viaUrl = render('d1_lesson', {settings: {...settings, lesson_url: 'https://youtu.be/x'}, now: t});
  assert.equal(viaUrl.ok, true);
  assert.equal(viaUrl.keyboard.inline_keyboard[0][0].url, 'https://youtu.be/x');
  const viaFile = render('d1_lesson', {settings, now: t, media: {lesson_video: {type: 'video', file_id: 'v'}}});
  assert.equal(viaFile.keyboard.inline_keyboard[0][0].callback_data, 'a:lesson');
});

test('расписание: одно письмо в день, урок вместо дня 2, оффер до повышения', () => {
  const start = at('2026-10-23T15:00:00+03:00');
  const user = {startedAt: start, sent: {d1_hello: start}, skipped: {}};
  assert.equal(plan(user, start + H, settings), null);
  assert.equal(plan(user, at('2026-10-24T15:00:00+03:00'), settings).id, 'd1_lesson', 'не забрал урок — отдаём его на второй день');
  user.sent.d1_lesson = start + H;
  assert.equal(plan(user, at('2026-10-24T15:00:00+03:00'), settings).id, 'd2');
  user.sent.d2 = user.lastDaily = at('2026-10-24T15:00:00+03:00');
  assert.equal(plan(user, at('2026-10-24T19:00:00+03:00'), settings), null, 'второе письмо в тот же день не шлём');
  assert.equal(plan(user, at('2026-10-25T15:00:00+03:00'), settings).id, 'd3');

  const early = earlyOfferAt(start, at(settings.deadline));
  assert.equal(early, at('2026-10-30T12:00:00+03:00'));
  const offer = plan(user, early, settings);
  assert.deepEqual(offer, {id: 'd12', daily: true, early: true});
  user.sent.d12 = early;
  assert.equal(finalAt(at(settings.deadline)), at('2026-10-31T18:00:00+03:00'));
  assert.equal(plan({...user, lastDaily: at('2026-10-31T15:00:00+03:00')}, at('2026-10-31T18:00:00+03:00'), settings).id, 'final');
  assert.equal(plan({...user, fixed: 1}, at('2026-10-31T18:00:00+03:00'), settings)?.id === 'final', false, 'зафиксировавшим финал не шлём');
  assert.equal(plan({...user, paid: 1}, at('2026-10-25T15:00:00+03:00'), settings), null, 'купившим цепочка не идёт');
});

test('кто зашёл накануне повышения, раннего оффера не получает', () => {
  const start = at('2026-10-30T14:00:00+03:00');
  const user = {startedAt: start, sent: {d1_hello: start, d1_lesson: start}, skipped: {}};
  assert.notEqual(plan(user, at('2026-10-31T12:00:00+03:00'), settings)?.id, 'd12');
});

test('без повышения d12 пропускается, после 12-го дня тишина', () => {
  const s = {...settings, deadline: ''};
  const start = at('2026-11-05T12:00:00+03:00');
  const user = {startedAt: start, sent: {d1_hello: start, d1_lesson: start}, skipped: {}};
  for (const id of ['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11']) user.sent[id] = start;
  assert.equal(plan(user, dayDue(start, 12), s).id, 'd12');
  assert.equal(render('d12', {settings: s, now: dayDue(start, 12)}).ok, false);
});

test('в текстах нет голых имён файлов, которые Telegram превратит в ссылки', () => {
  for (const [id, step] of Object.entries(steps)) {
    const plain = `${step.title || ''}\n${step.text || ''}`.replace(/<code>.*?<\/code>/g, '');
    assert.doesNotMatch(plain, /\b[\w-]+\.(zip|md|txt|mov|ai|io|py|sh)\b/i, `шаг ${id}`);
  }
});

test('UTM на сайт', () => {
  assert.equal(siteLink('https://neurokean.ru/', '#tariffs', 'd9'), 'https://neurokean.ru/?utm_source=telegram&utm_medium=bot&utm_campaign=neurobaza_bot&utm_content=d9#tariffs');
  assert.equal(msk(at('2026-10-23T00:30:00+03:00')).d, 23);
});
