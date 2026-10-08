/* Sign Cards — BSL flashcards.
   Plain JavaScript, no build step. Data comes from ./data/ (built by tools/crawl.py).
   Videos are streamed from signbsl.com and are not copied or stored. */

(function () {
  'use strict';

  var MEDIA = 'https://media.signbsl.com/videos/bsl/';
  /* Shown in Settings, so it is possible to tell from the phone which build is
     running. Bump it when releasing, and tag the commit to match. The cache
     name in sw.js is a separate thing: that only tells the phone to refetch. */
  var APP_VERSION = '1.12.2';

  var FAV_KEY = 'signcards.favourites.v1';
  var SET_KEY = 'signcards.settings.v1';
  /* One step back from anything on the settings screen that can take progress
     away. Separate from the deck itself so a failed write cannot touch it. */
  var UNDO_KEY = 'signcards.undo.v1';
  /* Eight rather than five, so that a word answered correctly many times in a
     row separates from one that has only just reached the top. Existing cards
     keep their box number and climb from there: a card that scraped into the
     old top box has not earned the new one. */
  var MAX_BOX = 8;
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
  /* The top box rests before it is due again. Everywhere below it, how overdue
     a card is runs out over ten days; the top box comes round in months, so on
     that scale the term was flat and a card last seen in the spring counted no
     more than one seen last week. These put it on its own clock. */
  var REST = 60;             // days a top-box card rests
  var DAMP = 30;             // how far its weight is cut while resting

  var baseWords = null;      // the dictionary's own [[word, slug], ...]
  var baseSlugs = null;      // its slugs, for telling a new word from a known one
  var words = null;          // baseWords, then whatever the class has added
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
    /* Already a whole address: signbsl's own absolute ones, and a blob: URL
       for a clip that has just been recorded and is not anywhere yet. Only a
       bare path belongs to the media host. */
    if (u.slice(0, 4) === 'http' || u.slice(0, 5) === 'blob:') return u;
    return MEDIA + u;
  }

  function loadWords() {
    if (words) return Promise.resolve(words);
    return fetch('./data/words.json')
      .then(function (r) { if (!r.ok) throw new Error('missing'); return r.json(); })
      .then(function (d) { baseWords = d.words || []; rebuildWords(); return words; });
  }

  /* Whatever the class has published, asked for defensively. If collab.js is
     absent, broken, or mid-sync, this is an empty list and everything below
     behaves as it did before any of it existed. */
  function classPairs() {
    try {
      var p = window.SignCards && window.SignCards.provider;
      var list = p && p.words && p.words();
      return (list && list.length) ? list : [];
    } catch (e) { return []; }
  }

  /* Class words go on the END. categories.json holds indices into this list,
     so the 19,179 dictionary positions have to keep the numbers they were
     given when the categories were built. */
  function rebuildWords() {
    if (!baseWords) return;
    /* Whether a word is new is decided HERE, against the dictionary, not taken
       on trust from the index. A publisher's phone can be wrong about it, and
       the cost of believing it is the same word listed twice. */
    if (!baseSlugs) {
      baseSlugs = Object.create(null);     // "constructor" is a real headword
      /* slug -> position, not slug -> true. A clip recorded on a word the
         dictionary already has is tagged at the position that word already
         occupies, so the position is the thing worth keeping. Position 0 is
         real and falsy, so every lookup goes through hasOwnProperty. */
      for (var j = 0; j < baseWords.length; j++) baseSlugs[baseWords[j][1]] = j;
    }
    var pairs = classPairs();
    var extra = pairs.filter(function (pair) {
      return !Object.prototype.hasOwnProperty.call(baseSlugs, pair[1]);
    });
    words = extra.length ? baseWords.concat(extra) : baseWords;
    slugCats = null;                       // the slug map is built from indices
    classCategory(pairs, extra.length);
  }

  /* One synthetic category covering everything the class has added, so it can
     be practised as a group as well as by topic. Rebuilt rather than appended
     to, so repeated syncs cannot leave duplicates behind.

     It covers every word the class has published a clip for, not only the
     words the dictionary did not already have. A clip recorded on "apple"
     leaves apple in Food and adds it here too - an additional tag, which is
     what was asked for. Tagging only the brand new words meant eight clips
     showed up as one, because seven of them were on words that already
     existed and so had no new position to point at. */
  function classCategory(pairs, n) {
    if (!cats) return;
    cats.groups = (cats.groups || []).filter(function (g) { return g.id !== 'class'; });
    cats.categories = (cats.categories || []).filter(function (c) { return c.id !== 'c-user'; });
    if (!pairs.length) return;

    var seen = Object.create(null), idx = [], i, at;
    /* Words the dictionary already had, at the position they already occupy. */
    for (i = 0; i < pairs.length; i++) {
      at = Object.prototype.hasOwnProperty.call(baseSlugs, pairs[i][1])
        ? baseSlugs[pairs[i][1]] : -1;
      if (at < 0 || Object.prototype.hasOwnProperty.call(seen, at)) continue;
      seen[at] = true;
      idx.push(at);
    }
    /* And the genuinely new ones, appended on the end by rebuildWords. */
    for (i = 0; i < n; i++) {
      at = baseWords.length + i;
      if (Object.prototype.hasOwnProperty.call(seen, at)) continue;
      seen[at] = true;
      idx.push(at);
    }
    if (!idx.length) return;

    /* Ascending, because Explore browses a category by walking idx in order
       and the dictionary is already in A-Z order by position. Publish order
       would have made this the one category that browses at random. */
    idx.sort(function (a, b) { return a - b; });

    cats.groups.unshift({ id: 'class', name: 'The class' });
    cats.categories.push({ id: 'c-user', name: 'User content', group: 'class', idx: idx });
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
      var base = Object.prototype.hasOwnProperty.call(s, slug) ? s[slug] : null;
      return mergeClass(slug, base);
    }).catch(function () {
      /* A word the class added has no shard to come from. */
      var only = classEntry(slug);
      if (only) return only;
      throw new Error('missing');
    });
  }

  function classEntry(slug) {
    try {
      var p = window.SignCards && window.SignCards.provider;
      return (p && p.entry && p.entry(slug)) || null;
    } catch (e) { return null; }
  }

  /* The class's clips go above signbsl's on the word page: they are the ones
     someone in the room chose to record. */
  function mergeClass(slug, base) {
    var extra = classEntry(slug);
    if (!extra) return base;
    if (!base) return extra;
    var senses = (base.senses || []).slice();
    var mine = (extra.senses && extra.senses[0]) || null;
    if (!mine || !mine.videos || !mine.videos.length) return base;
    if (!senses.length) return { word: base.word, senses: [mine] };
    var first = senses[0];
    senses[0] = {
      def: first.def,
      videos: mine.videos.concat(first.videos || [])
    };
    return { word: base.word, senses: senses };
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

    /* The same query written as a slug, so that what is typed can be matched
       against how a word is filed as well as how it is spelt. 737 of the 19,179
       words are filed under something other than their spelling, and none of
       them could be found by typing that: "nonverbal" is filed at non-verbal,
       "acorn" at acorns, "Adam" at a-d-a-m. Searching the slug as well costs
       two string comparisons a word and reaches all of them. */
    var qs = q.replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');

    loadWords().then(function (list) {
      var starts = [], contains = [];
      for (var i = 0; i < list.length && starts.length + contains.length < 400; i++) {
        var w = list[i][0].toLowerCase();
        var sl = list[i][1];
        /* else-if throughout, so a word matching both ways is still listed once. */
        if (w === q || w.indexOf(q) === 0) starts.push(list[i]);
        else if (qs && (sl === qs || sl.indexOf(qs) === 0)) starts.push(list[i]);
        else if (w.indexOf(q) > -1) contains.push(list[i]);
        else if (qs && sl.indexOf(qs) > -1) contains.push(list[i]);
      }
      starts.sort(function (a, b) { return a[0].length - b[0].length; });
      var hits = starts.concat(contains).slice(0, 60);

      if (!hits.length) {
        box.innerHTML = '<p class="hint">No match for &ldquo;' + esc(raw.trim()) + '&rdquo;. ' +
          'Try a shorter word, or look it up on <a href="https://www.signbsl.com/" target="_blank" rel="noopener">signbsl.com</a>.</p>';
        /* The class features get to offer adding it. Logged, not swallowed. */
        try {
          var none = window.SignCards && window.SignCards.onNoMatch;
          if (none) none(box, raw.trim());
        } catch (e) { console.error('class hook:', e); }
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

      /* A list with something in it can still be missing the word you wanted -
         "determined" is not a headword, but it sits inside "determination" and
         "undetermined", so the list is never empty and the no-match offer above
         never fires. Quietly, at the end, because here something was found. */
      try {
        var more = window.SignCards && window.SignCards.onResultsEnd;
        if (more) more(box, raw.trim());
      } catch (e) { console.error('class hook:', e); }
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

    /* The class features get to add to the end of a word - an offer to record
       your own. Wrapped, because a throw in there must not leave the word
       half drawn, and logged rather than swallowed: an empty catch once hid a
       bug that emptied both category dropdowns. */
    try {
      var hook = window.SignCards && window.SignCards.onWordShown;
      if (hook) hook(container, slug, word, (entry.senses[0] || {}).def || '');
    } catch (e) { console.error('class hook:', e); }
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
       leaving a black box until the clip is played. Never on a blob: URL: iOS
       rejects the whole source with MEDIA_ERR_SRC_NOT_SUPPORTED when a
       fragment is tacked onto one, and a clip already on the device has no
       download to wait through anyway. */
    var src = videoUrl(u);
    v.src = src.slice(0, 5) === 'blob:' ? src : src + '#t=0.001';
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
      .then(function (d) { cats = d; rebuildWords(); return d; });
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

  /* How overdue a card is, as a multiplier on its weight.

     Below the top box this is the ten-day ramp it has always been: 1 the
     moment the card is seen, 3 once it is ten days old.

     The top box is on its own clock. Those cards come round in months, so the
     ten-day ramp sat at its maximum for nearly all of that and could not tell
     a card rested two months from one rested two years - both weighed the
     same, and the draw picked between them blind. A top-box card now rests for
     REST days, then climbs over the following REST, so when learnt words do
     come back it is the ones longest unseen that return first. */
  function overdue(box, days) {
    if (box < MAX_BOX) return 1 + Math.min(days, 10) / 5;
    if (days < REST) return 1 / DAMP;
    return 1 + Math.min(days - REST, REST) / (REST / 2);
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
      /* A card never seen counts as fully overdue rather than a week old, so
         it outranks anything merely neglected instead of sitting below it.
         Far past both ramps, not 10: at 10 a never-seen top-box card out of a
         restored backup would read as resting and be held back. */
      var days = c.last ? (now - c.last) / 86400000 : 1e4;
      var w = Math.pow(2, MAX_BOX - (c.box || 1)) *
              overdue(c.box || 1, days) *
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
      $('#screen-deck').classList.remove('has-index');
      showIndex(null);
      return;
    }

    var firstRow = Object.create(null);

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

      var L = initialOf(c.word);
      if (!(L in firstRow)) firstRow[L] = row;

      list.appendChild(row);

      /* The class features get to say something about a card - that the clip
         behind it has been withdrawn, say. AFTER it is in the list, not
         before: a note placed beside a row with no parent goes nowhere, and
         does it silently. Logged, not swallowed. */
      try {
        var dh = window.SignCards && window.SignCards.onDeckRow;
        if (dh) dh(row, c);
      } catch (e) { console.error('class hook:', e); }
    });

    /* Measured with the strip's padding off, so the answer does not depend on
       whether the strip happened to be showing a moment ago. */
    $('#screen-deck').classList.remove('has-index');
    showIndex(alpha && document.documentElement.scrollHeight > window.innerHeight
      ? firstRow : null);
  }

  /* ---------------- A-Z index strip ---------------- */

  var LETTERS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ'.split('');
  var indexRows = null;      // letter -> the first deck row starting with it
  var indexKeys = null;      // the letters actually on the strip, in order
  var scrubbing = null;

  /* Not letterOf: that one is the dictionary's, lower case, and naming this
     the same silently replaced it - every shard fetch asked for A.json
     instead of a.json and the dictionary looked unbuilt. */
  function initialOf(word) {
    var ch = (word || '').charAt(0).toUpperCase();
    return ch >= 'A' && ch <= 'Z' ? ch : '#';
  }

  function showIndex(firstRow) {
    var strip = $('#deck-index');
    if (!firstRow) {
      strip.hidden = true;
      indexRows = indexKeys = null;
      return;
    }
    indexRows = firstRow;
    indexKeys = ('#' in firstRow ? ['#'] : []).concat(LETTERS);
    strip.innerHTML = '';
    indexKeys.forEach(function (L) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = L;
      b.dataset.letter = L;
      if (!(L in firstRow)) b.className = 'empty';
      strip.appendChild(b);
    });
    strip.hidden = false;
    $('#screen-deck').classList.add('has-index');
    sizeIndex();
  }

  /* The strip runs from the bottom of the fixed block down to the tab bar, so
     it sits alongside the cards and nothing else. */
  /* Where the block ends on screen. It is stuck at the position it already
     occupied, so this holds whether the page is scrolled or not. */
  function headBottom() {
    var head = document.querySelector('#screen-deck .deckhead');
    return head ? head.getBoundingClientRect().bottom : 0;
  }

  function sizeIndex() {
    var b = headBottom();
    if (b) $('#screen-deck').style.setProperty('--headbottom', b + 'px');
  }

  window.addEventListener('resize', function () {
    if (!$('#deck-index').hidden) sizeIndex();
  });

  /* A letter you hold no cards for takes you to the nearest one you do, so no
     tap is ever a dead end. */
  function rowFor(letter) {
    var i = indexKeys.indexOf(letter);
    if (i < 0) return null;
    for (var j = i; j < indexKeys.length; j++) if (indexRows[indexKeys[j]]) return indexRows[indexKeys[j]];
    for (j = i; j >= 0; j--) if (indexRows[indexKeys[j]]) return indexRows[indexKeys[j]];
    return null;
  }

  function jumpTo(letter) {
    if (!indexRows) return;
    var row = rowFor(letter);
    if (!row) return;
    /* Clear the fixed block, or the row would land behind it. */
    window.scrollTo(0, Math.max(0, row.getBoundingClientRect().top + window.scrollY
                                   - headBottom() - 8));
  }

  (function () {
    var strip = $('#deck-index');

    function mark(letter) {
      var all = strip.children;
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('hit', all[i].dataset.letter === letter);
    }

    /* Keyboard and mouse both arrive here. */
    strip.addEventListener('click', function (e) {
      var b = e.target.closest('button');
      if (b) { mark(b.dataset.letter); jumpTo(b.dataset.letter); }
    });

    if (!window.PointerEvent) return;

    /* Sliding a finger down the strip runs through the list, the way the same
       control behaves elsewhere on the phone. The letter under the finger is
       found by hit testing the strip's own centre line, so straying sideways
       mid-drag does not break the gesture. */
    function scrub(clientY) {
      var box = strip.getBoundingClientRect();
      var y = Math.min(Math.max(clientY, box.top + 1), box.bottom - 1);
      var el = document.elementFromPoint(box.left + box.width / 2, y);
      var L = el && el.dataset ? el.dataset.letter : null;
      if (!L || L === scrubbing) return;
      scrubbing = L;
      mark(L);
      jumpTo(L);
    }

    strip.addEventListener('pointerdown', function (e) {
      scrubbing = null;
      strip.setPointerCapture(e.pointerId);
      scrub(e.clientY);
    });
    strip.addEventListener('pointermove', function (e) {
      if (strip.hasPointerCapture(e.pointerId)) scrub(e.clientY);
    });
    ['pointerup', 'pointercancel'].forEach(function (ev) {
      strip.addEventListener(ev, function () { scrubbing = null; mark(null); });
    });
  }());

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
    var blob = new Blob([JSON.stringify({ app: 'signcards', version: 1,
      saved: new Date().toISOString(), favourites: favs }, null, 1)],
      { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'sign-cards-backup.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
  });

  /* ---------------- undo ---------------- */

  /* One slot, taken before anything that can take progress away. Warnings only
     help when they are read; this helps when they were not. */
  function snapshot(what) {
    try {
      localStorage.setItem(UNDO_KEY, JSON.stringify({ what: what, when: Date.now(), favs: favs }));
    } catch (e) { /* no room: the action still goes ahead, just without a way back */ }
    showUndo();
  }

  function readUndo() {
    try { return JSON.parse(localStorage.getItem(UNDO_KEY) || 'null'); } catch (e) { return null; }
  }

  function ago(ms) {
    var m = Math.round((Date.now() - ms) / 60000);
    if (m < 1) return 'a moment ago';
    if (m === 1) return 'a minute ago';
    if (m < 60) return m + ' minutes ago';
    var h = Math.round(m / 60);
    return h === 1 ? 'an hour ago' : h + ' hours ago';
  }

  function showUndo() {
    var u = readUndo();
    $('#undo-panel').hidden = !u;
    if (u) $('#undo-what').textContent = 'You can put things back as they were before you ' +
      u.what + ', ' + ago(u.when) + '.';
  }

  $('#btn-undo').addEventListener('click', function () {
    var u = readUndo();
    if (!u) return;
    favs = u.favs;
    saveFavs();
    try { localStorage.removeItem(UNDO_KEY); } catch (e) {}
    showUndo();
    openDeck();
    toast('Put back as it was');
  });

  /* ---------------- restore ---------------- */

  /* Further on than, for deciding which copy of a card to keep. Box first,
     then correct answers, then sightings. */
  function progress(c) {
    return (c.box || 1) * 1e6 + (c.right || 0) * 1e3 + (c.seen || 0);
  }

  var pending = null;        // the parsed file, held until a choice is made

  $('#btn-import').addEventListener('click', function () { $('#file-import').click(); });

  $('#file-import').addEventListener('change', function () {
    var f = this.files && this.files[0];
    this.value = '';
    if (!f) return;
    var reader = new FileReader();
    reader.onload = function () {
      var data;
      try { data = JSON.parse(reader.result); }
      catch (e) { toast('That file could not be read.'); return; }
      var incoming = data.favourites || data;
      if (!incoming || typeof incoming !== 'object') { toast('That file could not be read.'); return; }
      pending = incoming;
      describeRestore(incoming, data.saved);
    };
    reader.readAsText(f);
  });

  /* Say what the file would do before a single card is written. Restoring an
     old backup used to roll every card in it back, silently. */
  function describeRestore(incoming, saved) {
    var keys = Object.keys(incoming);
    var fresh = 0, forward = 0, back = 0, newest = 0, examples = [];

    keys.forEach(function (k) {
      var theirs = incoming[k], mine = favs[k];
      if (theirs && theirs.last > newest) newest = theirs.last;
      if (!mine) { fresh++; return; }
      var a = progress(mine), b = progress(theirs);
      if (b > a) forward++;
      else if (b < a) {
        back++;
        if (examples.length < 3) {
          examples.push(mine.word + ': box ' + (mine.box || 1) + ' back to box ' + (theirs.box || 1));
        }
      }
    });

    var when = saved ? new Date(saved) : (newest ? new Date(newest) : null);
    var lines = ['This file holds <b>' + keys.length + ' cards</b>' +
      (when ? ', saved <b>' + when.toLocaleDateString(undefined,
        { day: 'numeric', month: 'long' }) + '</b>' : '') + '.'];
    if (fresh) lines.push('<b>' + fresh + '</b> are not in your deck and would be added.');
    if (forward) lines.push('<b>' + forward + '</b> are further on than yours.');
    lines.push(back
      ? '<b class="warnbad">' + back + ' would lose progress</b> if you replace everything.'
      : 'None of them would lose progress.');

    $('#plan-summary').innerHTML = lines.join(' ');
    var ul = $('#plan-examples');
    ul.innerHTML = '';
    examples.forEach(function (t) {
      var li = document.createElement('li');
      li.textContent = t;
      ul.appendChild(li);
    });
    $('#plan-replace').hidden = false;
    $('#restore-plan').hidden = false;
    $('#restore-plan').scrollIntoView({ block: 'center' });
  }

  function applyRestore(mergeOnly) {
    if (!pending) return;
    snapshot('restored a backup');
    var n = 0;
    Object.keys(pending).forEach(function (k) {
      var theirs = pending[k], mine = favs[k];
      if (!mine || !mergeOnly || progress(theirs) > progress(mine)) { favs[k] = theirs; n++; }
    });
    pending = null;
    $('#restore-plan').hidden = true;
    saveFavs();
    openDeck();
    toast(mergeOnly ? 'Merged — ' + n + ' cards taken from the file' : 'Restored ' + n + ' cards');
  }

  $('#plan-merge').addEventListener('click', function () { applyRestore(true); });
  $('#plan-replace').addEventListener('click', function () { applyRestore(false); });
  $('#plan-cancel').addEventListener('click', function () {
    pending = null;
    $('#restore-plan').hidden = true;
    toast('Nothing changed');
  });

  /* ---------------- reset ---------------- */

  /* Two deliberate taps rather than a dialog, which on a phone is tapped
     through without reading. The button says what the second tap does. */
  var armed = 0, disarmTimer = null;

  function disarmReset() {
    armed = 0;
    clearTimeout(disarmTimer);
    var b = $('#btn-reset');
    b.textContent = 'Reset all scores';
    b.classList.remove('armed');
  }

  $('#btn-reset').addEventListener('click', function () {
    if (!armed) {
      armed = 1;
      this.textContent = 'Tap again to clear every score';
      this.classList.add('armed');
      disarmTimer = setTimeout(disarmReset, 5000);
      return;
    }
    disarmReset();
    snapshot('reset your scores');
    Object.keys(favs).forEach(function (k) {
      favs[k].box = 1; favs[k].seen = 0; favs[k].right = 0; favs[k].wrong = 0; favs[k].last = 0;
    });
    saveFavs();
    openDeck();
    toast('Scores reset — you can undo this');
  });

  $('#btn-starter').addEventListener('click', function () {
    if (!confirm('Add about sixty everyday words to your deck?')) return;
    addStarter(true);
  });

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

  /* Settings always opens in its safe state: the guarded section shut, the
     reset button unarmed, no half-finished restore on screen. */
  function openSettings() {
    var care = document.querySelector('.care');
    if (care) care.open = false;
    pending = null;
    $('#restore-plan').hidden = true;
    disarmReset();
    showUndo();
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
      if (name === 'more') openSettings();
    });
  });

  /* ---------------- start ---------------- */

  setMode(settings.mode || 'productive');
  $('#search-results').innerHTML = emptySearch();
  reportIndex();
  claimStorage();
  $('#app-version').textContent = 'Sign Cards, version ' + APP_VERSION + '.';

  if ('serviceWorker' in navigator) {
    /* An update used to need two launches: the worker serves what it has and
       fetches the new release behind it, so the first launch still showed the
       old one. If a worker was already in charge when this page loaded, then
       it handing over means a new release has just taken effect - reload once
       and the version you are looking at is the version you have. */
    if (navigator.serviceWorker.controller) {
      var reloading = false;
      navigator.serviceWorker.addEventListener('controllerchange', function () {
        if (reloading) return;
        reloading = true;
        window.location.reload();
      });
    }
    window.addEventListener('load', function () {
      navigator.serviceWorker.register('./sw.js').catch(function () {});
    });
  }

  /* The only thing collab.js is given. Deliberately small: the class features
     are a guest here, not a partner, and the app must not come to depend on
     anything they do. It grows only when a step actually needs it to. */
  window.SignCards = {
    version: APP_VERSION,
    toast: toast,

    /* collab.js puts a provider here: { words(), entry(slug) }. app.js never
       learns where any of it comes from, and asks for it defensively, so an
       absent or broken provider leaves the dictionary exactly as it was. */
    provider: null,

    /* collab.js sets this to add its own button to the end of a word view. */
    onWordShown: null,

    /* And this when a search comes back with nothing, to offer adding it. */
    onNoMatch: null,

    /* And this at the end of a list that found something, which may still
       not be the thing you were after. */
    onResultsEnd: null,

    /* And this for each row of the deck, as it is drawn. */
    onDeckRow: null,

    /* Every clip a word has, dictionary and class together, so another one can
       be offered when the one in a card goes away. */
    clipsFor: function (slug) {
      return getEntry(slug).then(function (entry) {
        var out = [];
        ((entry && entry.senses) || []).forEach(function (sense) {
          (sense.videos || []).forEach(function (v) { out.push(v); });
        });
        return out;
      }).catch(function () { return []; });
    },

    /* Swap the clip behind a card and keep everything learnt about it. The id
       carries the clip, so the card has to move keys - but a box, a streak and
       a date last seen are about the word, not the recording of it. */
    replaceCardClip: function (oldId, slug, word, vid, def) {
      var old = favs[oldId];
      if (!old) return null;
      var newId = slug + '#' + (vid.id || vid.u);
      if (newId === oldId) return oldId;
      if (!favs[newId]) {
        var next = newCard(newId, word, slug, vid, def || old.def || '');
        next.box = old.box; next.seen = old.seen; next.right = old.right;
        next.wrong = old.wrong; next.last = old.last; next.added = old.added;
        favs[newId] = next;
      }
      delete favs[oldId];
      saveFavs();
      return newId;
    },

    removeCard: function (id) {
      if (!favs[id]) return false;
      delete favs[id];
      saveFavs();
      return true;
    },

    redrawDeck: function () { openDeck(); },

    /* Does the dictionary already carry this slug? Asked before anything is
       published as a new word, so a word that merely has no video yet is never
       added a second time. */
    hasWord: function (slug) {
      if (!baseWords) return false;
      if (!baseSlugs) {
        baseSlugs = Object.create(null);
        /* Positions, matching rebuildWords. Whichever of the two runs first
           builds the map the other then reads, so they have to agree. */
        for (var i = 0; i < baseWords.length; i++) baseSlugs[baseWords[i][1]] = i;
      }
      return Object.prototype.hasOwnProperty.call(baseSlugs, slug);
    },

    /* Show a word, so a newly published one can be opened straight away. The
       word view lives inside the search screen, so go there first. */
    showWord: function (slug, word) {
      var tab = document.querySelector('.tab[data-screen="search"]');
      if (tab) tab.click();
      openWord(slug, word);
    },

    /* Put a clip in the deck. Same shape as starring one by hand, so a
       published clip is an ordinary card from the moment it exists. */
    addCard: function (slug, word, vid, def) {
      var id = slug + '#' + (vid.id || vid.u);
      if (!favs[id]) {
        favs[id] = newCard(id, word, slug, vid, def || '');
        saveFavs();
      }
      return id;
    },

    /* Called after a sync. Rebuilds the merged word list and redraws whatever
       is on screen, so new words appear without anyone reloading. */
    classChanged: function () {
      rebuildWords();
      /* Explore fills its category list only when the list is empty, so that
         coming back to the tab does not throw away where you were. That guard
         also meant a category could never change once the tab had been opened:
         publish a clip and User content kept whatever count it had when the
         app started. Emptying it here is the one case where the list really is
         out of date, and openExplore below fills it again. */
      var ecat = $('#explore-cat');
      if (ecat) ecat.innerHTML = '';
      var open = document.querySelector('#screens > .screen:not([hidden])');
      var id = open && open.id;
      if (id === 'screen-deck') openDeck();
      else if (id === 'screen-explore') openExplore();
      else if (id === 'screen-practise') openPractise();
      else if (id === 'screen-search' && $('#q').value.trim()) runSearch($('#q').value);
    },
    /* Lent out so a recorded clip is played back by the same component as
       every other clip in the app: a painted first frame rather than a black
       box, muted so iOS will play it inline, and the app's own tap control
       instead of Apple's, which was the first thing asked to go. */
    makeVideo: makeVideo
  };
})();
