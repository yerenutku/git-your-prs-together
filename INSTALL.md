# Installing Git Your PRs Together

A browser extension that tells you when it's your turn on a GitHub pull request. See [README.md](README.md) for everything it does.

## What you need
- **A browser:** Chrome, Edge, Arc, Brave (any Chromium browser) or Firefox 140 or later.
- **A GitHub account** on github.com or on a GitHub Enterprise Cloud address (`yourcompany.ghe.com`), signed in in that same browser. The extension uses your browser's GitHub sign-in; no token is needed. Self-hosted GitHub Enterprise Server isn't supported yet.

## Install from a store
- **Chrome, Arc, Brave:** the Chrome Web Store listing → **Add to Chrome**.
- **Edge:** the Edge Add-ons listing (or the Chrome Web Store, after allowing extensions from other stores).
- **Firefox:** the addons.mozilla.org listing → **Add to Firefox**.

Then set it up:
1. The options page opens by itself. Under **Your GitHub**, type `github.com` or your company's address (`yourcompany.ghe.com`) and click **Save**. If the browser asks to allow access to that site, allow it.
2. **Open that GitHub and sign in.** A small tilted "Git Your PRs Together" sticker on GitHub's logo shows the extension is running.

The first refresh can take up to a minute. After that, the "Authored by me", "My threads" and "Re-review" tabs on the Pull requests page show your PRs and their state.

## Install from this folder (development)
1. **Put the folder somewhere permanent.** The browser loads it from there every time it starts; if you move it, Load unpacked again. The manifest pins a `key`, so the extension ID stays the same and your settings survive.
2. **Open the extensions page** (`chrome://extensions`, `edge://extensions`, `arc://extensions`, `brave://extensions`).
3. **Turn on Developer mode** (a switch at the top right; on Edge it's in the left sidebar).
4. Click **Load unpacked** and choose the folder (the one that contains `manifest.json`).
5. Continue with the set-up steps above.

For Firefox, run `npm run package`, then open `about:debugging` → **This Firefox** → **Load Temporary Add-on** and pick `dist/firefox/manifest.json`. A temporary add-on is gone when Firefox restarts.

**Zen** (or Firefox Developer Edition / Nightly), to keep it installed: set `xpinstall.signatures.required` to `false` in `about:config`, then `about:addons` → gear icon → **Install Add-on From File** → `dist/firefox-<version>.xpi`. Regular Firefox only installs Mozilla-signed add-ons (the store version).

**`npm run zen`** opens Zen with the Firefox build in a profile of its own (`~/.git-your-prs-together-zen`, keeps your sign-in) and reloads the extension whenever `dist/firefox` is rebuilt. Another Firefox-based browser: `FIREFOX=/path/to/its/binary npm run zen`.

## Set up notifications (macOS)
1. Open the extension's options: on the extensions page, click **Details**, then **Extension options** (Firefox: `about:addons` → the extension → **Preferences**).
2. Under **Notifications**, choose which ones you want.
3. Click **Send a test notification**.
4. If nothing pops up: open System Settings → **Notifications** → your browser. Turn on "Allow notifications" and set the alert style to **Banners** or **Alerts**. With "None", notifications only land in Notification Center.

The options page also has a **Status** section. It shows whether the extension can read GitHub, when it last refreshed, and the last notifications it sent.

## Switching to another GitHub
Change **Your GitHub** on the options page and click **Save**. Your settings stay; the PR data and what you've read belong to the old GitHub and are cleared.

## Uninstalling
On the extensions page, click **Remove** on "Git Your PRs Together". This also deletes everything it stored in the browser.

## Troubleshooting
| What you see | What to do |
|---|---|
| Nothing happens on GitHub, no sticker | Open the options and check **Your GitHub** is the address you're browsing, then reload the tab. |
| A red bar: "single sign-on expired" | Open GitHub and sign in again through your organization's single sign-on. The extension picks it up within a minute. |
| A red bar: "not signed in to GitHub in this browser" | Sign in to that GitHub in this browser. |
| Firefox/Zen: "not signed in" although you are | You're signed in inside a container (a Zen space, a Firefox container). Keep a GitHub tab open in it: the extension reads GitHub through that tab. |
| Firefox: still nothing after saving | `about:addons` → the extension → **Permissions**: allow access to your GitHub site. |
| "Developer mode extensions" warning when the browser starts | Expected for an extension loaded from a folder. Click it away; don't disable the extension. |
| Notifications don't pop up | See [Set up notifications](#set-up-notifications-macos) above. |
