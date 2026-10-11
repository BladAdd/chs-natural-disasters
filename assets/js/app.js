/* ============================================================
   Презентация «ЧС природного характера» — логика показа
   ============================================================ */
(function () {
  'use strict';

  /* ---------- 1. Разметка и состояние ---------- */
  var slides   = Array.prototype.slice.call(document.querySelectorAll('.slide'));
  var dotsWrap = document.getElementById('dots');
  var ovGrid   = document.getElementById('ovGrid');
  var overview = document.getElementById('overview');
  var progress = document.getElementById('progress');
  var curNum   = document.getElementById('curNum');
  var totNum   = document.getElementById('totNum');
  var btnPrev  = document.getElementById('btnPrev');
  var btnNext  = document.getElementById('btnNext');
  var hint     = document.getElementById('hint');

  var TOTAL = slides.length;
  var idx = 0;

  totNum.textContent = TOTAL;

  /* ---------- 2. Точки и карточки обзора ---------- */
  var dots = [], ovItems = [];

  slides.forEach(function (s, i) {
    var title = s.getAttribute('data-title') || ('Слайд ' + (i + 1));

    var d = document.createElement('button');
    d.className = 'dot-btn';
    d.setAttribute('data-title', title);
    d.setAttribute('aria-label', title);
    d.addEventListener('click', function () { go(i); });
    dotsWrap.appendChild(d);
    dots.push(d);

    var o = document.createElement('button');
    o.className = 'ov-item';
    o.innerHTML = '<span class="n">' + String(i + 1).padStart(2, '0') + '</span><span class="t">' + title + '</span>';
    o.addEventListener('click', function () { closeOverview(); go(i); });
    ovGrid.appendChild(o);
    ovItems.push(o);
  });

  /* ---------- 3. Переход между слайдами ---------- */
  function go(n) {
    if (n < 0 || n >= TOTAL || n === idx) {
      if (n === idx) return;
      return;
    }
    var from = slides[idx];
    var to   = slides[n];

    from.classList.add('is-leaving');
    from.classList.remove('is-active');

    setTimeout(function () {
      from.classList.remove('is-leaving');
    }, 340);

    to.scrollTop = 0;
    var inner = to.querySelector('.slide-inner');
    if (inner) inner.scrollTop = 0;

    to.classList.add('is-active');
    idx = n;
    paint();

    /* 3D-карта: создаём при первом показе, останавливаем рендер вне слайда */
    if (window.globeAPI) {
      if (to.classList.contains('globe-slide')) {
        window.globeAPI.ensure();
        window.globeAPI.active(true);
      } else if (from.classList.contains('globe-slide')) {
        window.globeAPI.active(false);
      }
    }
  }

  function next() { if (idx < TOTAL - 1) go(idx + 1); }
  function prev() { if (idx > 0) go(idx - 1); }

  function paint() {
    progress.style.width = (TOTAL > 1 ? (idx / (TOTAL - 1)) * 100 : 100) + '%';
    curNum.textContent = idx + 1;
    btnPrev.disabled = idx === 0;
    btnNext.disabled = idx === TOTAL - 1;

    dots.forEach(function (d, i) {
      d.classList.toggle('is-on', i === idx);
      d.style.opacity = Math.abs(i - idx) <= 2 ? '1' : '.35';
    });
    ovItems.forEach(function (o, i) { o.classList.toggle('is-current', i === idx); });
  }

  /* ---------- 4. Управление ---------- */
  btnNext.addEventListener('click', next);
  btnPrev.addEventListener('click', prev);

  function openOverview()  { overview.classList.add('is-open'); }
  function closeOverview() { overview.classList.remove('is-open'); }
  function toggleOverview() { overview.classList.toggle('is-open'); }
  document.getElementById('btnOverview').addEventListener('click', toggleOverview);

  document.addEventListener('keydown', function (e) {
    if (e.target.matches('input, textarea')) return;

    switch (e.key) {
      case 'ArrowRight':
      case 'PageDown':
      case ' ':
      case 'Enter':
        e.preventDefault(); next(); break;
      case 'ArrowLeft':
      case 'PageUp':
      case 'Backspace':
        e.preventDefault(); prev(); break;
      case 'Home':
        e.preventDefault(); go(0); break;
      case 'End':
        e.preventDefault(); go(TOTAL - 1); break;
      case 'o': case 'O': case 'щ': case 'Щ':
        e.preventDefault(); toggleOverview(); break;
      case 'f': case 'F': case 'а': case 'А':
        e.preventDefault(); toggleFullscreen(); break;
      case 'Escape':
        if (overview.classList.contains('is-open')) { e.preventDefault(); closeOverview(); }
        break;
    }
  });

  function toggleFullscreen() {
    var d = document;
    if (!d.fullscreenElement && !d.webkitFullscreenElement) {
      (d.documentElement.requestFullscreen || d.documentElement.webkitRequestFullscreen).call(d.documentElement);
    } else {
      (d.exitFullscreen || d.webkitExitFullscreen).call(d);
    }
  }

  /* Свайпы на телефоне/планшете */
  var tx = 0, ty = 0;
  document.addEventListener('touchstart', function (e) {
    tx = e.changedTouches[0].clientX;
    ty = e.changedTouches[0].clientY;
  }, { passive: true });

  document.addEventListener('touchend', function (e) {
    var dx = e.changedTouches[0].clientX - tx;
    var dy = e.changedTouches[0].clientY - ty;
    if (Math.abs(dx) > 60 && Math.abs(dx) > Math.abs(dy) * 1.6) {
      dx < 0 ? next() : prev();
    }
  }, { passive: true });

  /* Прокрутка колесом мыши НЕ переключает слайды.
     Колесо просто прокручивает содержимое слайда, если оно не помещается.
     Слайды листаются стрелками, пробелом, кнопками или свайпом. */

  /* Прячем подсказку после первого действия */
  var hideHint = function () {
    document.body.classList.add('user-active');
    document.removeEventListener('keydown', hideHint);
    btnNext.removeEventListener('click', hideHint);
  };
  document.addEventListener('keydown', hideHint);
  btnNext.addEventListener('click', hideHint);

  /* ---------- 5. Лайтбокс для фотографий ---------- */
  var lightbox = document.getElementById('lightbox');
  var lbImg = document.getElementById('lbImg');
  var lbCap = document.getElementById('lbCap');

  function openLightbox(fig) {
    var img = fig.querySelector('img');
    var cap = fig.querySelector('figcaption');
    if (!img) return;
    lbImg.src = img.getAttribute('src');
    lbImg.alt = img.alt || '';
    lbCap.innerHTML = cap ? cap.innerHTML : '';
    lightbox.classList.add('is-open');
  }

  function closeLightbox() {
    lightbox.classList.remove('is-open');
    lbImg.src = '';
  }

  document.addEventListener('click', function (e) {
    var fig = e.target.closest ? e.target.closest('.photo') : null;
    if (!fig) return;
    if (lightbox.contains(e.target)) { closeLightbox(); return; }
    openLightbox(fig);
  });

  document.getElementById('lbClose').addEventListener('click', closeLightbox);

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && lightbox.classList.contains('is-open')) {
      e.preventDefault();
      closeLightbox();
    }
  });

  /* ---------- 6. Мини-тест ---------- */
  var QUESTIONS = [
    {
      q: 'Что такое цунами и чем оно опасно для человека?',
      opts: [
        'Обычная большая волна, которую видно заранее',
        'Серия волн от подводного землетрясения: в открытом море невысокая, у берега — стена воды',
        'Ледяной покров, сползающий с горы',
        'Область повышенной сейсмичности'
      ],
      a: 1,
      why: 'Цуunami незаметна вдали от берега (высота 0,5–1,5 м), но у берега вырастает до десятков метров и сносит всё на пути.'
    },
    {
      q: 'Первое, что нужно сделать при появлении признаков цунами:',
      opts: [
        'Побежать к воде посмотреть, как отступает море',
        'Спрятаться под машину и ждать',
        'Немедленно уйти вверх — на возвышенность или дальше от берега',
        'Включить камеру и снять видео'
      ],
      a: 2,
      why: 'Отступление воды — это сигнал, а не зрелище. Бежать надо ВВЕРХ и в сторону, а не поперёк потока и не к воде.'
    },
    {
      q: 'Почему торнадо опасен?',
      opts: [
        'Он длится неделями и выжигает всё живое',
        'В нём вращается воздух со скоростью 300–500 км/ч, он поднимает машины и людей',
        'Он вызывает радиоактивное заражение',
        'Он поджигает леса'
      ],
      a: 1,
      why: 'Торнадо — узкий, но крайне разрушительный вихрь. Достаточно спрятаться в подвале или внутреннем помещении.'
    },
    {
      q: 'Почему нельзя тушить торфяной пожар водой?',
      opts: [
        'Вода не горит',
        'Торфяной пожар горит под землёй — вода превращается в пар и усиливает горение',
        'Вода тушит пожар, но земля остаётся горячей',
        'Нужна только пена'
      ],
      a: 1,
      why: 'Горение идёт под землёй без открытого пламени. Вода лишь создаёт пар и гонит жар вглубь.'
    },
    {
      q: 'Что из перечисленного — признак приближающегося оползня?',
      opts: [
        'Трещины на склоне и уход животных со склона',
        'Солнечная погода',
        'Понижение давления',
        'Ранний выпадение снега'
      ],
      a: 0,
      why: 'Трещины и массовое поведение животных — самые надёжные природные «предупреждения». Уходить нужно поперёк склона и вверх.'
    },
    {
      q: 'Главное правило при любой ЧС:',
      opts: [
        'Сначала спасти имущество',
        'Снимать происходящее на телефон для соцсетей',
        'Сохранить жизнь и здоровье людей и выполнять сигналы тревоги',
        'Идти в зону ЧС, чтобы помочь лично'
      ],
      a: 2,
      why: 'Жизнь человека невосполнима, а имущество — нет. И самопомощь: позвонить 112, оценить обстановку, помочь пострадавшим.'
    },
    {
      q: 'Какая природная опасность для Оренбургской области наиболее характерна?',
      opts: [
        'Цунами',
        'Засуха, суховеи и пыльные бури',
        'Вулканическая активность',
        'Постоянные смерчи'
      ],
      a: 1,
      why: 'Климат Оренбуржья резко континентальный: осадков мало, а летом выпадает большая их часть. Поэтому засуха, суховеи и пыльные бури — главные природные риски региона.'
    },
    {
      q: 'Сколько осадков в среднем выпадает в Оренбургской области за год?',
      opts: [
        '350–450 мм',
        '1000–1200 мм',
        '50–100 мм',
        '2000 мм и более'
      ],
      a: 0,
      why: 'Годовая сумма осадков — от 450 мм на северо-западе до 350 мм на юге и юго-востоке области. 60–70% приходится на тёплый период, поэтому летом бывают засухи.'
    },
    {
      q: 'Какая река протекает по Оренбургской области?',
      opts: [
        'Волга',
        'Енисей',
        'Урал',
        'Лена'
      ],
      a: 2,
      why: 'Урал — одна из крупнейших рек европейской части России (2428 км), из них 1164 км проходит по Оренбургской области. Также здесь текут Сакмара, Илек и Самара.'
    }
  ];

  var qi = 0, score = 0, answered = false;
  var qText = document.getElementById('qText');
  var qOpts = document.getElementById('qOpts');
  var qNumEl = document.getElementById('qNum');
  var qTotalEl = document.getElementById('qTotal');
  var qScoreEl = document.getElementById('qScore');
  var qFb = document.getElementById('qFeedback');
  var qNext = document.getElementById('qNext');
  var qBar = document.getElementById('qBar');

  qTotalEl.textContent = QUESTIONS.length;

  function renderQuestion() {
    var item = QUESTIONS[qi];
    answered = false;
    qText.textContent = item.q;
    qOpts.innerHTML = '';
    qFb.className = 'q-feedback';
    qFb.textContent = '';
    qNext.disabled = true;
    qNext.textContent = (qi === QUESTIONS.length - 1) ? 'Показать результат' : 'Следующий вопрос';
    qNumEl.textContent = qi + 1;
    qBar.style.width = (qi / QUESTIONS.length) * 100 + '%';

    item.opts.forEach(function (text, i) {
      var b = document.createElement('button');
      b.className = 'q-opt';
      b.innerHTML = '<span class="mark">' + String.fromCharCode(65 + i) + '</span><span>' + text + '</span>';
      b.addEventListener('click', function () { answer(i, b); });
      qOpts.appendChild(b);
    });
  }

  function answer(i, btn) {
    if (answered) return;
    answered = true;
    var item = QUESTIONS[qi];
    var all = qOpts.querySelectorAll('.q-opt');

    all.forEach(function (b) { b.classList.add('locked'); b.style.cursor = 'default'; });

    if (i === item.a) {
      btn.classList.add('correct');
      score++;
      qScoreEl.textContent = score;
      qFb.className = 'q-feedback ok show';
      qFb.innerHTML = '✅ <b>Верно!</b> ' + item.why;
    } else {
      btn.classList.add('wrong');
      all[item.a].classList.add('correct');
      qFb.className = 'q-feedback no show';
      qFb.innerHTML = '❌ <b>Не совсем.</b> ' + item.why;
    }
    qNext.disabled = false;
    qBar.style.width = ((qi + 1) / QUESTIONS.length) * 100 + '%';
  }

  qNext.addEventListener('click', function () {
    if (qi < QUESTIONS.length - 1) { qi++; renderQuestion(); return; }
    showResult();
  });

  function showResult() {
    var pct = Math.round((score / QUESTIONS.length) * 100);
    var verdict = pct >= 85 ? 'Отлично! Ты отлично усвоил материал 🎉'
                : pct >= 55 ? 'Хорошо! Основное понял, но повтори правила защиты 💪'
                : 'Стоит повторить тему ещё раз — и обязательно перечитай памятку 📚';

    qText.textContent = 'Твой результат: ' + score + ' из ' + QUESTIONS.length + ' (' + pct + '%)';
    qOpts.innerHTML = '';
    qFb.className = 'q-feedback ok show';
    qFb.textContent = verdict;
    qNext.disabled = true;
    qNext.textContent = 'Тест пройден';

    var list = document.getElementById('qExplain');
    list.innerHTML = QUESTIONS.map(function (q, i) {
      return '<li><b>Вопрос ' + (i + 1) + ':</b> ' + q.why + '</li>';
    }).join('');

    var res = document.getElementById('qResult');
    res.style.display = 'block';
    res.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }

  renderQuestion();

  /* ---------- 7. Старт ---------- */
  slides[0].classList.add('is-active');
  paint();

  /* Предупреждаем о полноэкранном режиме по первому клику в пустое место */
  document.addEventListener('click', function () {
    document.body.classList.add('user-active');
  }, { once: true });
})();