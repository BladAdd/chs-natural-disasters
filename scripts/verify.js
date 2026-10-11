/* Проверка проекта перед сборкой: структура, автор, картинки, разметка */
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
let fail = 0;
const ok = (c, m) => { console.log((c ? '✓ ' : '✗ ') + m); if (!c) fail++; };

// 1. Слайды
const slides = [...html.matchAll(/<section class="slide[^"]*"[^>]*data-title="([^"]+)"/g)].map(m => m[1]);
ok(slides.length === 25, 'слайдов ровно 25 (найдено ' + slides.length + ')');
ok(new Set(slides).size === slides.length, 'у всех слайдов уникальные заголовки');

// 2. Автор
ok(/Влад Шинкоренко/.test(html), 'автор «Влад Шинкоренко» указан');

// 3. Разметка: незакрытые class="small"
ok(!/<span class="small>/.test(html), 'нет незакрытых <span class="small>');

// 4. Английские слова в тексте
const text = html.replace(/<script[\s\S]*?<\/script>/g, '').replace(/<svg[\s\S]*?<\/svg>/g, '').replace(/<[^>]+>/g, ' ');
const eng = [...new Set((text.match(/\b[a-z]{4,}\b/gi) || []).filter(w => /^(power|bank|check|start|close|open|level|image|photo|slide|link|news|team|read|show|save|view|help|stop|call|the|and|with)$/i.test(w)))];
ok(!eng.length, 'нет английских слов в тексте' + (eng.length ? ': ' + eng.join(', ') : ''));

// 5. Изображения
const imgs = [...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(m => m[1]);
const missing = imgs.filter(s => !fs.existsSync(path.join(ROOT, s)));
ok(!missing.length, 'все ' + imgs.length + ' изображений на месте' + (missing.length ? '; нет: ' + missing.join(', ') : ''));

// 6. Манифест
try {
  const mf = JSON.parse(fs.readFileSync(path.join(ROOT, 'assets/img/manifest.json'), 'utf8'));
  ok(Object.keys(mf).length > 20, 'манифест фото читается, записей: ' + Object.keys(mf).length);
} catch (e) { ok(false, 'манифест фото: ' + e.message); }

// 7. Данные глобуса
for (const f of ['quakes-world.csv', 'quakes-russia.csv', 'quakes-orenburg.csv']) {
  const p = path.join(ROOT, 'assets/data', f);
  ok(fs.existsSync(p) && fs.statSync(p).size > 1000, 'каталог ' + f + ' на месте');
}
ok(fs.existsSync(path.join(ROOT, 'assets/data/hazards.json')), 'hazards.json на месте');

// 8. three.js
ok(fs.existsSync(path.join(ROOT, 'assets/vendor/three.module.js')) && fs.existsSync(path.join(ROOT, 'assets/vendor/three.core.js')),
  'three.js (module + core) на месте');

// 9. Раздел «Что делать»
const doSlides = slides.filter(s => /^Что делать/.test(s));
ok(doSlides.length >= 4, 'раздел «Что делать»: ' + doSlides.length + ' слайда');

// 10. Россия / Оренбуржье — по содержанию слайда, а не только по заголовку
const sections = html.split(/<section class="slide/).slice(1);
const roSlides = sections.filter(s => {
  const t = s.replace(/<[^>]+>/g, ' ');
  return /Россия|России|российск|Оренбург|Оренбурж|наш регион|Урал/i.test(t);
});
ok(roSlides.length >= 4, 'слайдов с содержанием про Россию/Оренбуржье: ' + roSlides.length);

// 11. Нет wheel-навигации
const app = fs.readFileSync(path.join(ROOT, 'assets/js/app.js'), 'utf8');
ok(!/wheel/.test(app), 'в app.js нет обработчика колеса мыши');

// 12. Авто-масштаб
ok(/function fitSlide/.test(app), 'авто-масштаб слайдов подключён');

console.log(fail ? '\n✗ Проблем: ' + fail : '\n✓ Все проверки пройдены');
process.exit(fail ? 1 : 0);