// Запускает настоящий bot.mjs против заглушки Telegram: опрос, отправка, запись базы на диск.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {spawn} from 'node:child_process';
import {fileURLToPath} from 'node:url';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test('bot.mjs: /start по ссылке → приветствие, база на диске', async () => {
  const sent = [];
  let served = false;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', c => body += c);
    req.on('end', () => {
      const method = req.url.split('/').pop();
      const payload = body ? JSON.parse(body) : {};
      const reply = result => res.end(JSON.stringify({ok: true, result}));
      if (method === 'getMe') return reply({id: 1, username: 'test_bot'});
      if (method === 'getUpdates') {
        if (!served) {
          served = true;
          return reply([{update_id: 10, message: {message_id: 1, from: {id: 42, first_name: 'Аня'}, chat: {id: 42, type: 'private'}, text: '/start site_lesson__hero'}}]);
        }
        return setTimeout(() => reply([]), 300);
      }
      if (method === 'sendMessage') sent.push(payload);
      reply({message_id: 5, chat: {id: payload.chat_id}});
    });
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'botbaza-'));
  const child = spawn(process.execPath, ['bot.mjs'], {cwd: root, env: {...process.env, BOT_TOKEN: '1:test', API_BASE: `http://127.0.0.1:${server.address().port}`, DATA_DIR: dataDir}});
  let out = '';
  child.stdout.on('data', d => out += d);
  child.stderr.on('data', d => out += d);
  try {
    for (let i = 0; i < 50 && !sent.some(m => m.chat_id === 42); i++) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 600));
    const hello = sent.find(m => m.chat_id === 42);
    assert.ok(hello, `бот не ответил. Вывод:\n${out}`);
    assert.match(hello.text, /Сейчас покажу как/);
    assert.equal(hello.reply_markup.inline_keyboard[0][0].callback_data, 'a:take_lesson');
    const db = JSON.parse(fs.readFileSync(path.join(dataDir, 'db.json'), 'utf8'));
    assert.equal(db.offset, 11);
    assert.equal(db.users[42].source, 'site_lesson__hero');
    assert.match(out, /Бот @test_bot запущен/);
  } finally {
    child.kill();
    server.close();
  }
});
