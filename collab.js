/* Class features: signing in, and later publishing and reading each other's
   clips. Kept entirely out of app.js on purpose.

   This is a module, so if it fails to download, fails to parse, or throws on
   load, nothing above it is affected - searching, practising and your deck
   behave exactly as they do with this file absent. Nothing here runs, and the
   Firebase SDK is not even fetched, until the switch in Settings is on.

   The config below is public by design. It names the project; it grants
   nothing. What may actually be read or written is decided by the security
   rules on Google's servers, which no amount of reading this file changes. */

const CFG = {
  apiKey: 'AIzaSyAUUNGhxXKIurAt9MwcKNCgMApJ1iiDZuI',
  authDomain: 'sign-cards-6852a.firebaseapp.com',
  projectId: 'sign-cards-6852a',
  storageBucket: 'sign-cards-6852a.firebasestorage.app',
  messagingSenderId: '90200731413',
  appId: '1:90200731413:web:17b2d0dc588c53587a431c'
};

/* Pinned, not 'latest'. An SDK that changes under us would change behaviour
   with no commit to point at. */
const SDK = 'https://www.gstatic.com/firebasejs/11.6.0/';

/* Its own key. The deck's storage is not touched by anything in this file. */
const KEY = 'signcards.collab.v1';

const $ = (s) => document.querySelector(s);

function readState() {
  try { return JSON.parse(localStorage.getItem(KEY) || '{}'); } catch (e) { return {}; }
}
function writeState(s) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch (e) { /* full or blocked */ }
}
function toast(m) {
  if (window.SignCards && window.SignCards.toast) window.SignCards.toast(m);
}

let state = readState();
let fb = null;          // the loaded SDK, once the switch has been on
let busy = false;

/* ---------------- the panel ---------------- */

const el = {
  on: $('#acct-on'),
  note: $('#acct-note'),
  out: $('#acct-out'),
  in: $('#acct-in'),
  who: $('#acct-who'),
  email: $('#acct-email'),
  pass: $('#acct-pass'),
  name: $('#acct-name'),
  signin: $('#btn-signin'),
  signout: $('#btn-signout')
};

/* An old cached index.html would not have these. Say nothing and do nothing. */
const ready = Object.keys(el).every((k) => el[k]);

function paint(user, msg) {
  if (!ready) return;
  const on = !!state.enabled;
  el.on.checked = on;

  el.out.hidden = !!user;
  el.in.hidden = !user;

  [el.email, el.pass, el.name, el.signin].forEach((n) => { n.disabled = !on || busy; });

  if (user) {
    addTryButton();
    el.who.textContent = 'Signed in as ' + (state.name || user.email) + '.';
    el.note.textContent = msg || 'Clips you record will carry your name.';
    return;
  }
  el.note.textContent = msg || (on
    ? 'Sign in with the details you were given.'
    : 'Off. Turn this on to sign in and share clips with the class. '
      + 'Everything else in the app works the same either way.');
}

/* ---------------- the SDK, only once it is wanted ---------------- */

async function firebase() {
  if (fb) return fb;
  const [app, auth, store] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js')
  ]);
  const a = app.initializeApp(CFG);
  fb = { auth: auth.getAuth(a), db: store.getFirestore(a), A: auth, S: store };

  /* One listener, for the rest of this page's life: it fires on sign-in, on
     sign-out, and on a session restored from a previous visit. */
  fb.A.onAuthStateChanged(fb.auth, (user) => {
    if (user) loadName(user);
    paint(user);
  });
  return fb;
}

/* The name shown under your clips lives in Firestore, not only on this phone,
   because it is what everyone else's app will display. */
async function loadName(user) {
  try {
    const snap = await fb.S.getDoc(fb.S.doc(fb.db, 'profiles', user.uid));
    const name = snap.exists() ? snap.data().name : null;
    if (name) { state.name = name; writeState(state); paint(user); }
  } catch (e) { /* offline, or rules; the email is shown instead */ }
}

async function saveName(user, name) {
  state.name = name;
  writeState(state);
  try {
    await fb.S.setDoc(fb.S.doc(fb.db, 'profiles', user.uid), { name }, { merge: true });
  } catch (e) { /* kept locally; it will go up next time */ }
}

/* ---------------- what went wrong, in words ---------------- */

