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
