---
name: ship-app-update
description: >
  Handles bug reports, feature requests, and UI complaints for the
  長町倫理_活動計画 app (this repo, nagamachi-rinri-katsudo-keikaku — a static
  index.html + Google Apps Script/PIN backend, deployed on GitHub Pages).
  ALWAYS use this skill whenever the user reports something wrong or wants
  something changed in this app — including terse messages, a bare
  screenshot/video attachment with no text, or Japanese phrases like
  「〜が消えた」「〜がうまくいかない」「〜を直して」「〜を追加したい」「〜を縮小したい」.
  Covers the whole loop: diagnosing (Drive checks, video/screenshot analysis,
  reading Code.gs/index.html), implementing on a branch, testing with
  Playwright, bumping APP_VERSION per this repo's CLAUDE.md, opening a draft
  PR with a Japanese summary + honest test plan, waiting for the user's "OK",
  and merging. Also covers this app's known trouble spots: the PIN + Apps
  Script backend requiring a manual redeploy, the service worker cache, and
  the mobile reference-doc iframe embeds.
---

# Shipping an update to 長町倫理_活動計画

This app is maintained through a lot of small, fast round-trips: the user
reports something in a short message (often just a screenshot or video, no
text), you diagnose, fix, test, and open a draft PR, they say "OK", you
merge. This skill is the accumulated shape of that loop — follow it so each
round-trip stays fast and doesn't re-litigate things already settled.

## The architecture, in brief

- `index.html` — the entire app: markup, CSS, and two `<script>` blocks. No
  build step, no bundler. GitHub Pages serves it directly.
- `apps-script/Code.gs` — the backend, deployed separately as a Google Apps
  Script Web App. **Editing this file in the repo does NOT affect the live
  backend.** Someone has to paste the new code into script.google.com and
  create a new deployment version. See "Apps Script changes" below.
- `sw.js` — a service worker that makes saves/loads network-first but keeps
  a fallback cache fresh on every successful fetch (see git history for why
  — it used to go stale for years and revert users to an ancient version).
- `CLAUDE.md` — the version-bump policy. Read it. Short version: bump
  `APP_VERSION` in `index.html` on every behavior change (patch for
  fixes/tweaks, minor for new features), skip it for docs-only changes.

## Step 0: figure out what actually happened

The user's report is often minimal. Don't guess — read what's actually
there first:

- **A video attachment, no text**: extract frames with ffmpeg
  (`ffmpeg -i video.mp4 -vf fps=3 frames/f_%03d.png`, install via
  `apt-get install -y --no-install-recommends ffmpeg` if missing) and read
  through them in order. Watch for the moment something changes, not just
  the first/last frame — the bug is often only visible mid-sequence.
- **A screenshot**: read it directly. Check the title bar and UI text
  against what's currently in `index.html` — a mismatch (old title, old
  login flow, old status text) is a strong signal the user is looking at a
  **stale cached page**, not a live bug. If so, ask them to fully close and
  reopen the tab/app (not just switch away and back) before chasing a code
  fix that may not exist.
- **A reference to a Google Sheet/Doc**: check it directly with the
  Google Drive tools — `get_file_metadata` and `get_file_permissions` at
  minimum. Files referenced from this app are often owned by *other people*
  in the ethics association, not the app's own Google account, so don't
  assume you can fix sharing settings — you often can't, and should say so.
- **A live/current bug claim ("every time" vs "just once")**: ask if you
  genuinely don't know, rather than guessing at a fix. One clarifying
  question with 2-4 concrete options is much cheaper than an unverifiable
  patch. Don't over-ask, though — if you can find the answer yourself
  (reading the code, checking Drive, curling an endpoint), do that first.

## Step 1: implement on a fresh branch

```bash
cd /workspace/nagamachi-rinri-katsudo-keikaku
git checkout master && git pull origin master
git checkout -b claude/<short-kebab-description>
```

Always branch from freshly-pulled `master` — this repo ships several small
PRs per session, so master moves between your last check and now.

Make the change. A few conventions specific to this codebase:

- The JS is plain ES5-ish (no arrow functions in older sections, `var`
  throughout) — match the surrounding style rather than introducing modern
  syntax inconsistently.
- Mobile-specific CSS lives inside `@media (max-width: 680px)` — the user's
  device is a phone, and PC display is generally considered "fine as-is"
  unless they say otherwise. Don't touch desktop styling to fix a mobile
  complaint.
- The reference-docs section (participant sees "参考資料" with tabs) embeds
  two different Google Drive preview renderers with different quirks:
  - `docs.google.com/spreadsheets/d/<id>/preview` for native Sheets — fairly
    tolerant of the CSS zoom-out trick below.
  - `drive.google.com/file/d/<id>/preview` for the .xlsx roster — a
    different (Office-conversion) renderer that goes **permanently blank**
    at aggressive zoom and only tolerates a mild one. If asked to change its
    zoom level, be conservative and say the risk out loud.
  - The zoom-out trick: render the iframe into an oversized wrapper
    (`width/height: calc(100% / var(--zoom))`) and scale it down
    (`transform: scale(var(--zoom))`), because Google's embedded viewers
    render at native size and swallow pinch gestures themselves. The
    `--zoom` custom property lives on `.iframe-zoom-wrap`; add a modifier
    class (see `.zoom-80` in the CSS) rather than duplicating the whole
    rule per tab.
  - Safari has a known bug where a transformed iframe can drop out of paint
    entirely during a heavy gesture (pinch-zoom) and never repaint. The
    wrapper and its `overflow:hidden` ancestor are pinned to their own
    compositing layer (`will-change`, `backface-visibility`,
    `translateZ(0)`) to reduce this — it's a mitigation, not a guaranteed
    fix, and it's fair to say so in the PR.