function explain(code) {
  switch (code) {
    case 'auth/invalid-credential':
    case 'auth/wrong-password':
    case 'auth/user-not-found':
      return 'That email and password do not match.';
    case 'auth/invalid-email':      return 'That does not look like an email address.';
    case 'auth/user-disabled':      return 'That account has been turned off.';
    case 'auth/too-many-requests':  return 'Too many attempts. Wait a minute and try again.';
    case 'auth/network-request-failed': return 'No connection. Try again when you are online.';
    case 'auth/unauthorized-domain':
      return 'This address is not authorised for sign-in. Tell Ian.';
    default: return 'Could not sign in' + (code ? ' (' + code + ')' : '') + '.';
  }
}

/* ---------------- wiring ---------------- */

if (ready) {
  state = readState();
  paint(null);

  el.on.addEventListener('change', async () => {
    state.enabled = el.on.checked;
    writeState(state);
    paint(null);
    if (!state.enabled) {
      if (fb && fb.auth.currentUser) { try { await fb.A.signOut(fb.auth); } catch (e) {} }
      return;
    }
    /* Turning it on is the only thing that fetches the SDK. */
    try {
      busy = true; paint(null, 'Connecting…');
      await firebase();
      busy = false; paint(fb.auth.currentUser);
    } catch (e) {
      busy = false;
      state.enabled = false;
      writeState(state);
      paint(null, 'Could not reach the class server. Everything else still works.');
    }
  });

  el.signin.addEventListener('click', async () => {
    const email = el.email.value.trim();
    const pass = el.pass.value;
    const name = el.name.value.trim();
    if (!email || !pass) { paint(null, 'Fill in your email and password.'); return; }

    busy = true; paint(null, 'Signing in…');
    try {
      const f = await firebase();
      const cred = await f.A.signInWithEmailAndPassword(f.auth, email, pass);
      el.pass.value = '';
      busy = false;
      /* Only overwrite the stored name if one was actually typed. */
      if (name) await saveName(cred.user, name);
      paint(cred.user, 'Signed in.');
      toast('Signed in');
    } catch (e) {
      busy = false;
      el.pass.value = '';
      paint(null, explain(e && e.code));
    }
  });

  el.signout.addEventListener('click', async () => {
    try {
      const f = await firebase();
      await f.A.signOut(f.auth);
      paint(null, 'Signed out.');
      toast('Signed out');
    } catch (e) { paint(null, 'Could not sign out.'); }
  });

  /* A session from a previous visit: pick it up without being asked, but only
     if the switch was left on. */
  if (state.enabled) {
    firebase()
      .then(() => paint(fb.auth.currentUser))
      .catch(() => paint(null, 'Could not reach the class server. Everything else still works.'));
  }
}

/* ======================================================================
   The recorder

   Settings taken from what the phone actually produced in camera-test.html,
   not from guesswork:

     640x480 4:3   signbsl is 4:3 in nine of fourteen clips sampled, and
                   landscape in all of them
     3 seconds     their clips run 1.2-5.3s, median near 3
     500 kbps      Safari delivers about 1.95x what is asked, so this lands
                   near 970 kbps and ~354 KB
     mp4 first     a webm clip would be unplayable on every iPhone in the class

   This is a normal screen inside #screens, not an overlay, and that is the
   point rather than a detail. As a position:fixed overlay the clip played
   correctly - currentTime advancing, readyState 4, no error - and rendered
   nothing at all on the phone. Video inside a fixed container is a long
   standing iOS failure. Every video the app already shows sits in an ordinary
   screen, and those work, so the recorder now lives where they live and the
   finished clip plays in the app's own .clip wrapper.
   ====================================================================== */

const OUT = [640, 480];
const SECS = 3;
const ASK = 500000;
const TYPES = ['video/mp4', 'video/mp4;codecs=avc1', 'video/webm'];

let rec = null;            // built once, on first use
let cameFrom = null;       // the screen to put back when this one closes

