// Хранилище: один JSON-файл. Запись через временный файл, чтобы при сбое не потерять базу.
import fs from 'node:fs';
import path from 'node:path';

export function openStore(dir) {
  fs.mkdirSync(dir, {recursive: true});
  const file = path.join(dir, 'db.json');
  const data = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  for (const key of ['users', 'media', 'config', 'razbor', 'replies', 'pending']) data[key] ??= {};
  data.offset ??= 0;
  let timer = null;
  const flush = () => {
    timer = null;
    fs.writeFileSync(file + '.tmp', JSON.stringify(data));
    fs.renameSync(file + '.tmp', file);
  };
  return {
    data,
    save() {timer ??= setTimeout(flush, 200);},
    flush() {if (timer) clearTimeout(timer); flush();},
  };
}

// Для тестов: та же поверхность без диска.
export function memoryStore(data = {}) {
  for (const key of ['users', 'media', 'config', 'razbor', 'replies', 'pending']) data[key] ??= {};
  data.offset ??= 0;
  return {data, save() {}, flush() {}};
}
