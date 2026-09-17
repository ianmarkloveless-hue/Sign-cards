# Sign Cards

Flashcards for learning British Sign Language on an iPhone. Search a word, star the
videos you want to learn, then practise in either direction. Cards you keep getting
wrong come back more often.

It is a web app that installs to your home screen — no App Store, no Mac, no developer
account. Everything runs from a free GitHub account.

---

## Part 1 — Put it online (about 15 minutes)

**1. Make a GitHub account** at [github.com](https://github.com) if you don't have one.

**2. Make a repository.** Click the **+** at the top right → **New repository**.
Name it `sign-cards`, choose **Public**, and click **Create repository**.
(Public is required for free GitHub Pages.)

**3. Upload these files.** On the new repository page, click **uploading an existing file**.
Drag in *everything* from this folder, including the hidden `.github` folder — if your
computer hides it, use "Upload files" → "choose your files" and select all, or drag the
whole unzipped folder in. Click **Commit changes** at the bottom.

**4. Turn on GitHub Pages.** Go to **Settings** (top of the repository) → **Pages** in the
left sidebar. Under "Build and deployment", set Source to **Deploy from a branch**,
branch **main**, folder **/ (root)**, then **Save**.

**5. Wait two minutes**, reload that Pages settings page, and you'll see your address:

```
https://YOUR-USERNAME.github.io/sign-cards/
```

Open it. Search for **house** — a sample word is included, so you should see videos
straight away. If you do, the hard part is done.

---

## Part 2 — Build the dictionary (runs by itself)

Only one word works so far. To get the other twenty thousand:

1. Go to the **Actions** tab of your repository. If it asks, click the green button to
   enable workflows.
2. Choose **Build dictionary** on the left, then **Run workflow** on the right.
3. First time, set **Words to read this run** to `30` and click the green **Run workflow**.
   This is a quick test. After a minute, click into the run and open the log — it should
   say a number of pages had videos. If it says nothing was found, stop and tell me:
   the site's layout has changed and the script needs a tweak.
4. If the test looks right, run it again leaving everything at its defaults. It reads the
   site slowly and politely for up to five hours, then commits what it has.
5. If the log ends with words "still queued", just run it again. It picks up exactly
   where it stopped. Two or three runs should cover the whole dictionary.

Reload the app and search anything. Re-run the workflow every few months to pick up
new signs.

---

## Part 3 — Install it on your iPhone

1. Open your address in **Safari** (it must be Safari — other browsers can't install).
2. Tap the **Share** button, scroll down, tap **Add to Home Screen**, then **Add**.
3. Open it from the home screen. No address bar, own icon, and iOS will keep your
   progress safely because it is installed rather than just visited.

---

## Using it

**Search** — type a word, tap a result. Each video shows who contributed it, has a Slow
button for half speed, and a star. Starring puts that particular video in your deck, so
you can learn one contributor's version and ignore the rest.

**Practise** — "English first" shows the word and hides the sign; "Sign first" shows the
video and hides the word. Reveal, then answer honestly with the red or green button.

Each card sits in one of five boxes. Green moves it up a box, red drops it straight back
to box one. When picking the next card the app favours low boxes heavily — a box-one card
is about sixteen times likelier to appear than a box-five one — with a nudge for anything
you haven't seen lately. The dots in your deck show where each card has got to.

**Settings** — save a backup file of your deck and scores, restore one, add the starter
deck, or reset your scores.

---

## Keeping your progress safe

Progress is stored on the phone, not in the cloud. Installing to the home screen protects
it from iOS's routine clear-out, but a new phone or a reset wipes it. Tap **Save a backup**
in Settings every so often and keep the file in iCloud Drive or email it to yourself.
**Restore a backup** merges it back in.

## Editing anything later

Every file can be edited on github.com — open it, click the pencil, commit. The site
rebuilds in a minute or two. If a change doesn't show up on your phone, close the app
fully (swipe it away from the app switcher) and open it again; the old version is cached.

Want different starter words? Edit `data/starter-deck.json` — it's just a list of words in
quotes, separated by commas. Words not in the dictionary are skipped.

---

## Credit and fair use

Every word, definition and video comes from **[signbsl.com](https://www.signbsl.com/)**,
built by Daniel Mitchell, which gathers clips from the BSL community — the University of
Bristol and Deaf Studies Trust, Karl O'Keeffe, BSL First, Nathanael Farley and others.

This app copies none of it. It stores the addresses of the videos and plays them from
signbsl's servers, which means signbsl pays for the bandwidth you use. That's a light
touch for one learner. Before sharing the app widely, email them first — and note they
have their own official iOS app worth supporting.

The crawler obeys `robots.txt`, identifies itself, and pauses between requests. Please
don't speed it up.