function styleOnce() {
  if (document.getElementById('collab-style')) return;
  const s = document.createElement('style');
  s.id = 'collab-style';
  s.textContent = [
    // the tab bar would be a way out of a half-finished recording
    'body.is-recording .tabs{display:none}',
    '.rec-head{margin:6px 0 14px}',
    '.rec-head h2{font-size:1.35rem;font-weight:650;letter-spacing:-.02em;margin:0 0 4px}',
    // the live view. No border-radius or overflow clipping around a video, and
    // no fixed ancestor anywhere above it.
    '.rec-stage{position:relative;width:100%;aspect-ratio:4/3;background:#000;margin-bottom:14px}',
    '.rec-stage > canvas{width:100%;height:100%;display:block;background:#000}',
    '.rec-over{position:absolute;inset:0;display:flex;align-items:center;justify-content:center;',
    '  background:rgba(0,0,0,.3);color:#fff;font-size:4.5rem;font-weight:700;',
    '  text-shadow:0 2px 24px rgba(0,0,0,.8)}',
    // display:flex beats [hidden]'s display:none, so this has to be said out
    // loud or the countdown number can never be taken off the screen.
    '.rec-over[hidden],.rec-dot[hidden],.rec-stage[hidden],.rec-play[hidden]{display:none}',
    '.rec-dot{position:absolute;top:0;left:0;right:0;display:flex;align-items:center;',
    '  justify-content:center;gap:10px;background:var(--no);color:#fff;padding:10px 14px;',
    '  font-size:1rem;font-weight:700;letter-spacing:.02em}',
    '.rec-dot i{width:13px;height:13px;border-radius:50%;background:#fff;',
    '  animation:recblink 1s steps(2,end) infinite}',
    '.rec-dot b{font-variant-numeric:tabular-nums}',
    '@keyframes recblink{50%{opacity:0}}',
    '.rec-stage.live{outline:4px solid var(--no);outline-offset:-4px}',
    '.rec-play{margin-bottom:14px}',
    '.rec-btns button{width:100%;min-height:52px;margin-bottom:8px;appearance:none;',
    '  border:1px solid var(--line);border-radius:var(--r);background:var(--surface-2);',
    '  color:var(--text);font:inherit;font-weight:560;padding:14px 16px;cursor:pointer}',
    '.rec-btns button.go{background:var(--accent);border-color:var(--accent);color:#2a1d02}',
    '.rec-btns button.keep{background:var(--yes);border-color:var(--yes);color:#08210f}',
    '.rec-btns button.quiet{background:transparent;border-color:transparent;color:var(--muted)}',
    '.rec-facts{font-size:.78rem;color:var(--muted);margin-bottom:14px;line-height:1.6}',
    '.rec-facts b{color:var(--text)}'
  ].join('\n');
  document.head.appendChild(s);
}

function build() {
  if (rec) return rec;
  const screens = document.getElementById('screens');
  if (!screens) return null;
  styleOnce();

  const sec = document.createElement('section');
  sec.id = 'screen-record';
  sec.className = 'screen';
  sec.hidden = true;
  sec.innerHTML =
    '<header class="rec-head"><h2 id="rw-title">Record a clip</h2>' +
      '<p class="muted" id="rw-hint"></p></header>' +
    '<div class="rec-stage" id="rw-stage">' +
      '<video id="rw-pv" playsinline webkit-playsinline muted hidden></video>' +
      '<canvas id="rw-cv"></canvas>' +
      '<div class="rec-over" id="rw-over" hidden></div>' +
      '<div class="rec-dot" id="rw-dot" hidden></div>' +
    '</div>' +
    '<div class="rec-play" id="rw-play" hidden></div>' +
    '<p class="rec-facts" id="rw-facts" hidden></p>' +
    '<div class="rec-btns" id="rw-btns"></div>';
  screens.appendChild(sec);

  rec = {
    sec: sec,
    title: sec.querySelector('#rw-title'), hint: sec.querySelector('#rw-hint'),
    stage: sec.querySelector('#rw-stage'), pv: sec.querySelector('#rw-pv'),
    cv: sec.querySelector('#rw-cv'), play: sec.querySelector('#rw-play'),
    over: sec.querySelector('#rw-over'), dot: sec.querySelector('#rw-dot'),
    facts: sec.querySelector('#rw-facts'), btns: sec.querySelector('#rw-btns'),
    stream: null, drawing: false, tick: null, blob: null, url: null
  };
  return rec;
}

function buttons(list) {
  rec.btns.innerHTML = '';
  list.forEach(function (item) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item[0];
    if (item[1]) b.className = item[1];
    b.addEventListener('click', item[2]);
    rec.btns.appendChild(b);
  });
}

/* Belt and braces. Every way out goes through this, so the camera light
   cannot be left on. */
