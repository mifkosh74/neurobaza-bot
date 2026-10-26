// Запуск: длинный опрос Telegram (getUpdates) + расписание каждые 20 секунд.
// На bothost.ru токен приходит в API_TOKEN или BOT_TOKEN, база живёт в /app/data (переживает обновления).
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {setTimeout as sleep} from 'node:timers/promises';
import {openStore} from './store.mjs';
import {createApp} from './app.mjs';
import {botProfile} from './content.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const tokenFile = path.join(root, '.token');
const token = (process.env.BOT_TOKEN || process.env.API_TOKEN || (fs.existsSync(tokenFile) ? fs.readFileSync(tokenFile, 'utf8') : '')).trim();
if (!/^\d+:[\w-]+$/.test(token)) {console.error('Нет токена: задай BOT_TOKEN или положи его в файл .token'); process.exit(1);}
const apiBase = (process.env.API_BASE || 'https://api.telegram.org').replace(/\/$/, '');
const dataDir = process.env.DATA_DIR || (fs.existsSync('/app/data') ? '/app/data' : path.join(root, 'data'));

async function api(method, payload = {}, attempt = 0) {
  const response = await fetch(`${apiBase}/bot${token}/${method}`, {
    method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(payload),
    signal: AbortSignal.timeout(method === 'getUpdates' ? 60e3 : 30e3),
  });
  const result = await response.json();
  if (result.ok) return result.result;
  const retry = result.parameters?.retry_after;
  if (result.error_code === 429 && retry && attempt < 3) {await sleep((retry + 1) * 1000); return api(method, payload, attempt + 1);}
  const error = new Error(`${result.error_code} ${result.description}`);
  error.code = result.error_code;
  throw error;
}

const overrides = {};
if (process.env.ADMIN_IDS) overrides.admins = process.env.ADMIN_IDS.split(/[,\s]+/).filter(Boolean).map(Number);
if (process.env.LEADS_CHAT_ID) overrides.leads_chat = Number(process.env.LEADS_CHAT_ID);

const store = openStore(dataDir);
const app = createApp({api, store, overrides});
const stop = () => {store.flush(); process.exit(0);};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);

const me = await api('getMe');
await api('deleteWebhook').catch(() => {});
// Описание с условиями согласия (видно до «Старт») и команды для всех.
await api('setMyDescription', {description: botProfile.description}).catch(e => console.log(`Описание: ${e.message}`));
await api('setMyShortDescription', {short_description: botProfile.short}).catch(e => console.log(`Короткое описание: ${e.message}`));
await api('setMyCommands', {commands: botProfile.commands}).catch(e => console.log(`Команды: ${e.message}`));
for (const admin of [].concat(app.cfg().admins)) {
  await api('setMyCommands', {scope: {type: 'chat', chat_id: admin}, commands: [
    {command: 'admin', description: 'Управление ботом'}, {command: 'stats', description: 'Статистика'},
    {command: 'steps', description: 'Готовность шагов'}, {command: 'media', description: 'Файлы'},
    {command: 'config', description: 'Настройки'}, {command: 'next', description: 'Следующий шаг воронки себе'},
  ]}).catch(e => console.log(`Команды для ${admin}: ${e.message}`));
}
console.log(`Бот @${me.username} запущен. База: ${dataDir}. Ссылка: https://t.me/${me.username}?start=seedance`);

setInterval(() => app.tick().catch(e => console.log(`tick: ${e.message}`)), 20e3);
app.tick().catch(e => console.log(`tick: ${e.message}`));

while (true) {
  let updates;
  try {
    updates = await api('getUpdates', {offset: store.data.offset, timeout: 45, allowed_updates: ['message', 'callback_query', 'my_chat_member']});
  } catch (e) {
    console.log(`getUpdates: ${e.message}`);
    if (e.code === 409) console.log('Похоже, бот запущен где-то ещё (хостинг и компьютер одновременно). Оставь одну копию.');
    await sleep(5000);
    continue;
  }
  for (const update of updates) {
    store.data.offset = update.update_id + 1;
    try {await app.handleUpdate(update);} catch (e) {console.log(`update ${update.update_id}: ${e.stack || e.message}`);}
    store.save();
  }
}
