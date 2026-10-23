// Загрузка файла с компьютера в слот бота: node upload.mjs guide_claude "C:\путь\файл.zip"
// Файл уходит первому админу в личку с ботом, его file_id записывается в data/db.json.
// Только для локальной копии и только при остановленном боте (иначе бот перезапишет базу).
// Лимит Bot API на загрузку — 50 МБ; урок больше — грузить из Telegram: /set lesson_video и прислать файл боту.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {openStore} from './store.mjs';
import {slots, settings} from './content.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const [slot, file] = process.argv.slice(2);
if (!slots[slot] || !file || !fs.existsSync(file)) {console.error(`Использование: node upload.mjs <слот> <файл>\nСлоты: ${Object.keys(slots).join(', ')}`); process.exit(1);}
const token = (process.env.BOT_TOKEN || fs.readFileSync(path.join(root, '.token'), 'utf8')).trim();
const admin = Number(process.env.ADMIN_IDS?.split(',')[0] || [].concat(settings.admins)[0]);

const ext = path.extname(file).toLowerCase();
const type = ['.mp4', '.mov'].includes(ext) ? 'video' : ['.jpg', '.jpeg', '.png'].includes(ext) ? 'photo' : ['.ogg', '.oga'].includes(ext) ? 'voice' : 'document';
const method = {video: 'sendVideo', photo: 'sendPhoto', voice: 'sendVoice', document: 'sendDocument'}[type];

const form = new FormData();
form.set('chat_id', String(admin));
form.set('caption', `Слот ${slot}: ${path.basename(file)}`);
form.set(type, new Blob([fs.readFileSync(file)]), path.basename(file));
const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {method: 'POST', body: form});
const result = await response.json();
if (!result.ok) {console.error(`Telegram: ${result.description}`); process.exit(1);}
const message = result.result;
const media = type === 'photo' ? message.photo.at(-1) : message[type] || message.document || message.animation;
const store = openStore(process.env.DATA_DIR || path.join(root, 'data'));
store.data.media[slot] = {type: message[type] || type === 'photo' ? type : 'document', file_id: media.file_id, name: path.basename(file)};
store.flush();
console.log(`Готово: ${slot} ← ${path.basename(file)} (${store.data.media[slot].type})`);