function stopCamera() {
  if (!rec) return;
  rec.drawing = false;
  if (rec.tick) { clearInterval(rec.tick); rec.tick = null; }
  if (rec.stream) { rec.stream.getTracks().forEach(function (t) { t.stop(); }); rec.stream = null; }
  rec.pv.srcObject = null;
  rec.over.hidden = true;
  rec.over.textContent = '';
  rec.dot.hidden = true;
  rec.stage.classList.remove('live');
}

function closeRecorder() {
  stopCamera();
  if (rec.url) { URL.revokeObjectURL(rec.url); rec.url = null; }
  rec.blob = null;
  rec.play.innerHTML = '';
  rec.play.hidden = true;
  rec.facts.hidden = true;
  rec.sec.hidden = true;
  document.body.classList.remove('is-recording');
  if (cameFrom) { cameFrom.hidden = false; cameFrom = null; }
  window.scrollTo(0, 0);
}

window.addEventListener('pagehide', function () { if (rec) stopCamera(); });
document.addEventListener('visibilitychange', function () {
  if (document.visibilityState === 'hidden' && rec) stopCamera();
});

function pickType() {
  if (!window.MediaRecorder || !MediaRecorder.isTypeSupported) return '';
  for (const t of TYPES) if (MediaRecorder.isTypeSupported(t)) return t;
  return '';
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function intro(word) {
  rec.title.textContent = word ? 'Record “' + word + '”' : 'Record a clip';
  rec.hint.textContent = 'Hold the phone however suits you — the clip comes out the same '
    + 'shape as the dictionary’s either way. You get a 3, 2, 1 countdown and then '
    + SECS + ' seconds.';
  rec.play.innerHTML = '';
  rec.play.hidden = true;
  rec.stage.hidden = false;
  rec.facts.hidden = true;
  buttons([
    ['Start the countdown', 'go', function () { run(word); }],
    ['Cancel', 'quiet', closeRecorder]
  ]);
}

async function run(word) {
  buttons([]);
  rec.play.innerHTML = '';
  rec.play.hidden = true;
  rec.stage.hidden = false;
  rec.facts.hidden = true;
  rec.hint.textContent = '';

  try {
    rec.stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: 'user', width: { ideal: OUT[0] }, height: { ideal: OUT[1] } },
      audio: false
    });
  } catch (e) {
    rec.hint.textContent = e && e.name === 'NotAllowedError'
      ? 'The camera was refused. Allow it for this site, then try again.'
      : 'Could not open the camera (' + (e && e.name) + ').';
    buttons([
      ['Try again', 'go', function () { intro(word); }],
      ['Cancel', 'quiet', closeRecorder]
    ]);
    return;
  }

  rec.pv.srcObject = rec.stream;
  try { await rec.pv.play(); } catch (e) { /* autoplay may refuse; frames still arrive */ }

  rec.cv.width = OUT[0];
  rec.cv.height = OUT[1];
  const ctx = rec.cv.getContext('2d');
  rec.drawing = true;

  /* A plain timer, deliberately. requestAnimationFrame and
     requestVideoFrameCallback are both tied to compositing and starve the
     moment the page stops being painted - measured at 0.5fps against a
     timer's 30, and it produced empty files twice before that was understood. */
  rec.tick = setInterval(function () {
    if (!rec.drawing) return;
    const vw = rec.pv.videoWidth, vh = rec.pv.videoHeight;
    if (!vw || !vh) return;
    const scale = Math.max(OUT[0] / vw, OUT[1] / vh);
    ctx.drawImage(rec.pv, (OUT[0] - vw * scale) / 2, (OUT[1] - vh * scale) / 2,
                  vw * scale, vh * scale);
  }, 1000 / 30);

  await wait(300);                       // let a few frames land before capturing

  /* No orientation prompt. iOS hands over camera frames in the sensor's
     orientation, which is landscape however the phone is held, and the canvas
     fixes the output shape in any case. */
  rec.over.hidden = false;
  for (let n = 3; n >= 1; n--) { rec.over.textContent = String(n); await wait(1000); }
  rec.over.hidden = true;

  const type = pickType();
  const opts = { videoBitsPerSecond: ASK };
  if (type) opts.mimeType = type;

  let mr;
  try {
    mr = new MediaRecorder(rec.cv.captureStream(30), opts);
  } catch (e) {
    stopCamera();
    rec.hint.textContent = 'This phone could not start recording (' + (e && e.name) + ').';
    buttons([['Back', 'quiet', closeRecorder]]);
    return;
  }

  const chunks = [];
  mr.ondataavailable = function (ev) { if (ev.data && ev.data.size) chunks.push(ev.data); };
  mr.onstop = function () {
    const blob = new Blob(chunks, { type: type || (chunks[0] && chunks[0].type) || '' });
    stopCamera();
    if (!blob.size) {
      rec.hint.textContent = 'That recording came out empty. Try again.';
      buttons([
        ['Try again', 'go', function () { intro(word); }],
        ['Cancel', 'quiet', closeRecorder]
      ]);
      return;
    }
    review(blob, word);
  };

  rec.dot.innerHTML = '<i></i>Recording <b></b>';
  const left = rec.dot.querySelector('b');
  rec.stage.classList.add('live');
  rec.dot.hidden = false;

  mr.start();
  for (let n = SECS; n >= 1; n--) { left.textContent = n + 's'; await wait(1000); }
  rec.stage.classList.remove('live');
  if (mr.state !== 'inactive') mr.stop();
}

