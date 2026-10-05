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
    addSyncRow();
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
  const [app, auth, store, bucket] = await Promise.all([
    import(SDK + 'firebase-app.js'),
    import(SDK + 'firebase-auth.js'),
    import(SDK + 'firebase-firestore.js'),
    import(SDK + 'firebase-storage.js')
  ]);
  const a = app.initializeApp(CFG);
  fb = { auth: auth.getAuth(a), db: store.getFirestore(a), storage: bucket.getStorage(a),
         A: auth, S: store, G: bucket };

  /* One listener, for the rest of this page's life: it fires on sign-in, on
     sign-out, and on a session restored from a previous visit. */
  fb.A.onAuthStateChanged(fb.auth, (user) => {
    if (user) { loadName(user); sync(false).then(function () { saySync(); }); }
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
    if (window.SignCards && window.SignCards.classChanged) window.SignCards.classChanged();
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
     is painted until something decodes a frame. Nudging currentTime forces one.

     Only ever AFTER play() has settled, never alongside it: seeking a video
     with a play() still pending aborts it, which turned a clip that was about
     to play into "autoplay refused (AbortError)". The nudge was racing the
     thing it exists to back up. */
  function paintFrame() {
    if (v.paused) { try { v.currentTime = 0.05; } catch (e) { /* ignore */ } }
  }

  /* makeVideo already attempts autoplay. Calling play() a second time races
     it, and the loser rejects with AbortError - which reads as a refusal when
     nothing was refused at all. So: do not ask again. Watch instead. */
  v.addEventListener('play', function () { auto = 'playing'; facts(); });
  setTimeout(function () {
    if (v.paused) { auto = 'not playing'; paintFrame(); }
    facts();
  }, 1200);

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

  const canPublish = !!(rec.slug && fb && fb.auth && fb.auth.currentUser);

  buttons([
    [canPublish ? 'Publish it to the class' : 'Keep it', 'keep', function () {
      if (!canPublish) {
        rec.hint.textContent = '';
        rec.title.textContent = 'Kept — for now';
        rec.play.hidden = true;
        rec.facts.innerHTML = 'That clip is <b>' + Math.round(blob.size / 1024) + ' KB</b>. '
          + 'Nothing has been uploaded: open the recorder from a word to publish one.';
        rec.facts.hidden = false;
        buttons([['Done', 'go', closeRecorder]]);
        return;
      }
      doPublish(blob, word);
    }],
    ['Record it again', '', function () { intro(word); }],
    ['Throw it away', 'quiet', closeRecorder]
  ]);
}

async function doPublish(blob, word) {
  buttons([]);
  rec.title.textContent = 'Publishing…';
  rec.hint.textContent = 'Sending ' + Math.round(blob.size / 1024) + ' KB. This takes a moment.';
  try {
    const r = await publish(blob, rec.slug, word, rec.def, rec.isNew);
    rec.title.textContent = 'Published';
    rec.hint.textContent = '';
    rec.play.hidden = true;
    rec.facts.innerHTML = '<b>' + Math.round(r.bytes / 1024) + ' KB</b> sent. '
      + 'It is in your deck, and the rest of the class will see it next time they look.';
    rec.facts.hidden = false;
    toast('Published');
    buttons([['Done', 'go', closeRecorder]]);
  } catch (e) {
    /* The clip is still in hand - nothing has been thrown away. */
    rec.title.textContent = 'Could not publish';
    rec.hint.textContent = 'Nothing was lost. ' + ((e && e.code) || (e && e.message) || 'Unknown error')
      + '. You can try again.';
    buttons([
      ['Try publishing again', 'keep', function () { doPublish(blob, word); }],
      ['Record it again', '', function () { intro(word); }],
      ['Throw it away', 'quiet', closeRecorder]
    ]);
  }
}

function openRecorder(word, slug, def, isNew) {
  if (!build()) return;
  rec.slug = slug || '';
  rec.def = def || '';
  rec.isNew = !!isNew;
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
  b.addEventListener('click', function () { openRecorder('', '', '', false); });
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
      if (!state.enabled) return [];
      const out = [];
      Object.keys(index.entries).forEach(function (slug) {
        const e = index.entries[slug];
        /* Needs a clip to be worth listing. A word whose only recording was
           withdrawn would otherwise sit in search showing nothing at all. */
        if (e && e.isNew && e.videos && e.videos.length) out.push([e.word, slug]);
      });
      out.sort(function (a, b) { return a[0].localeCompare(b[0]); });
      return out;
    },
    entry: function (slug) {
      if (!state.enabled) return null;
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

/* ---------------- the sync ----------------

   One question, asked of each collection: what has changed since last time.

       where('updated', '>', since)

   Keyed on updated rather than created on purpose. A withdrawn clip does not
   change when it was created, so a created-based query would never notice one
   going away - the kind of thing that is invisible for months and then wrong
   at the worst moment.

   At rest it returns nothing and costs a couple of reads. It is never waited
   on: the cache is served first and this catches up behind it. */

/* Pure, and separated from the fetch so it can be tested without a network or
   a project to write to. Takes plain arrays, returns the next index. */
function applyDeltas(prev, clips, words) {
  const entries = Object.create(null);
  Object.keys(prev.entries).forEach(function (k) {
    const e = prev.entries[k];
    entries[k] = { word: e.word, def: e.def, isNew: e.isNew, videos: (e.videos || []).slice() };
  });
  let since = prev.since || 0;

  function at(d) {
    const t = d && d.updated;
    if (!t) return 0;
    return typeof t.toMillis === 'function' ? t.toMillis() : Number(t) || 0;
  }
  function slot(slug, word) {
    if (!Object.prototype.hasOwnProperty.call(entries, slug)) {
      entries[slug] = { word: word || slug, def: '', isNew: false, videos: [] };
    } else if (word) { entries[slug].word = word; }
    return entries[slug];
  }

  /* Words first, so a clip arriving alongside its word finds it already there. */
  words.forEach(function (w) {
    const d = w.data || {};
    since = Math.max(since, at(d));
    const e = slot(w.id, d.word);
    e.def = d.def || '';
    e.isNew = true;          // advisory; app.js decides against the dictionary
  });

  clips.forEach(function (c) {
    const d = c.data || {};
    since = Math.max(since, at(d));
    if (!d.slug) return;
    const e = slot(d.slug, d.word);
    e.videos = e.videos.filter(function (v) { return v.id !== c.id; });
    if (d.status === 'live' && d.url) {
      e.videos.push({
        id: c.id,
        u: d.url,
        /* label stays empty. The deck renders a card as "label (word)", so a
           name here would turn every row into "Sarah (apple)". credit carries
           it, and the word view shows that on its own. */
        label: '',
        credit: d.byName || 'the class'
      });
    }
  });

  /* A word nobody has a live clip for, and which the class did not add as a
     word in its own right, is not worth carrying. */
  Object.keys(entries).forEach(function (k) {
    const e = entries[k];
    if (!e.videos.length && !e.isNew) delete entries[k];
  });

  return { since: since, entries: entries };
}

function snapRows(snap) {
  const out = [];
  snap.forEach(function (d) { out.push({ id: d.id, data: d.data() }); });
  return out;
}

let syncing = false;

async function sync(full) {
  if (syncing || !state.enabled) return null;
  syncing = true;
  try {
    const f = await firebase();
    if (!f.auth.currentUser) return null;       // the rules need a signed-in reader
    const since = full ? 0 : (index.since || 0);
    const T = f.S.Timestamp.fromMillis(since);
    const [clipSnap, wordSnap] = await Promise.all([
      f.S.getDocs(f.S.query(f.S.collection(f.db, 'clips'), f.S.where('updated', '>', T))),
      f.S.getDocs(f.S.query(f.S.collection(f.db, 'words'), f.S.where('updated', '>', T)))
    ]);
    const clips = snapRows(clipSnap), words = snapRows(wordSnap);
    if (clips.length || words.length) setIndex(applyDeltas(index, clips, words));
    return { clips: clips.length, words: words.length };
  } catch (e) {
    /* Offline, rules, a bad clock - none of it matters. The cache stands and
       the dictionary never noticed a request was made. */
    return { error: (e && e.code) || (e && e.name) || 'failed' };
  } finally { syncing = false; }
}

/* ---------------- what the class has, shown in Settings ---------------- */

function classCounts() {
  let words = 0, clips = 0;
  Object.keys(index.entries).forEach(function (k) {
    const e = index.entries[k];
    if (e.isNew) words++;
    clips += (e.videos || []).length;
  });
  return { words: words, clips: clips };
}

function saySync(msg) {
  const p = document.getElementById('class-status');
  if (!p) return;
  const c = classCounts();
  p.textContent = msg || (c.clips
    ? c.clips + (c.clips === 1 ? ' clip' : ' clips') + ' from the class, '
      + c.words + (c.words === 1 ? ' new word' : ' new words') + '.'
    : 'Nothing from the class yet.');
}

function addSyncRow() {
  if (!ready || document.getElementById('btn-sync')) return;
  const p = document.createElement('p');
  p.id = 'class-status';
  p.className = 'muted';
  p.style.marginBottom = '8px';
  el.in.insertBefore(p, el.signout);

  const b = document.createElement('button');
  b.id = 'btn-sync';
  b.type = 'button';
  b.className = 'btn';
  b.style.width = '100%';
  b.style.marginBottom = '8px';
  b.textContent = 'Check for new words';
  b.addEventListener('click', async function () {
    b.disabled = true;
    saySync('Checking…');
    const r = await sync(false);
    b.disabled = false;
    if (!r) { saySync('Sign in first.'); return; }
    if (r.error) { saySync('Could not check (' + r.error + '). Nothing has changed.'); return; }
    saySync(r.clips || r.words ? null : 'Nothing new.');
    if (!r.clips && !r.words) setTimeout(function () { saySync(); }, 2500);
  });
  el.in.insertBefore(b, el.signout);
  saySync();
}

/* ---------------- publishing ----------------

   Record, upload, write the document, put it in your own deck. The clip then
   comes back down through the ordinary sync, so what everyone else sees and
   what you see are the same thing arriving by the same route.

   Order matters. The file goes up first and the document second: a document
   pointing at a file that is not there would show everyone a broken clip,
   while a file nobody has a document for is invisible and harmless. */

async function publish(blob, slug, word, def, isNew) {
  const f = await firebase();
  const user = f.auth.currentUser;
  if (!user) throw new Error('not signed in');

  /* An id generated before anything is written, so the file and its document
     share one and either can be found from the other. */
  const clipId = f.S.doc(f.S.collection(f.db, 'clips')).id;
  const mime = blob.type || 'video/mp4';
  const path = 'clips/' + user.uid + '/' + clipId + '.mp4';

  const ref = f.G.ref(f.storage, path);
  await f.G.uploadBytes(ref, blob, { contentType: mime });
  const url = await f.G.getDownloadURL(ref);

  /* The word before the clip. The sync reads words first, so a clip arriving
     with its word already there is understood in one pass rather than two. */
  if (isNew) {
    await f.S.setDoc(f.S.doc(f.db, 'words', slug), {
      word: word,
      def: def || '',
      by: user.uid,
      created: f.S.serverTimestamp(),
      updated: f.S.serverTimestamp()
    }, { merge: true });
  }

  await f.S.setDoc(f.S.doc(f.db, 'clips', clipId), {
    slug: slug,
    word: word,
    url: url,
    path: path,
    mime: mime,
    bytes: blob.size,
    by: user.uid,
    byName: state.name || user.email,
    status: 'live',
    created: f.S.serverTimestamp(),
    updated: f.S.serverTimestamp()
  });

  /* Yours straight away, rather than waiting for it to come back round. */
  const vid = { id: clipId, u: url, label: '', credit: state.name || user.email };
  if (window.SignCards && window.SignCards.addCard) {
    window.SignCards.addCard(slug, word, vid, def);
  }

  /* And then fetched like anyone else's, which is also what proves it landed. */
  await sync(false);
  return { clipId: clipId, url: url, bytes: blob.size };
}

/* ---------------- the way in, on a word ---------------- */

function recordButton(container, slug, word, def) {
  if (!state.enabled) return;
  const f = fb;
  if (!f || !f.auth || !f.auth.currentUser) return;   // signed out: no offer

  const b = document.createElement('button');
  b.className = 'btn rec-offer';
  b.type = 'button';
  b.textContent = 'Record your own “' + word + '”';
  b.addEventListener('click', function () { openRecorder(word, slug, def); });
  container.appendChild(b);
}

if (window.SignCards) {
  window.SignCards.onWordShown = function (container, slug, word, def) {
    recordButton(container, slug, word, def);
  };
}

/* ---------------- adding a word the dictionary does not have ----------------

   Search finds nothing, so offer to add it: confirm a definition, record a
   clip, publish both. The word gets the User content category and nothing
   else, until there is an index that can categorise it the way signbsl's were.

   The definition comes from Wiktionary, which was chosen by testing rather
   than by reputation. dictionaryapi.dev, which was the first choice, answered
   with HTTP 522 twice, recovered, then hung past 45 seconds on five words -
   intermittent, which is worse to build on than simply being down. Wiktionary
   answered every word in 0.5 to 0.9 seconds with access-control-allow-origin
   set, and 404s cleanly on a word it does not know.

   Nothing here blocks on it. If Wiktionary is slow, unreachable, or has never
   heard of the word, you get an empty box and a quiet note, and adding the
   word carries on. A dictionary being down is not a reason to stop someone
   recording a sign. */

const WIKT = 'https://en.wiktionary.org/api/rest_v1/page/definition/';

function slugify(word) {
  return String(word).toLowerCase().trim()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function stripTags(html) {
  const d = document.createElement('div');
  d.innerHTML = html || '';
  return (d.textContent || '').replace(/\s+/g, ' ').trim();
}

/* The first definition that actually says something. Wiktionary's first entry
   is often an empty string carrying only a usage label. */
async function lookUp(word) {
  try {
    const r = await fetch(WIKT + encodeURIComponent(word.toLowerCase().replace(/ /g, '_')));
    if (r.status === 404) return { state: 'unknown' };
    if (!r.ok) return { state: 'failed' };
    const d = await r.json();
    const en = d.en || [];
    for (const part of en) {
      for (const def of (part.definitions || [])) {
        const t = stripTags(def.definition);
        if (t) return { state: 'found', def: t, pos: part.partOfSpeech || '' };
      }
    }
    return { state: 'unknown' };
  } catch (e) { return { state: 'failed' }; }
}

/* ---------------- the screen ---------------- */

let addScreen = null;

function buildAdd() {
  if (addScreen) return addScreen;
  const screens = document.getElementById('screens');
  if (!screens) return null;
  styleOnce();

  const sec = document.createElement('section');
  sec.id = 'screen-addword';
  sec.className = 'screen';
  sec.hidden = true;
  sec.innerHTML =
    '<header class="rec-head"><h2 id="aw-title">Add a word</h2>' +
      '<p class="muted" id="aw-hint"></p></header>' +
    '<label class="field"><span>Definition</span>' +
      '<textarea id="aw-def" rows="3"></textarea></label>' +
    '<p class="muted" id="aw-source"></p>' +
    '<div class="rec-btns" id="aw-btns"></div>';
  screens.appendChild(sec);

  addScreen = {
    sec: sec,
    title: sec.querySelector('#aw-title'), hint: sec.querySelector('#aw-hint'),
    def: sec.querySelector('#aw-def'), source: sec.querySelector('#aw-source'),
    btns: sec.querySelector('#aw-btns')
  };
  return addScreen;
}

function addButtons(list) {
  addScreen.btns.innerHTML = '';
  list.forEach(function (item) {
    const b = document.createElement('button');
    b.type = 'button';
    b.textContent = item[0];
    if (item[1]) b.className = item[1];
    b.addEventListener('click', item[2]);
    addScreen.btns.appendChild(b);
  });
}

function closeAdd() {
  addScreen.sec.hidden = true;
  document.body.classList.remove('is-recording');
  if (cameFrom) { cameFrom.hidden = false; cameFrom = null; }
  window.scrollTo(0, 0);
}

async function openAddWord(word) {
  if (!buildAdd()) return;
  const slug = slugify(word);
  if (!slug) return;

  cameFrom = document.querySelector('#screens > .screen:not([hidden])');
  const all = document.querySelectorAll('#screens > .screen');
  for (let i = 0; i < all.length; i++) all[i].hidden = true;
  addScreen.sec.hidden = false;
  document.body.classList.add('is-recording');
  window.scrollTo(0, 0);

  addScreen.title.textContent = 'Add “' + word + '”';
  addScreen.hint.textContent = 'It will be filed under User content, and everyone in the class '
    + 'will be able to find it.';
  addScreen.def.value = '';
  addScreen.source.textContent = 'Looking for a definition…';
  addButtons([['Cancel', 'quiet', closeAdd]]);

  const found = await lookUp(word);
  addScreen.source.textContent =
    found.state === 'found' ? 'From Wiktionary' + (found.pos ? ' (' + found.pos.toLowerCase() + ')' : '')
      + ' — change it if it is not the right sense.'
    : found.state === 'unknown' ? 'Wiktionary has never heard of it. Write your own, or leave it empty.'
    : 'Could not reach Wiktionary. Write your own, or leave it empty.';
  if (found.state === 'found') addScreen.def.value = found.def;

  addButtons([
    ['Record it', 'go', function () {
      const def = addScreen.def.value.trim();
      closeAdd();
      openRecorder(word, slug, def, true);
    }],
    ['Cancel', 'quiet', closeAdd]
  ]);
}

/* ---------------- the way in, when a search finds nothing ---------------- */

if (window.SignCards) {
  window.SignCards.onNoMatch = function (box, query) {
    if (!state.enabled) return;
    if (!fb || !fb.auth || !fb.auth.currentUser) return;
    const word = query.trim();
    if (!word || word.length < 2) return;

    const slug = slugify(word);
    /* A word the dictionary has but search did not surface is not a new word.
       Adding it again would list it twice. */
    if (!slug || (window.SignCards.hasWord && window.SignCards.hasWord(slug))) return;

    const b = document.createElement('button');
    b.className = 'btn rec-offer';
    b.type = 'button';
    b.textContent = 'Add “' + word + '” and record it';
    b.addEventListener('click', function () { openAddWord(word); });
    box.appendChild(b);
  };
}