- Autosave failure handling: `state.lastErrorCtx` tracks whether the last
  error came from a save or a load, and the error banner's retry button
  dispatches accordingly. **Never wire a "retry" action to `loadLatest()`
  unconditionally** — it overwrites `state.events` from the server with no
  dirty-check, which silently discards whatever the user just typed. This
  bit us once already (see git history: "retrying a failed save discarded
  the edit").

Bump `APP_VERSION` (near the top of the second `<script>` block) per
CLAUDE.md's policy. If another branch already bumped it and you conflict on
merge, just take the next increment past whichever value ends up on
`master` — see "Merging" below.

## Step 2: test before committing

You cannot rely on eyeballing the diff — this app has broken in non-obvious
ways before (CSS that computes fine but a transform bug only Safari hits,
JS that parses fine but a listener wired to the wrong function). Actually
run it:

```bash
node -e "
const fs = require('fs');
const html = fs.readFileSync('index.html', 'utf8');
[...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].forEach((m, i) => {
  try { new Function(m[1]); console.log('script', i, 'OK'); }
  catch (e) { console.log('script', i, 'SYNTAX ERROR:', e.message); }
});
"
```

Then serve it and drive it with Playwright:

```bash
python3 -m http.server 8931   # run_in_background: true
```

```js
const { chromium } = require('/opt/node22/lib/node_modules/playwright');
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
```

- Test both a phone viewport (`390x844`) and desktop (`1280x900`) when the
  change is mobile-specific — confirm the desktop path is provably
  untouched (e.g. assert `getComputedStyle(el).transform === 'none'`)
  rather than just assuming it.
- To test save/load/PIN behavior, mock the Apps Script backend with
  `page.route('https://script.google.com/**', ...)` and return canned JSON
  matching `Code.gs`'s response shape (`{ok, exists, fileId, content,
  revisions}` for load, `{ok, fileId, modifiedTime}` for save). This is the
  only reliable way to reproduce failure/retry scenarios — see git history
  for a working example ("fix-save-retry-discards-edits").
- **This sandbox cannot reach `docs.google.com`/`drive.google.com` from the
  browser** (network egress is restricted for that path, even though `curl`
  can reach it). Don't burn time trying to make Playwright load real Google
  content — verify embeddability via `curl -I` for `X-Frame-Options`/
  `frame-ancestors` instead, and say plainly in the PR that on-device
  verification is still needed. Being honest about this beats claiming a
  test proved something it didn't.
- Take a screenshot for anything visual and actually look at it before
  calling it done.

## Step 3: commit, push, open a draft PR

Commit message: explain the *why*/root cause, not just what changed —
future-you (or the next session) reading `git log` should understand the
reasoning without re-deriving it.

```bash
git add <files>
git commit -m "..."
git push -u origin claude/<branch-name>
```

Open the PR as a **draft**, in Japanese, with this shape (matches every PR
in this repo's history):

```
## Summary
- What changed and why, in 2-4 bullets
- Root-cause explanation if this is a bug fix, not just "fixed X"

## Test plan
- [x] things you actually verified (be specific — "Playwrightで確認" is
      weaker than "Playwrightで、パネルのtransformが0.5であることを確認")
- [ ] things you could NOT verify from this environment (be honest — e.g.
      real device rendering, actual Google content loading)
```

Then **stop and wait for the user to say something like "OK"** before doing
anything else. Never merge without an explicit go-ahead, even if the fix
seems obviously safe — this has been the consistent pattern across dozens
of PRs in this repo.

## Step 4: merging

On "OK" (possibly covering multiple pending PRs at once — check for other
open drafts you haven't gotten confirmation on and ask if they're included
too, rather than assuming):

```
mark ready (draft: false) -> merge (squash, unless a local conflict
resolution already produced a merge commit, in which case a plain merge is fine)
```

If the merge conflicts — almost always just the `APP_VERSION` line clashing
with another branch that merged first — resolve locally:

```bash
git fetch origin master && git checkout <branch> && git merge origin/master
# resolve the APP_VERSION conflict by taking the next increment past
# whichever value is now on master; keep both branches' actual feature diffs
git add index.html && git commit --no-edit
git push origin <branch>
```

then merge via the API as normal.

## Apps Script changes

If the PR touches `apps-script/Code.gs`, **say explicitly in the PR body**
that merging alone does not deploy it — someone needs to paste the updated
code into script.google.com and create a new deployment version (edit the
existing deployment, not a fresh one, so the URL stays the same). You
cannot do this yourself; there's no Apps Script API access from this
session, only Drive file access. Point at `apps-script/README.md` for the
exact steps, and keep that file's redeploy instructions current if the
process ever changes.

## Verifying a fix actually landed

When asked "did the fix work" or "what's the status," don't just say
"should be fixed now" — check:

- Google Drive directly (`search_files` for a folder/file the fix was
  supposed to create or move) if the change touched Drive-side behavior.
- `curl` the live GitHub Pages URL and grep for a string that only exists in
  the new version (a new heading, a new default value) to confirm the
  deploy actually rolled out, before telling the user to go check.