function review(blob, word) {
  rec.blob = blob;
  rec.play.innerHTML = '';                          // let go of the old take first
  if (rec.url) URL.revokeObjectURL(rec.url);        // then release what it pointed at
  rec.url = URL.createObjectURL(blob);

  /* The live view goes away entirely rather than being covered, so there is
     nothing stacked over the clip. */
  rec.stage.hidden = true;
  rec.play.hidden = false;

  /* Built exactly as the word view builds one: the app's .clip wrapper around
     makeVideo. That combination renders on the phone; a bare video in a fixed
     overlay did not. */
  const mk = window.SignCards && window.SignCards.makeVideo;
  const clip = document.createElement('div');
  clip.className = 'clip';
  rec.play.appendChild(clip);

  let v = null;
  let auto = 'trying';
  if (mk) {
    const made = mk(rec.url, true);
    clip.appendChild(made.wrap);
    v = made.video;
  } else {
    v = document.createElement('video');
    v.src = rec.url;
    v.loop = true; v.muted = true; v.playsInline = true; v.controls = true;
    v.setAttribute('playsinline', ''); v.setAttribute('webkit-playsinline', '');
    v.style.width = '100%';
    clip.appendChild(v);
  }

  /* A dictionary clip paints its first frame through the #t fragment on the
     URL. A blob cannot carry one - iOS rejects the whole source - so nothing
     is painted until something decodes a frame. Nudging currentTime forces one
     to be drawn whether it plays or not. */
  v.addEventListener('loadeddata', function () {
    if (v.paused) { try { v.currentTime = 0.05; } catch (e) { /* ignore */ } }
  });

  /* makeVideo swallows the outcome of play(). Ask again and keep the answer. */
  v.play().then(
    function () { auto = 'playing'; facts(); },
    function (err) { auto = 'autoplay refused (' + (err && err.name) + ')'; facts(); }
  );

  rec.title.textContent = 'How does that look?';
  rec.hint.textContent = 'It should play on a loop — tap the picture if it does not. '
    + 'If the sign is clear and all of it is in frame, keep it.';

  function facts() {
    const dur = isFinite(v.duration) ? v.duration.toFixed(1) + 's' : SECS + 's';
    const b = v.getBoundingClientRect();
    /* The geometry is here because a clip once played perfectly while showing
       nothing at all, and the numbers are the only way to tell that apart from
       a clip that simply is not running. */
    rec.facts.innerHTML = '<b>' + Math.round(blob.size / 1024) + ' KB</b> · '
      + v.videoWidth + '×' + v.videoHeight + ' · ' + dur
      + ' · ' + (blob.type || 'unknown type')
      + ' · ready ' + v.readyState + (v.error ? ' · error ' + v.error.code : '')
      + ' · ' + (v.paused ? 'paused' : 'playing') + ' · ' + auto
      + '<br>box ' + Math.round(b.width) + '×' + Math.round(b.height)
      + ' · ' + getComputedStyle(v).visibility
      + ' · opacity ' + getComputedStyle(v).opacity;
    rec.facts.hidden = false;
    if (v.error) {
      rec.hint.textContent = 'The clip recorded (' + Math.round(blob.size / 1024)
        + ' KB) but this phone will not play it back here. Tell Ian: error '
        + v.error.code + '.';
    }
  }
  v.addEventListener('loadedmetadata', facts);
  v.addEventListener('canplay', facts);
  v.addEventListener('error', facts);
  if (v.readyState >= 1) facts();

  buttons([
    ['Keep it', 'keep', function () {
      rec.hint.textContent = '';
      rec.title.textContent = 'Kept — for now';
      rec.play.hidden = true;
      rec.facts.innerHTML = 'That clip is <b>' + Math.round(blob.size / 1024) + ' KB</b>. '
        + 'Nothing has been uploaded or saved: publishing comes next.';
      rec.facts.hidden = false;
      buttons([['Done', 'go', closeRecorder]]);
    }],
    ['Record it again', '', function () { intro(word); }],
    ['Throw it away', 'quiet', closeRecorder]
  ]);
}

