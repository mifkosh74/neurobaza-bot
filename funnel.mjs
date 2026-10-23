// Чистая логика воронки: время по Москве, сборка сообщения из сценария, что и когда отправить человеку.
import {steps} from './content.mjs';

const MIN = 60e3, HOUR = 60 * MIN, DAY = 24 * HOUR;
const MSK = 3 * HOUR; // в России нет перехода на летнее время
const MONTHS = ['января', 'февраля', 'марта', 'апреля', 'мая', 'июня', 'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря'];

export const DAILY = ['d2', 'd3', 'd4', 'd5', 'd6', 'd7', 'd8', 'd9', 'd10', 'd11', 'd12'];
export const BONUS_DELAY = 15 * MIN;
const SEND_FROM = 10 * 60, SEND_TO = 20 * 60; // ежедневные письма уходят с 10:00 до 20:00 МСК
const OFFER_MARGIN = 3 * HOUR;                // ближе к повышению оффер уже не шлём

export function msk(ts) {
  const d = new Date(ts + MSK);
  return {y: d.getUTCFullYear(), mo: d.getUTCMonth(), d: d.getUTCDate(), h: d.getUTCHours(), mi: d.getUTCMinutes(), wd: (d.getUTCDay() + 6) % 7};
}
export const mskDay = ts => {const p = msk(ts); return `${p.y}-${p.mo + 1}-${p.d}`;};
// Момент «через shift дней от даты ts, в minutes минут от полуночи по Москве».
export function mskAt(ts, shift, minutes) {const p = msk(ts); return Date.UTC(p.y, p.mo, p.d + shift) - MSK + minutes * MIN;}
export const mskWeek = ts => mskDay(mskAt(ts, -msk(ts).wd, 0));

// День n (1 — день входа) приходит в то же время, что и вход, но не раньше 10:00 и не позже 20:00 МСК.
export function dayDue(startedAt, n) {
  const p = msk(startedAt);
  return mskAt(startedAt, n - 1, Math.min(Math.max(p.h * 60 + p.mi, SEND_FROM), SEND_TO));
}

export function parseDeadline(value) {
  if (!value) return null;
  const ts = Date.parse(value);
  return Number.isFinite(ts) ? ts : null;
}
// Оффер раньше 12-го дня: накануне повышения в полдень, но не раньше третьего дня человека.
export const earlyOfferAt = (startedAt, deadline) => Math.max(mskAt(deadline, -1, 12 * 60), dayDue(startedAt, 3));
// Финальное напоминание: вечером дня повышения, минимум за час до него.
export function finalAt(deadline) {const evening = mskAt(deadline, 0, 18 * 60); return evening < deadline - HOUR ? evening : deadline - 4 * HOUR;}

const pad = n => String(n).padStart(2, '0');
export function vars(settings, now, extra = {}) {
  const out = {
    instagram: settings.instagram || '',
    review_count: String(settings.review_count ?? ''),
    days_phrase: extra.early ? 'За эти дни' : 'За эти 12 дней',
    deadline_date: '', deadline_next: '', deadline_time: '', deadline_datetime: '',
  };
  const dl = parseDeadline(settings.deadline);
  if (dl && dl - now >= (extra.final ? HOUR : OFFER_MARGIN)) {
    const p = msk(dl), next = msk(dl + MIN);
    out.deadline_date = `${p.d} ${MONTHS[p.mo]}`;
    out.deadline_next = `${next.d} ${MONTHS[next.mo]}`;
    out.deadline_time = `${pad(p.h)}:${pad(p.mi)} по Москве`;
    out.deadline_datetime = `${out.deadline_date}, ${out.deadline_time}`;
  }
  return out;
}

const escape = s => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

export function siteLink(base, anchor, content) {
  const url = new URL(base);
  url.searchParams.set('utm_source', 'telegram');
  url.searchParams.set('utm_medium', 'bot');
  url.searchParams.set('utm_campaign', 'neurobaza_bot');
  url.searchParams.set('utm_content', content);
  url.hash = anchor || '';
  return url.toString();
}

