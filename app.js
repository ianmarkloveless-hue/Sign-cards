/* Sign Cards — BSL flashcards.
   Plain JavaScript, no build step. Data comes from ./data/ (built by tools/crawl.py).
   Videos are streamed from signbsl.com and are not copied or stored. */

(function () {
  'use strict';

  var MEDIA = 'https://media.signbsl.com/videos/bsl/';
  var FAV_KEY = 'signcards.favourites.v1';
  var SET_KEY = 'signcards.settings.v1';
  var MAX_BOX = 5;
  /* A card is still being learnt until it has been answered correctly this
     many times, and is favoured by BOOST until then. Correct answers rather
     than sightings, so a word you keep getting wrong stays in the learning
     phase instead of ageing out of it. */
  var GRADUATE = 2;
  var BOOST = 3;
  /* How many never-seen cards a practice session opens with, so a batch added
     after a lesson is gone through while the signs are still fresh. A cap, not
     a quota: once nothing is unseen, practice carries on as normal. It only
     matters after a large import, since a session rarely runs this long. */
  var INTAKE = 50;

  var words = null;          // [[word, slug], ...]
  var shards = {};           // letter -> {slug: entry}
  var favs = load(FAV_KEY, {});
  var settings = load(SET_KEY, { mode: 'productive', starterLoaded: false });

  var current = null;        // card being practised
  var lastId = null;
  var revealed = false;
  var intakeLeft = 0;        // never-seen cards still owed at the start of this session

  var $ = function (s) { return document.querySelector(s); };
  var $$ = function (s) { return Array.prototype.slice.call(document.querySelectorAll(s)); };

  /* ---------------- storage ---------------- */

  function load(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (e) { return fallback; }
  }

  function save(key, value) {
    try { localStorage.setItem(key, JSON.stringify(value)); }
    catch (e) { toast('Could not save — phone storage is full.'); }
  }

  var saveFavs = function () { save(FAV_KEY, favs); refreshDeckMarks(); };
  var saveSettings = function () { save(SET_KEY, settings); };

  function toast(msg) {
    var t = $('#toast');
    t.textContent = msg;
    t.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(function () { t.hidden = true; }, 2600);
  }

  /* ---------------- dictionary ---------------- */

  function letterOf(slug) {
    var c = (slug || '').charAt(0).toLowerCase();
    return c >= 'a' && c <= 'z' ? c : '0';
  }

  function videoUrl(u) {
    return u.slice(0, 4) === 'http' ? u : MEDIA + u;
  }

  function loadWords() {
    if (words) return Promise.resolve(words);
    return fetch('./data/words.json')
      .then(function (r) { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then(function (d) { words = d.words || []; return words; });
  }

  function loadShard(letter) {
    if (shards[letter]) return Promise.resolve(shards[letter]);
    return fetch('./data/index/' + letter + '.json')
      .then(function (r) { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then(function (d) { shards[letter] = d; return d; });
  }

  function getEntry(slug) {
    return loadShard(letterOf(slug)).then(function (s) {
      /* hasOwnProperty, not s[slug]: "constructor" is a real headword and would
         otherwise match the one inherited from Object.prototype. */
      return Object.prototype.hasOwnProperty.call(s, slug) ? s[slug] : null;
    });
  }

  /* ---------------- deck marks ---------------- */

  /* A star beside a word means at least one of its clips is already in the
     deck, so search and explore show at a glance what has been collected. */

  function deckSlugs() {
    /* No prototype: "constructor" is a real headword. */
    var set = Object.create(null);
    Object.keys(favs).forEach(function (k) {
      if (favs[k] && favs[k].slug) set[favs[k].slug] = true;
    });
    return set;
  }

  function deckMark() {
    var s = document.createElement('span');
    s.className = 'indeck';
    s.innerHTML = '<span aria-hidden="true">&#9733;</span>' +
                  '<span class="sr-only"> in your deck</span>';
    return s;
  }

  /* Anything carrying data-slug gets its star kept in step with the deck.
     Called from saveFavs, so every route that changes the deck is covered. */
  function refreshDeckMarks() {
    var inDeck = deckSlugs();
    $$('[data-slug]').forEach(function (el) {
      var mark = el.querySelector('.indeck');
      if (inDeck[el.getAttribute('data-slug')]) {
        if (!mark) el.appendChild(deckMark());
      } else if (mark) {
        el.removeChild(mark);
      }
    });
  }

  /* ---------------- search ---------------- */

  var searchTimer = null;

  $('#q').addEventListener('input', function () {
    clearTimeout(searchTimer);
    var q = this.value;
    $('#q-clear').hidden = !q;
    searchTimer = setTimeout(function () { runSearch(q); }, 140);
  });

  $('#q-clear').addEventListener('click', function () {
    var q = $('#q');
    q.value = '';
    this.hidden = true;
    q.focus();
    runSearch('');
  });

  function runSearch(raw) {
    var q = raw.trim().toLowerCase();
    var box = $('#search-results');
    $('#word-view').hidden = true;
    box.hidden = false;

    if (q.length < 1) { box.innerHTML = emptySearch(); return; }

    loadWords().then(function (list) {
      var starts = [], contains = [];
      for (var i = 0; i < list.length && starts.length + contains.length < 400; i++) {
        var w = list[i][0].toLowerCase();
        if (w === q || w.indexOf(q) === 0) starts.push(list[i]);
        else if (w.indexOf(q) > -1) contains.push(list[i]);
      }
      starts.sort(function (a, b) { return a[0].length - b[0].length; });
      var hits = starts.concat(contains).slice(0, 60);

      if (!hits.length) {
        box.innerHTML = '<p class="hint">No match for &ldquo;' + esc(raw.trim()) + '&rdquo;. ' +
          'Try a shorter word, or look it up on <a href="https://www.signbsl.com/" target="_blank" rel="noopener">signbsl.com</a>.</p>';
        return;
      }

      box.innerHTML = '';
      var inDeck = deckSlugs();
      hits.forEach(function (h) {
        var b = document.createElement('button');
        b.className = 'result';
        b.type = 'button';
        b.setAttribute('data-slug', h[1]);
        b.innerHTML = '<b>' + esc(h[0]) + '</b>';
        if (inDeck[h[1]]) b.appendChild(deckMark());
        b.addEventListener('click', function () { openWord(h[1], h[0]); });
        box.appendChild(b);
      });
    }).catch(function () { box.innerHTML = noIndexMessage(); });
  }

  function emptySearch() {
    return '<p class="hint">Type a word to see how it is signed. Tap the star under any video to ' +
      'put it in your deck.</p>';
  }

  function noIndexMessage() {
    return '<p class="hint">The dictionary has not been built yet. On GitHub, open the Actions tab and run ' +
      '<b>Build dictionary</b>, then reload this page. Full instructions are in the README.</p>';
  }

  function esc(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  /* ---------------- word view ---------------- */

  /* Used by both search and explore, so a word looks the same either way. */
  function renderSenses(container, entry, slug, word) {
    var h = document.createElement('h1');
    h.className = 'headword';
    h.textContent = word;
    h.setAttribute('data-slug', slug);
    if (deckSlugs()[slug]) h.appendChild(deckMark());
    container.appendChild(h);

    if (!entry || !entry.senses || !entry.senses.length) {
      container.insertAdjacentHTML('beforeend', '<p class="hint">No videos stored for this word.</p>');
      return;
    }

    entry.senses.forEach(function (sense) {
      var sec = document.createElement('div');
      sec.className = 'sense';
      if (sense.def) {
        sec.insertAdjacentHTML('beforeend', '<p class="def">' + esc(sense.def) + '</p>');
      }
      (sense.videos || []).forEach(function (vid) {
        sec.appendChild(clipEl(vid, slug, word, sense.def || ''));
      });
      container.appendChild(sec);
    });
  }

  function openWord(slug, word) {
    getEntry(slug).then(function (entry) {
      var v = $('#word-view');
      $('#search-results').hidden = true;
      v.hidden = false;
      v.innerHTML = '';
      window.scrollTo(0, 0);

      var back = document.createElement('button');
      back.className = 'back';
      back.type = 'button';
      back.textContent = '\u2039 Back to results';
      back.addEventListener('click', function () {
        v.hidden = true;
        $('#search-results').hidden = false;
      });
      v.appendChild(back);

      renderSenses(v, entry, slug, word);
      /* Put the word itself at the top. Bringing only the clip into view left
         the headword and definition stranded part way down the results list,
         or scrolled nothing at all when the clip already happened to be on
         screen. The gap for the sticky search bar is set in the stylesheet. */
      v.scrollIntoView({ block: 'start' });
    }).catch(function () {
      $('#search-results').innerHTML = noIndexMessage();
    });
  }

  /* A clip with its own tap-to-play overlay instead of the native controls,
     which on iOS sit on top of the sign and fade out too slowly to read it. */
  function makeVideo(u, autoplay) {
    var wrap = document.createElement('div');
    wrap.className = 'vid';

    var v = document.createElement('video');
    /* The #t fragment makes the browser paint that frame as a still rather than
       leaving a black box until the clip is played. */
    v.src = videoUrl(u) + '#t=0.001';
    v.loop = true;
    v.muted = true;
    v.playsInline = true;
    v.setAttribute('playsinline', '');
    v.setAttribute('webkit-playsinline', '');
    v.setAttribute('muted', '');
    v.preload = autoplay ? 'auto' : 'metadata';
    wrap.appendChild(v);

    var tap = document.createElement('button');
    tap.className = 'playpause';
    tap.type = 'button';
    tap.setAttribute('aria-label', 'Play or pause');
    wrap.appendChild(tap);

    function sync() { wrap.classList.toggle('is-playing', !v.paused); }
    v.addEventListener('play', sync);
    v.addEventListener('pause', sync);
    tap.addEventListener('click', function () {
      if (v.paused) v.play().catch(function () {});
      else v.pause();
    });

    if (autoplay) v.play().catch(function () {});
    return { wrap: wrap, video: v };
  }

  function clipEl(vid, slug, word, def) {
    var id = slug + '#' + (vid.id || vid.u);
    var wrap = document.createElement('div');
    wrap.className = 'clip';

    var made = makeVideo(vid.u, false);
    var video = made.video;
    wrap.appendChild(made.wrap);

    var bar = document.createElement('div');
    bar.className = 'clipbar';

    var star = document.createElement('button');
    star.className = 'star' + (favs[id] ? ' is-on' : '');
    star.type = 'button';
    star.innerHTML = '&#9733;';
    star.setAttribute('aria-label', 'Add to deck');
    star.addEventListener('click', function () {
      if (favs[id]) {
        delete favs[id];
        star.classList.remove('is-on');
        toast('Removed from deck');
      } else {
        favs[id] = newCard(id, word, slug, vid, def);
        star.classList.add('is-on');
        toast('Added to deck');
      }
      saveFavs();
    });
    bar.appendChild(star);

    var who = document.createElement('div');
    who.className = 'who';
    who.textContent = [vid.label, vid.credit].filter(Boolean).join(' \u2014 ');
    bar.appendChild(who);

    [['Slow', 0.5], ['Normal', 1]].forEach(function (pair, i) {
      var b = document.createElement('button');
      b.className = 'speed' + (i === 1 ? ' is-on' : '');
      b.type = 'button';
      b.textContent = pair[0];
      b.addEventListener('click', function () {
        video.playbackRate = pair[1];
        video.play().catch(function () {});
        bar.querySelectorAll('.speed').forEach(function (s) { s.classList.remove('is-on'); });
        b.classList.add('is-on');
      });
      bar.appendChild(b);
    });

    wrap.appendChild(bar);
    return wrap;
  }

  function newCard(id, word, slug, vid, def) {
    return {
      id: id, word: word, slug: slug, u: vid.u,
      label: vid.label || '', credit: vid.credit || '', def: def || '',
      box: 1, last: 0, seen: 0, right: 0, wrong: 0, added: Date.now()
    };
  }

  /* ---------------- explore ---------------- */

  var cats = null;
  var explore = { cat: 'all', random: false, pos: 0, order: null };

  function loadCats() {
    if (cats) return Promise.resolve(cats);
    return fetch('./data/categories.json')
      .then(function (r) { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then(function (d) { cats = d; return d; });
  }

  function catById(id) {
    var list = (cats && cats.categories) || [];
    for (var i = 0; i < list.length; i++) {
      if (list[i].id === id) return list[i];
    }
    return null;
  }

  /* Fills a <select> with "All" plus each group of categories. `only` limits it
     to a set of ids, which is how practise and deck avoid offering a filter
     that would leave nothing to show. */
  function fillCategories(sel, chosen, only) {
    sel.innerHTML = '';
    var all = document.createElement('option');
    all.value = 'all';
    all.textContent = 'All — show me everything';
    sel.appendChild(all);

    ((cats && cats.groups) || []).forEach(function (g) {
      var members = cats.categories.filter(function (c) {
        return c.group === g.id && (!only || only[c.id]);
      });
      if (!members.length) return;
      var og = document.createElement('optgroup');
      og.label = g.name;
      members.forEach(function (c) {
        var o = document.createElement('option');
        o.value = c.id;
        o.textContent = c.name + ' (' + (only ? only[c.id] : c.idx.length).toLocaleString() + ')';
        og.appendChild(o);
      });
      sel.appendChild(og);
    });

    sel.value = chosen && sel.querySelector('option[value="' + chosen + '"]') ? chosen : 'all';
    return sel.value;
  }

  function shuffle(a) {
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(Math.random() * (i + 1));
      var t = a[i]; a[i] = a[j]; a[j] = t;
    }
    return a;
  }

  /* One shuffled copy per category, so Back retraces your steps rather than
     jumping somewhere new. */
  function buildOrder() {
    var list;
    if (explore.cat === 'all') {
      list = [];
      for (var i = 0; i < (words || []).length; i++) list.push(i);
    } else {
      var c = catById(explore.cat);
      list = c ? c.idx.slice() : [];
    }
    explore.order = explore.random ? shuffle(list) : list;
    explore.pos = 0;
  }

  function renderExplore(toTop) {
    var box = $('#explore-word');
    var label = $('#explore-pos');
    var order = explore.order || [];

    if (!order.length) {
      box.innerHTML = '<p class="hint">No words in this category.</p>';
      label.textContent = '';
      $('#explore-prev').disabled = $('#explore-next').disabled = true;
      return;
    }

    explore.pos = Math.max(0, Math.min(explore.pos, order.length - 1));
    $('#explore-prev').disabled = explore.pos === 0;
    $('#explore-next').disabled = explore.pos === order.length - 1;
    label.textContent = (explore.pos + 1).toLocaleString() + ' of ' + order.length.toLocaleString();

    var pair = words[order[explore.pos]];
    getEntry(pair[1]).then(function (entry) {
      box.innerHTML = '';
      renderSenses(box, entry, pair[1], pair[0]);
      /* Once the new word is in the DOM, not before: scrolling while the old
         one is still rendered leaves the position to be undone by the swap. */
      if (toTop) settleToTop(box);
    }).catch(function () {
      box.innerHTML = noIndexMessage();
    });
  }

  /* Scrolling once is not enough. Clips that are not the 4:3 the layout
     reserves change height when their metadata lands, and the browser shifts
     the page to keep what it was showing steady, which carries the headword
     back off the top. Re-assert the top as each clip reports in, but give way
     the moment the reader scrolls for themselves. */
  function settleToTop(container) {
    window.scrollTo(0, 0);

    var waiting = Array.prototype.slice.call(container.querySelectorAll('video'))
      .filter(function (v) { return !v.videoHeight; });
    if (!waiting.length) return;

    var live = true;
    function release() {
      live = false;
      window.removeEventListener('touchstart', release);
      window.removeEventListener('wheel', release);
    }
    window.addEventListener('touchstart', release, { passive: true });
    window.addEventListener('wheel', release, { passive: true });
    setTimeout(release, 4000);

    waiting.forEach(function (v) {
      v.addEventListener('loadedmetadata', function () {
        if (live && window.scrollY !== 0) window.scrollTo(0, 0);
      }, { once: true });
    });
  }

  function setOrderButtons() {
    $('#order-az').classList.toggle('is-on', !explore.random);
    $('#order-random').classList.toggle('is-on', explore.random);
  }

  function openExplore() {
    return Promise.all([loadWords(), loadCats()]).then(function () {
      if (!$('#explore-cat').options.length) {
        explore.cat = fillCategories($('#explore-cat'), settings.exploreCat);
        explore.random = !!settings.exploreRandom;
        setOrderButtons();
        buildOrder();
      }
      renderExplore();
    }).catch(function () {
      $('#explore-word').innerHTML = noIndexMessage();
      $('#explore-pos').textContent = '';
    });
  }

  $('#explore-cat').addEventListener('change', function () {
    explore.cat = this.value;
    settings.exploreCat = this.value;
    saveSettings();
    buildOrder();
    window.scrollTo(0, 0);
    renderExplore(true);
  });

  $('#explore-prev').addEventListener('click', function () {
    explore.pos--;
    window.scrollTo(0, 0);
    renderExplore(true);
  });

  $('#explore-next').addEventListener('click', function () {
    explore.pos++;
    window.scrollTo(0, 0);
    renderExplore(true);
  });

  [['#order-az', false], ['#order-random', true]].forEach(function (pair) {
    $(pair[0]).addEventListener('click', function () {
      if (explore.random === pair[1]) return;
      explore.random = pair[1];
      settings.exploreRandom = pair[1];
      saveSettings();
      setOrderButtons();
      buildOrder();
      renderExplore();
    });
  });

  /* ---------------- scheduling ---------------- */

  function deck() {
    return Object.keys(favs).map(function (k) { return favs[k]; });
  }

  var slugCats = null;

  function buildSlugCats() {
    if (slugCats) return slugCats;
    if (!cats || !words) return {};   // not loaded yet; don't cache an empty map
    /* No prototype: the dictionary contains the word "constructor", and on a
       plain object that key already holds a function. */
    slugCats = Object.create(null);
    ((cats && cats.categories) || []).forEach(function (c) {
      c.idx.forEach(function (i) {
        var pair = words && words[i];
        if (!pair) return;
        (slugCats[pair[1]] || (slugCats[pair[1]] = [])).push(c.id);
      });
    });
    return slugCats;
  }

  function deckIn(catId) {
    var d = deck();
    if (!catId || catId === 'all' || !cats) return d;
    var map = buildSlugCats();
    return d.filter(function (card) {
      var list = map[card.slug];
      return list && list.indexOf(catId) > -1;
    });
  }

  /* How many cards sit in each category, so practise and deck can offer only
     the categories you actually hold cards in. */
  function deckCatCounts() {
    var map = buildSlugCats();
    var counts = Object.create(null);
    deck().forEach(function (card) {
      (map[card.slug] || []).forEach(function (id) {
        counts[id] = (counts[id] || 0) + 1;
      });
    });
    return counts;
  }

  function pickCard() {
    var d = deckIn(settings.practiseCat);
    if (!d.length) return null;
    if (d.length === 1) return d[0];

    var pool = d.filter(function (c) { return c.id !== lastId; });

    /* Open the session with whatever has never been seen, oldest addition
       first so a backlog drains in the order it arrived. */
    if (intakeLeft > 0) {
      var unseen = pool.filter(function (c) { return !c.seen; });
      if (unseen.length) {
        intakeLeft--;
        unseen.sort(function (a, b) { return (a.added || 0) - (b.added || 0); });
        return unseen[0];
      }
    }

    var now = Date.now();
    var total = 0;
    var weights = pool.map(function (c) {
      /* A card never seen counts as fully overdue rather than a week old,
         so it outranks anything merely neglected instead of sitting below it. */
      var days = c.last ? (now - c.last) / 86400000 : 10;
      var w = Math.pow(2, MAX_BOX - (c.box || 1)) *
              (1 + Math.min(days, 10) / 5) *
              ((c.right || 0) < GRADUATE ? BOOST : 1);
      total += w;
      return w;
    });

    var r = Math.random() * total;
    for (var i = 0; i < pool.length; i++) {
      r -= weights[i];
      if (r <= 0) return pool[i];
    }
    return pool[pool.length - 1];
  }

  function grade(card, knew) {
    card.seen = (card.seen || 0) + 1;
    card.last = Date.now();
    if (knew) { card.right = (card.right || 0) + 1; card.box = Math.min(MAX_BOX, (card.box || 1) + 1); }
    else { card.wrong = (card.wrong || 0) + 1; card.box = 1; }
    saveFavs();
  }

  /* ---------------- practise ---------------- */

  $('#mode-productive').addEventListener('click', function () { setMode('productive'); });
  $('#mode-receptive').addEventListener('click', function () { setMode('receptive'); });

  function setMode(m) {
    settings.mode = m;
    saveSettings();
    $('#mode-productive').classList.toggle('is-on', m === 'productive');
    $('#mode-receptive').classList.toggle('is-on', m === 'receptive');
    nextCard();
  }

  function nextCard() {
    current = pickCard();
    revealed = false;
    renderPractice();
  }

  function renderPractice() {
    var body = $('#practice-body');
    body.innerHTML = '';

    if (!current) {
      body.innerHTML = '<p class="hint">Your deck is empty. Search for a word and tap the star under a video, ' +
        'or add the starter deck from Settings.</p>';
      return;
    }

    var card = current;
    var prompt = document.createElement('div');
    prompt.className = 'prompt';
    body.appendChild(prompt);

    var showWord = function () {
      var w = document.createElement('div');
      w.className = 'word';
      w.textContent = card.label && card.label.toLowerCase() !== card.word.toLowerCase()
        ? card.label : card.word;
      prompt.appendChild(w);
      if (card.def) {
        var d = document.createElement('p');
        d.className = 'def';
        d.textContent = card.def;
        prompt.appendChild(d);
      }
    };

    var showVideo = function (autoplay) {
      var clip = document.createElement('div');
      clip.className = 'clip';
      clip.style.width = '100%';
      clip.appendChild(makeVideo(card.u, autoplay).wrap);
      prompt.appendChild(clip);
    };

    if (settings.mode === 'productive') {
      showWord();
      if (revealed) showVideo(true);
      else prompt.insertAdjacentHTML('beforeend', '<p class="veil">How do you sign this?</p>');
    } else {
      showVideo(true);
      if (revealed) showWord();
      else prompt.insertAdjacentHTML('beforeend', '<p class="veil">What does this mean?</p>');
    }

    if (!revealed) {
      var rev = document.createElement('button');
      rev.className = 'big big-reveal';
      rev.type = 'button';
      rev.textContent = settings.mode === 'productive' ? 'Show the sign' : 'Show the word';
      rev.addEventListener('click', function () { revealed = true; renderPractice(); });
      body.appendChild(rev);
    } else {
      var answers = document.createElement('div');
      answers.className = 'answers';

      var no = document.createElement('button');
      no.className = 'big big-no';
      no.type = 'button';
      no.textContent = 'Didn\u2019t know';
      no.addEventListener('click', function () { grade(card, false); lastId = card.id; nextCard(); });

      var yes = document.createElement('button');
      yes.className = 'big big-yes';
      yes.type = 'button';
      yes.textContent = 'Knew it';
      yes.addEventListener('click', function () { grade(card, true); lastId = card.id; nextCard(); });

      answers.appendChild(no);
      answers.appendChild(yes);
      body.appendChild(answers);
    }

    var d = deckIn(settings.practiseCat);
    var learning = d.filter(function (c) { return (c.box || 1) <= 2; }).length;
    var p = document.createElement('p');
    p.className = 'progress';
    p.textContent = d.length + (settings.practiseCat && settings.practiseCat !== 'all'
      ? ' cards in this category \u00b7 ' : ' cards in your deck \u00b7 ') + learning + ' still bedding in';
    body.appendChild(p);
  }

  /* ---------------- deck screen ---------------- */

  function renderDeck() {
    var list = $('#deck-list');
    var alpha = settings.deckSort === 'alpha';
    var d = deckIn(settings.deckCat).sort(alpha
      ? function (a, b) { return a.word.localeCompare(b.word); }
      : function (a, b) { return (a.box - b.box) || a.word.localeCompare(b.word); });
    var filtered = settings.deckCat && settings.deckCat !== 'all';
    $('#deck-count').textContent = d.length
      ? d.length + (filtered ? ' cards here \u00b7 ' : ' cards \u00b7 ') +
        (alpha ? 'in alphabetical order' : 'shakiest first')
      : '';
    list.innerHTML = '';

    if (!d.length) {
      list.innerHTML = filtered
        ? '<p class="hint">No cards in this category yet. Browse it on the Explore tab and tap the star ' +
          'under any video.</p>'
        : '<p class="hint">Nothing here yet. Search for a word and tap the star under a video, ' +
          'or add the starter deck from Settings.</p>';
      return;
    }

    d.forEach(function (c) {
      var row = document.createElement('div');
      row.className = 'card-row';

      var w = document.createElement('div');
      w.className = 'w';
      var sub = [c.credit || c.label, c.seen ? c.right + '/' + c.seen + ' right' : 'not tried yet']
        .filter(Boolean).join(' \u00b7 ');
      w.innerHTML = '<b>' + esc(c.label && c.label.toLowerCase() !== c.word.toLowerCase()
        ? c.label + ' (' + c.word + ')' : c.word) + '</b><small>' + esc(sub) + '</small>';
      row.appendChild(w);

      var pips = document.createElement('div');
      pips.className = 'pips';
      for (var i = 1; i <= MAX_BOX; i++) {
        var pip = document.createElement('span');
        pip.className = 'pip' + (i <= (c.box || 1) ? ' on' : '');
        pips.appendChild(pip);
      }
      row.appendChild(pips);

      var del = document.createElement('button');
      del.className = 'drop';
      del.type = 'button';
      del.innerHTML = '&times;';
      del.setAttribute('aria-label', 'Remove ' + c.word);
      del.addEventListener('click', function () {
        delete favs[c.id];
        saveFavs();
        /* Rebuild the filter too: removing the last card of a category should
           take that category out of the list rather than leave it empty. */
        openDeck();
      });
      row.appendChild(del);

      list.appendChild(row);
    });
  }

  function setSortButtons() {
    $('#sort-shaky').classList.toggle('is-on', settings.deckSort !== 'alpha');
    $('#sort-alpha').classList.toggle('is-on', settings.deckSort === 'alpha');
  }

  /* The practise and deck filters list only the categories you hold cards in,
     so choosing one can never leave the screen empty. */
  function openPractise() {
    return Promise.all([loadWords(), loadCats()]).then(function () {
      settings.practiseCat = fillCategories($('#practise-cat'), settings.practiseCat, deckCatCounts());
      saveSettings();
    }).catch(function (e) { console.error('practise filter:', e); }).then(function () {
      intakeLeft = INTAKE;      // opening the tab starts a session
      nextCard();
    });
  }

  function openDeck() {
    return Promise.all([loadWords(), loadCats()]).then(function () {
      settings.deckCat = fillCategories($('#deck-cat'), settings.deckCat, deckCatCounts());
      saveSettings();
    }).catch(function (e) { console.error('deck filter:', e); }).then(function () {
      setSortButtons();
      renderDeck();
    });
  }

  $('#practise-cat').addEventListener('change', function () {
    settings.practiseCat = this.value;
    saveSettings();
    nextCard();
  });

  $('#deck-cat').addEventListener('change', function () {
    settings.deckCat = this.value;
    saveSettings();
    renderDeck();
  });

  [['#sort-shaky', 'shaky'], ['#sort-alpha', 'alpha']].forEach(function (pair) {
    $(pair[0]).addEventListener('click', function () {
      if ((settings.deckSort || 'shaky') === pair[1]) return;
      settings.deckSort = pair[1];
      saveSettings();
      setSortButtons();
      renderDeck();
    });
  });

  /* ---------------- settings ---------------- */

  $('#btn-export').addEventListener('click', function () {
    var blob = new Blob([JSON.stringify({ app: 'signcards', version: 1, favourites: favs }, null, 1)],
      { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sign-cards-backup.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  $('#btn-import').addEventListener('click', function () { $('#file-import').click(); });

  $('#file-import').addEventListener('change', function () {
    var f = this.files && this.files[0];
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = JSON.parse(reader.result);
        var incoming = data.favourites || data;
        var added = 0;
        Object.keys(incoming).forEach(function (k) {
          if (!favs[k]) added++;
          favs[k] = incoming[k];
        });
        saveFavs();
        renderDeck();
        toast('Restored ' + Object.keys(incoming).length + ' cards (' + added + ' new)');
      } catch (e) { toast('That file could not be read.'); }
    };
    reader.readAsText(f);
    this.value = '';
  });

  $('#btn-reset').addEventListener('click', function () {
    if (!confirm('Reset every score back to the start?')) return;
    Object.keys(favs).forEach(function (k) {
      favs[k].box = 1; favs[k].seen = 0; favs[k].right = 0; favs[k].wrong = 0; favs[k].last = 0;
    });
    saveFavs();
    renderDeck();
    toast('Scores reset');
  });

  $('#btn-starter').addEventListener('click', function () { addStarter(true); });

  function addStarter(announce) {
    return fetch('./data/starter-deck.json')
      .then(function (r) { return r.json(); })
      .then(function (list) { return loadWords().then(function () { return list; }); })
      .then(function (list) {
        var byWord = {};
        words.forEach(function (p) { byWord[p[0].toLowerCase()] = p[1]; });
        var wanted = list.map(function (w) { return byWord[String(w).toLowerCase()]; })
                         .filter(Boolean);
        var letters = {};
        wanted.forEach(function (s) { letters[letterOf(s)] = true; });

        return Promise.all(Object.keys(letters).map(loadShard)).then(function () {
          var added = 0;
          wanted.forEach(function (slug) {
            var entry = (shards[letterOf(slug)] || {})[slug];
            if (!entry || !entry.senses || !entry.senses.length) return;
            var sense = entry.senses[0];
            var vid = (sense.videos || [])[0];
            if (!vid) return;
            var id = slug + '#' + (vid.id || vid.u);
            if (favs[id]) return;
            favs[id] = newCard(id, entry.word || slug, slug, vid, sense.def || '');
            added++;
          });
          saveFavs();
          renderDeck();
          if (announce) toast(added ? 'Added ' + added + ' cards' : 'Already in your deck');
          return added;
        });
      })
      .catch(function () { if (announce) toast('Build the dictionary first (see Settings).'); });
  }

  function reportIndex() {
    fetch('./data/words.json')
      .then(function (r) { if (!r.ok) throw new Error(); return r.json(); })
      .then(function (d) {
        $('#idx-status').textContent = (d.count || (d.words || []).length).toLocaleString() +
          ' words available' + (d.generated ? ', last built ' + d.generated.slice(0, 10) : '') + '.';
        if (!settings.starterLoaded && (d.count || 0) > 100) {
          settings.starterLoaded = true;
          saveSettings();
          if (!Object.keys(favs).length) addStarter(false);
        }
      })
      .catch(function () {
        $('#idx-status').textContent = 'Not built yet. Run the Build dictionary action on GitHub, then reload.';
      });
  }

  /* Ask the browser to keep this app's storage out of any automatic clear-out.
     Granted for installed home-screen apps; the deck lives in localStorage either way. */
  function claimStorage() {
    var el = $('#store-status');
    if (!navigator.storage || !navigator.storage.persist) {
      el.textContent = 'Your deck is saved on this device.';
      return;
    }
    navigator.storage.persisted()
      .then(function (already) { return already || navigator.storage.persist(); })
      .then(function (ok) {
        el.textContent = ok
          ? 'Saved on this device and marked as permanent — it will not be cleared automatically.'
          : 'Saved on this device. Add the app to your home screen to make that permanent.';
      })
      .catch(function () { el.textContent = 'Your deck is saved on this device.'; });
  }

  /* ---------------- navigation ---------------- */

  $$('.tab').forEach(function (tab) {
    tab.addEventListener('click', function () {
      var name = tab.dataset.screen;
      $$('.tab').forEach(function (t) { t.classList.toggle('is-on', t === tab); });
      $$('.screen').forEach(function (s) { s.hidden = s.id !== 'screen-' + name; });
      window.scrollTo(0, 0);
      if (name === 'explore') openExplore();
      if (name === 'practise') openPractise();
      if (name === 'deck') openDeck();
    });
  });

  /* ---------------- start ---------------- */

  setMode(settings.mode || 'productive');
  $('#search-results').innerHTML = emptySearch();
  reportIndex();
  claimStorage();

  if ('serviceWorker' in navigator) {
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }
})();