function openRecorder(word) {
  if (!build()) return;
  cameFrom = document.querySelector('#screens > .screen:not([hidden])');
  const all = document.querySelectorAll('#screens > .screen');
  for (let i = 0; i < all.length; i++) all[i].hidden = true;
  rec.sec.hidden = false;
  document.body.classList.add('is-recording');
  window.scrollTo(0, 0);
  intro(word || '');
}

/* A temporary way in, while there is nowhere else for it to live. It shows
   only when signed in, and goes when the word view gains its own. */
function addTryButton() {
  if (!ready || document.getElementById('btn-try-rec')) return;
  const b = document.createElement('button');
  b.id = 'btn-try-rec';
  b.type = 'button';
  b.className = 'btn';
  b.style.width = '100%';
  b.style.marginBottom = '8px';
  b.textContent = 'Try the recorder';
  b.addEventListener('click', function () { openRecorder(''); });
  el.in.insertBefore(b, el.signout);
}

/* ======================================================================
   The class as a second dictionary source

   Everything the class has published is held here as one index, cached on the
   phone, and handed to app.js through window.SignCards.provider. app.js never
   learns that Firebase exists: it asks for words and for a word's clips, and
   coped before this file did anything at all.

   The cache is read first and the network second, always. Nothing in the
   dictionary ever waits on a request.

   Step 2b fills this from Firestore. For now it serves whatever is cached,
   which on a fresh phone is nothing.
   ====================================================================== */

const INDEX_KEY = 'signcards.class.v1';

function readIndex() {
  try {
    const raw = JSON.parse(localStorage.getItem(INDEX_KEY) || 'null');
    if (!raw || typeof raw !== 'object') return blankIndex();
    /* No prototype. Someone will eventually add a word called "constructor",
       and on a plain object that key already holds a function. */
    const entries = Object.create(null);
    Object.keys(raw.entries || {}).forEach(function (k) { entries[k] = raw.entries[k]; });
    return { since: raw.since || 0, entries: entries };
  } catch (e) { return blankIndex(); }
}

function blankIndex() {
  return { since: 0, entries: Object.create(null) };
}

function writeIndex(ix) {
  try {
    localStorage.setItem(INDEX_KEY, JSON.stringify({ since: ix.since, entries: ix.entries }));
  } catch (e) { /* full or blocked; it will be refetched next time */ }
}

let index = readIndex();

/* Only words the dictionary does not already carry become new entries in the
   word list. A clip on an existing word needs no new word and no new category:
   its slug is already in the dictionary, so it inherits what that word has. */
function provider() {
  return {
    words: function () {
      const out = [];
      Object.keys(index.entries).forEach(function (slug) {
        const e = index.entries[slug];
        if (e && e.isNew) out.push([e.word, slug]);
      });
      out.sort(function (a, b) { return a[0].localeCompare(b[0]); });
      return out;
    },
    entry: function (slug) {
      const e = Object.prototype.hasOwnProperty.call(index.entries, slug)
        ? index.entries[slug] : null;
      if (!e || !e.videos || !e.videos.length) return null;
      return { word: e.word, senses: [{ def: e.def || '', videos: e.videos }] };
    }
  };
}

if (window.SignCards) {
  window.SignCards.provider = provider();
  if (window.SignCards.classChanged) window.SignCards.classChanged();
}

/* Step 2b calls this after a sync. Kept here so the shape is settled before
   anything fetches. */
function setIndex(next) {
  index = next;
  writeIndex(index);
  if (window.SignCards && window.SignCards.classChanged) window.SignCards.classChanged();
}
