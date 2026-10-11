/**
 * Сборка статики в dist/ без зависимостей.
 */
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');
const out = path.join(root, 'dist');
const items = ['index.html', 'assets', 'README.md'];

fs.rmSync(out, { recursive: true, force: true });

for (const item of items) {
  const src = path.join(root, item);
  if (!fs.existsSync(src)) continue;
  fs.cpSync(src, path.join(out, item), { recursive: true });
}

console.log('Готово → dist/');