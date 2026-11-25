# Git Your PRs Together: notes for Claude

A Manifest V3 extension (plain JS, no build) for github.com and GitHub Enterprise Cloud (`*.ghe.com`), published to the Chrome, Edge and Firefox stores. README.md lists every feature; keep it current when you add or change one.

## How it fits together
- `background.js` (service worker) refreshes every minute (`chrome.alarms`) and on page loads (throttled to 30 s). It stores `authored`, `myThreads`, `reRequested`, `reApprove`, `reReview` in `chrome.storage.local`. The content scripts only read storage and render.
- **Data source order:** `refreshFromSession` (`session-source.js`, GitHub's page JSON with the browser's cookies), then the token API (GraphQL/REST in `background.js`) only if that fails. Both produce the same shapes, so `summarizeAuthored` / `summarizePr` work on both.
- **Which GitHub:** `apiBase` (set on the options page, parsed by `host.js`). Until it's set nothing runs. The page scripts aren't in the manifest: `syncPageScripts()` registers them for that one host (`chrome.scripting`), on install, startup and whenever `apiBase` changes.
- **Firefox:** no service worker; `scripts/package.mjs` builds its manifest with `background.scripts` (so `importScripts` is skipped there) and the gecko settings. Keep `manifest.json` Chromium-only. Firefox containers (Zen spaces) have their own cookies and the background's requests always use the default jar: when those come back signed out, `session-source.js` reads GitHub through an open GitHub tab (`sessionFetch`: a script injected per request, so tabs with old content scripts work too). Chromium never takes that path (`tabRelay()`); `e2e:notify` step 10b tests it.
- `content/prstate.js` is loaded by the worker (`importScripts`) and by the pages, so states and notifications always agree.
- Notifications: `collectEvents` turns stored data into keyed events. `notifyChanges` shows each key once, honours `settings.notify[type]`, records silently on a first run or for a new kind (`NOTIFY_KINDS`) except events from the last 15 min, groups per PR, and logs to `notifyLog`.

## Rules
- **Bump `version` in manifest.json on every change to the extension** (docs and CI changes don't need it). Pushing to `main` releases nothing; only pushing a `v<version>` tag does: GitHub release and store submissions (RELEASING.md). Push a tag only when the user asks to release. Never remove or change the manifest `key`: it pins the extension ID (`nljndnofcmfpcpmnknkakchcgibglplm`) that the stored data and notification log hang on. `scripts/package.mjs` leaves it out of the store zips (the stores assign their own IDs).
- **After pushing, `dist/` is fresh** (`.githooks/pre-push` runs `npm run package`; needs `git config core.hooksPath .githooks`): the user tests that build locally, in Zen via `npm run zen` (auto-reloads) or with `dist/firefox-<version>.xpi`.
- **Test before saying it works.** `npm run e2e:notify`, `npm run e2e:reviewers` and `npm run e2e:host` (fake GitHub, no sign-in) must pass. For real pages run `npm run e2e:check -- <paths>` and look at the screenshot. Extend the fake world and the story when behaviour changes.
- Content scripts check `GHC.alive()` in every observer, timer and listener: after an extension reload the old copy must stop.
- **Never type into, pick in, or close-after-typing GitHub's pickers on real PRs.** The reviewers picker saves on close and drops the selected reviewers its search hides. This removed 4 reviewers from a real PR once. Test pickers against the fake.
- Anything that requests reviewers, comments or changes a real PR needs the user's OK first.
- Prefer the session data over the token. The token often can't see SSO-protected organizations' PRs. Don't trust GitHub's `commenter:` / `involves:` search alone: it misses some PRs.

## GitHub page data (session)
- Requests need `Accept: application/json`, `GitHub-Verified-Fetch: true`, `X-Requested-With: XMLHttpRequest` (else 406), with `credentials: "include"`.
- Signed out: redirect to `/login` or `/enterprises/<x>/sso`. SSO expired: lists come back empty without an error, and only the HTML says "Single sign-on to see results" (checked in `webWhoAmI`).
- `/<repo>/pull/<n>` (JSON): `lastActivityTimestamp`; title and author are only in `meta.title`.
- `/<repo>/graphs/contributors-data`: contributors (202 while GitHub computes them).
- Timestamps come with a local offset (`+01:00`), not always `Z`: compare with `Date.parse`, not as strings.

## Testing and debugging
- The `e2e/` test profile lives in `~/.git-your-prs-together-e2e/profile`. Its SSO session expires: `npm run e2e:login`, the user signs in, quits with Cmd+Q. If only the window was closed, `kill -TERM` the main Chromium process.
- Chrome caches the extension's service worker in the profile: `freshWorker()` (e2e/config.mjs) clears it before each run. Without it, old `background.js` code runs.
- `e2e/probe-sw.mjs <file.js>` runs JS in the extension's worker with the signed-in test profile.
- The host the signed-in scripts open: `GHC_HOST` or `e2e/local.json` (see `e2e/config.mjs`); `useHost()` points the extension at it.
- The user's real data: Arc stores the extension's storage as LevelDB in `~/Library/Application Support/Arc/User Data/Profile 2/Local Extension Settings/<extension id>/`. Copy the `.log` and parse the records to see what the extension stored and notified.
- Claude in Chrome hangs in Arc when it creates a tab group; use the built-in browser (sign in there when needed).