// Собирает шаг. ok=false и список missing, если не хватает текста, файлов или ссылок.
export function render(id, {settings, media = {}, now = Date.now(), early = false, final = false}) {
  const step = steps[id];
  if (!step) return {ok: false, missing: [`нет шага ${id}`]};
  const missing = [];
  const v = vars(settings, now, {early, final: final || id === 'final'});
  const fill = s => s.replace(/\{(\w+)\}/g, (_, key) => {
    if (!v[key]) missing.push(`{${key}}`);
    return escape(v[key] ?? '');
  });
  const title = fill(step.title || '');
  const body = fill(step.text || '');
  for (const hole of `${step.title || ''}\n${step.text || ''}`.match(/\[[^\]]+\]/g) || []) missing.push(hole);

  const files = [];
  for (const spec of step.media || []) {
    const optional = spec.endsWith('?');
    const slot = spec.replace(/\?$/, '');
    if (media[slot]) files.push({slot, ...media[slot]});
    else if (!optional) missing.push(`файл ${slot}`);
  }

  const keyboard = (step.buttons || []).map(row => row.map(b => {
    if (b.site !== undefined) return {text: b.text, url: siteLink(settings.site_url, b.site, id)};
    if (b.link) {
      if (!settings[b.link]) missing.push(`ссылка ${b.link}`);
      return {text: b.text, url: settings[b.link] || 'https://t.me'};
    }
    if (b.act === 'lesson') {
      if (settings.lesson_url) return {text: b.text, url: settings.lesson_url};
      if (!media.lesson_video) missing.push('урок: файл lesson_video или ссылка lesson_url');
    }
    if (b.act === 'guide' && !media.guide_claude && !media.guide_chatgpt) missing.push('файл guide_claude или guide_chatgpt');
    return {text: b.text, callback_data: `a:${b.act}`};
  }));

  const text = title ? `<b>${title}</b>\n\n${body}` : body;
  return {ok: missing.length === 0, missing: [...new Set(missing)], text, media: files, keyboard: keyboard.length ? {inline_keyboard: keyboard} : undefined};
}

// Что пора отправить человеку из расписания. null — ничего.
// Возвращает {id, daily, early}. Если шаг не собирается (render.ok=false), вызывающий помечает его пропущенным.
export function plan(user, now, settings) {
  if (!user || user.blocked || user.paid || !user.startedAt) return null;
  const sent = user.sent || {}, skipped = user.skipped || {};
  const done = id => sent[id] || skipped[id];

  if (user.bonusAt && !done('bonus') && now >= user.bonusAt) return {id: 'bonus', daily: false};

  const dl = parseDeadline(settings.deadline);
  if (dl && now < dl) {
    if (sent.d12 && !done('final') && !user.fixed && now >= finalAt(dl) && now - sent.d12 >= 3 * HOUR) return {id: 'final', daily: false};
    if (!done('d12') && sent.d1_lesson) {
      const early = earlyOfferAt(user.startedAt, dl);
      if (now >= early && early <= dl - OFFER_MARGIN && dayDue(user.startedAt, 12) > early) return {id: 'd12', daily: true, early: true};
    }
  }

  if (user.lastDaily && mskDay(user.lastDaily) === mskDay(now)) return null; // одно основное сообщение в день
  // Не забрал урок до второго дня — вместо письма дня 2 отдаём урок, остальное сдвигается.
  if (!done('d1_lesson') && now >= dayDue(user.startedAt, 2)) return {id: 'd1_lesson', daily: true};
  for (const id of DAILY) {
    if (done(id)) continue;
    if (now < dayDue(user.startedAt, Number(id.slice(1)))) return null;
    return {id, daily: true};
  }
  return null;
}
