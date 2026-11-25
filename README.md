# Git Your PRs Together

![A smiling fan in a hard hat holding pull requests](icons/readme-icon.png)

A browser extension that tells you when it's your turn on a GitHub pull request: desktop notifications, state labels on your PRs, a "My threads" and a "Re-review" tab, a contributor-first reviewer picker, and files ticked as Viewed while you read them.

It works on **github.com** and on **GitHub Enterprise Cloud** (`yourcompany.ghe.com`); you pick which one on the options page. Self-hosted GitHub Enterprise Server isn't supported yet. It runs in Chrome, Edge, Arc, Brave and Firefox.

It works with your browser's GitHub sign-in. A personal access token is optional. Everything stays in your browser: the extension only talks to the GitHub you picked (see [PRIVACY.md](PRIVACY.md)).

Not affiliated with or endorsed by GitHub.

## Features

### The sticker
A small, tilted "Git Your PRs Together" sticker sits on GitHub's logo in the header, so you can see at a glance that the extension is running. Hover over it for the version.

### Where the data comes from
- **Your browser's sign-in, no token needed.** Every minute the background worker reads the same JSON that GitHub's own pages load: PR lists (`/pulls?q=…`) and, per PR, `page_data/conversation_comments`, `threads`, `review_requests`, `merge_box` and `status_checks`. It sees every PR you can see in the browser.
- **The token is a fallback.** If that page data can't be read, the extension uses the API with the token from the options. The token also enables "files changed since my approval".
- **Problems are shown, not hidden.** If you're signed out of GitHub, or your organization's single sign-on has expired, a red bar at the bottom of every GitHub page says so, instead of the extension quietly showing nothing.

### Desktop notifications
Each kind can be switched on or off in the options:

| Option | You get a notification when… |
|---|---|
| **A re-review is needed** | someone asks you to review a PR again ("carol asks for your re-review"), or your approval was dismissed, usually by a new push ("Your approval was dismissed") |
| **One of my PRs is ready to merge** | GitHub says all merge requirements are met (or, failing that: approved and checks passed). Once per commit. |
| **One of my PRs needs attention** | someone comments on or reviews your PR ("alice commented on your PR", "bob approved your PR"), or the checks on the latest commit pass |
| **New message in a thread I'm following** | someone replies after your last comment on a PR you commented on or reviewed ("randy replied to you") |

- Every event notifies once. Turning a kind back on doesn't replay what you missed while it was off.
- On a first install or an update, older events are recorded silently. Anything from the last 15 minutes still notifies.
- Several updates on one PR become one notification ("+2 more updates"). More than 5 PRs at once become one summary.
- Clicking a notification opens the comment, the review, or the changes.
- Titles are short enough to fit on one line on macOS; the body shows the PR title and its repo and number.
- The options page has **Send a test notification**, a **Status** section (data source, last refresh) and the **last notifications sent**. If nothing pops up, check macOS System Settings → Notifications → your browser: the alert style must be Banners or Alerts, not None.

### "Authored by me": your PRs and their state
- **Count badge** on the "Authored by me" tab: red while a PR has comments you haven't read, green when one is ready to merge and nothing waits for you.
- **Sidebar list** under the tab: each open PR with its state:
  - **Needs your attention** ("N new comments"): comments or reviews you haven't seen or answered.
  - **Ready to merge**: GitHub's own merge verdict. It also shows unread comments ("Ready to merge · 3 new").
  - **In progress**, with the reason: draft, checks failing or running, merge conflicts, open threads to answer, changes requested, branch behind.
  - **Their turn**: waiting on reviewers.
- **State chips** on your PRs in GitHub's own lists (Authored by me, Inbox, repo PR lists). A PR with unread comments is highlighted in red.
- The red marks pulse 3 times when a comment is new, then stay still (also on later page loads) until a newer comment arrives.
- Opening a PR marks its comments as read.

### "My threads" tab
Replaces "Assigned to me" in the PR dashboard sidebar.
- Lists the PRs you commented on or reviewed in the last 3 weeks, with "N new replies", open and resolved threads. A click opens the first new reply.
- **Grey counter:** the open PRs you take part in. **Blue badge:** how many of them have replies you haven't read.
- **Open only** by default. "Show closed too" in the panel adds merged and closed PRs (remembered).
- PRs you open in the browser are also checked directly, because GitHub's `commenter:` search misses some PRs.
- On a repo's PR page it shows that repo; "All repos" switches to everything.

### "Re-review" tab
- PRs whose approval from you was dismissed, usually by a new push. Listed in the panel and under the tab, with how many files changed since your approval (with a token).
- Opens straight to "changes since my approval" when the approved commit is known (token), else to Files changed.

### Re-review bar
A bar at the bottom of every GitHub page lists the PRs you reviewed that got new commits since your last review. × hides one until its next push.

### Review requests counter
A red counter on the "Review requests" tab, counted from GitHub's own page. When the number changes, a +N or −N bubble flies in.

