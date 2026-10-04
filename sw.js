/* Caches the app itself and the dictionary files so everything except video
   playback works without a connection. Videos live on another domain and are
   deliberately left alone.

   Two caches, on purpose. The app is a few dozen kilobytes and changes several
   times a week; the dictionary is 6 MB of words.json and 27 letter shards that
   only change when the crawler is rerun. Holding both under one name meant
   every release threw the dictionary away and every phone fetched it again,
   a shard at a time, over mobile data. They are now kept apart and only the
   one that actually changed is discarded. */

var VERSION = 'signcards-v24';        // the app; bump on every release
var DATA = 'signcards-data-v1';       // the dictionary; bump only when data/ is rebuilt

var SHELL = [
  './',
  './index.html',
  './styles.css',
  './app.js',
  './collab.js',
  './manifest.webmanifest',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

/* Small enough to be worth having before they are asked for, but they live
   under data/ and so belong in the dictionary's cache, not the app's. */
var SEED = [
  './data/starter-deck.json',
  './data/categories.json'
];

/* Anything under data/ is dictionary. Matching on the path rather than a list
   because the shards are fetched one letter at a time, as words are opened. */
function isData(url) {
  return url.pathname.indexOf('/data/') > -1;
}

/* cache: 'reload' matters. A plain add() reads through the browser's own HTTP
   cache, and Pages serves these with max-age=600, so a new worker could copy
   the previous release into its new cache: the cache name changed, the files
   did not, and the app kept reporting the old version. */
function fetchFresh(c, u) {
  return c.add(new Request(u, { cache: 'reload' })).catch(function () {});
}

self.addEventListener('install', function (e) {
  e.waitUntil(
    Promise.all([
      caches.open(VERSION).then(function (c) {
        return Promise.all(SHELL.map(function (u) { return fetchFresh(c, u); }));
      }),
      caches.open(DATA).then(function (c) {
        /* Only what is missing. This cache survives releases, so re-adding
           every time would refetch 128 KB for nothing. */
        return Promise.all(SEED.map(function (u) {
          return c.match(u).then(function (hit) { return hit ? null : fetchFresh(c, u); });
        }));
      })
    ]).then(function () { return self.skipWaiting(); })
  );
});

/* Everyone upgrading to this release still has their dictionary filed under
   the old app cache, which is about to be deleted. Move it across first, so
   this is the last time anybody refetches it. Best effort: if any of it fails
   the old cache is still cleared and the worker still takes over. */
function rescueData(key) {
  return Promise.all([caches.open(key), caches.open(DATA)]).then(function (both) {
    var old = both[0], data = both[1];
    return old.keys().then(function (reqs) {
      return Promise.all(reqs.map(function (req) {
        if (!isData(new URL(req.url))) return null;
        return data.match(req).then(function (have) {
          if (have) return null;
          return old.match(req).then(function (res) {
            return res ? data.put(req, res) : null;
          });
        });
      }));
    });
  }).catch(function () {});
}

self.addEventListener('activate', function (e) {
  e.waitUntil(
    caches.keys().then(function (keys) {
      var stale = keys.filter(function (k) { return k !== VERSION && k !== DATA; });
      return Promise.all(stale.map(function (k) {
        return rescueData(k).then(function () { return caches.delete(k); });
      }));
    }).then(function () { return self.clients.claim(); })
  );
});

self.addEventListener('fetch', function (e) {
  var req = e.request;
  if (req.method !== 'GET') return;

  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;   // videos etc. go straight to the network

  e.respondWith(
    /* caches.match searches both, so a hit from either is served. */
    caches.match(req).then(function (hit) {
      var live = fetch(req).then(function (res) {
        if (res && res.ok) {
          var copy = res.clone();
          caches.open(isData(url) ? DATA : VERSION).then(function (c) { c.put(req, copy); });
        }
        return res;
      }).catch(function () { return hit; });
      return hit || live;
    })
  );
});