### Reviewer picker: contributors first
In a PR's "Reviewers" picker:
- The repo's **contributors** are listed first, most commits first, with avatars. They come from GitHub's contributors graph (read with your browser's sign-in, refreshed every 10 minutes because the avatar links expire), or from the manual list in the options.
- **Search contributors** with the picker's own search box; Enter picks the first match.
- **Show all users from the company** (the last item) switches to GitHub's own list; "← Only contributors" switches back.
- Picking someone drives GitHub's own picker, so the request goes through GitHub exactly as by hand.
- **Safety:** GitHub's picker saves when it closes and drops the selected reviewers its search hides. The extension clears that search, and waits for GitHub's list, before the picker closes.

### Assignee picker
Hides people who aren't contributors of the repo. Same list as the reviewer picker: GitHub's contributors graph with your browser's sign-in, or the manual list in the options. If the list can't be read, nobody is hidden.

### Auto-mark files as Viewed
In "Files changed", a file is ticked as Viewed once you've read it: its first and last line have both been on screen, and it has scrolled out of the top. The last files on the page are ticked when you finish (pointing at the review button or another PR tab, or leaving the page).
- An **Auto** switch on every file header turns this off for that file (remembered per PR).
- A floating switch pauses the feature, for example while searching the page.
- Switch it off completely in the options.

## Install
Install it from your browser's add-on store, or load this folder unpacked. On first install the options page opens: type your GitHub (`github.com` or `yourcompany.ghe.com`), click **Save**, and sign in to that GitHub in the same browser.

**[INSTALL.md](INSTALL.md)** has the full steps, setting up notifications on macOS, updating, uninstalling and troubleshooting.

## Development
The extension is plain JavaScript (Manifest V3); there's no build step, and this folder loads unpacked in any Chromium browser as is. `npm install` only installs Playwright for the tests.

| Command | What it does |
|---|---|
| `npm run e2e:notify` | Plays a story against a fake GitHub (`e2e/fake-github.mjs`): comments, replies, ready to merge, re-review, opting out and in, the "your turn" marks, signed out and SSO expired. It runs twice: with the session data and with the token. |
| `npm run e2e:reviewers` | The reviewer picker against a fake picker that behaves like GitHub's, including save-on-close. |
| `npm run e2e:host` | Picking a GitHub: the welcome on install, refusing other sites, the page scripts following the chosen host, switching keeps settings. |
| `npm run e2e:check -- <paths>` | Loads the extension into a signed-in test browser, opens real GitHub pages and reports what it drew, plus a screenshot in `e2e/out/`. |
| `npm run e2e:login` | Opens the test browser to sign in; quit it with Cmd+Q afterwards. |
| `npm run package` | Builds the store uploads in `dist/`: `chrome-<version>.zip` (Chrome Web Store, Edge Add-ons), `firefox-<version>.zip` (addons.mozilla.org) and `firefox-<version>.xpi` (installing it locally). Runs before every `git push` too (`.githooks/pre-push`; once per clone: `git config core.hooksPath .githooks`). |
| `npm run zen` | Runs the Firefox build in Zen with its own profile and reloads it when `dist/firefox` changes (INSTALL.md). |

To release, push a `v<version>` tag that matches `version` in `manifest.json`; pushing to `main` only runs the tests. See [RELEASING.md](RELEASING.md).

The signed-in scripts (`e2e:check`, `e2e:login`, `e2e:reload`) open github.com unless you set `GHC_HOST=https://yourcompany.ghe.com` or put `{ "host": "https://yourcompany.ghe.com" }` in `e2e/local.json` (not committed).
| `npm run e2e:reload` | Reloads the extension under an open GitHub tab and lists any errors. |

## Files
| File | What it is |
|---|---|
| `manifest.json` | Extension manifest (the Chromium one; `scripts/package.mjs` derives Firefox's); bump `version` on every change |
| `host.js` | Which GitHub: parses github.com / `*.ghe.com` into the web and API addresses |
| `background.js` | Service worker: refreshes the data, notifications, the token API path |
| `session-source.js` | Reads GitHub's page data with the browser's sign-in |
| `content/prstate.js` | The state of one of your PRs (shared by the worker and the pages) |
| `content/pulls.js` / `.css` | PR dashboard: counters, Authored states, My threads, Re-review |
| `content/statusbar.js` / `.css` | The bar at the bottom (re-review, errors) |
| `content/reviewers.js` / `.css` | Contributor-first reviewer picker |
| `content/assignee.js` | Assignee picker filter |
| `content/autoviewed.js` / `.css` | Auto-mark files as Viewed |
| `content/brand.js` / `.css` | The "Git Your PRs Together" sticker on GitHub's logo |
| `options.html` / `options.js` | Options and status page |
| `e2e/` | Playwright tests and the fake GitHub |
| `scripts/package.mjs` | Builds the per-browser store zips |
| `scripts/zen.mjs` | `npm run zen` |
| `.githooks/pre-push` | Rebuilds `dist/` before every push |
| `scripts/publish-edge.mjs` | Submits a zip to Edge Add-ons (used by the release workflow) |
| `.github/workflows/release.yml` | Tests pushes to `main` and pull requests; a `v<version>` tag releases and submits to the stores |
| `PRIVACY.md` | Privacy policy (link it from the store listings) |

## License
[MIT](LICENSE)
