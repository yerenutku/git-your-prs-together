# Releasing

## How a release happens
Only a pushed version tag releases. Pushing to `main` never does.

1. Bump `version` in `manifest.json` (every extension change does anyway), commit and push to `main`.
2. When you want to release that version, tag the commit and push the tag:
   ```bash
   git tag v<version>
   git push origin v<version>
   ```
3. GitHub Actions (`.github/workflows/release.yml`) runs the fake-GitHub tests. If they pass and the tag matches the version in `manifest.json`, it:
   - builds `dist/chrome-<version>.zip` and `dist/firefox-<version>.zip` (`npm run package`);
   - creates the GitHub release `v<version>` with both zips attached;
   - submits the version to each store whose secrets are set (Chrome Web Store, Firefox Add-ons, Edge Add-ons).
4. Each store reviews it (hours to a few days) before users get it.

Pushes to `main` and pull requests only run the tests, so docs such as `PRIVACY.md` can change without a release. A tag that doesn't match `manifest.json` fails the release job.

**One review at a time.** A store can refuse a new upload while the previous version is still in review. Several versions can pile up on `main`; tag only the one you want to release.

**A store step failed?** If the cause is outside the code (such as a secret), fix it, then run the workflow by hand (Actions → Test and release → Run workflow), pick the version's **tag** under "Use workflow from" and tick **republish**. It submits that version to the stores again without making a new GitHub release. If the fix needs a code or workflow change, release it as a new version: a tag runs the files as they were when it was made.

## One-time setup per store
The APIs can only update an extension that already exists in the store, so the first version is uploaded by hand. After that, add the secrets in the GitHub repo under Settings → Secrets and variables → Actions. A store without secrets is skipped.

### Chrome Web Store
1. Register as a developer at the [Chrome Web Store developer dashboard](https://chrome.google.com/webstore/devconsole) (one-time $5 fee; 2-step verification on the Google account).
2. **New item** → upload `dist/chrome-<version>.zip`. Fill in the listing (description, screenshots 1280×800, a 440×280 promo tile), the **Privacy** tab (single purpose, a reason per permission, no remote code, data use; privacy policy URL: the repo's `PRIVACY.md`), and submit.
3. API access (API v2): in the [Google Cloud console](https://console.cloud.google.com/) create a project, enable the **Chrome Web Store API**, create an OAuth client (type "Desktop app"), and get a refresh token for it with the `https://www.googleapis.com/auth/chromewebstore` scope. [chrome-webstore-upload-keys](https://github.com/fregante/chrome-webstore-upload-keys) walks through it.
4. Secrets: `CWS_EXTENSION_ID` (the item's ID), `CWS_PUBLISHER_ID` (the dashboard's Account page), `CWS_CLIENT_ID`, `CWS_CLIENT_SECRET`, `CWS_REFRESH_TOKEN`.

### Firefox Add-ons (addons.mozilla.org)
1. Sign in at the [Developer Hub](https://addons.mozilla.org/developers/) (free; turn on two-factor authentication).
2. **Submit a New Add-on** → "On this site" → upload `dist/firefox-<version>.zip`. No source code is needed: nothing is minified or bundled. Fill in the listing and link `PRIVACY.md`.
3. **Manage API Keys** → generate credentials.
4. Secrets: `AMO_JWT_ISSUER`, `AMO_JWT_SECRET`.

The add-on's ID (`GECKO_ID` in `scripts/package.mjs`) can never change after the first upload.

### Microsoft Edge Add-ons
1. Register at [Partner Center](https://partner.microsoft.com/dashboard/microsoftedge/) (free).
2. **Create new extension** → upload `dist/chrome-<version>.zip` (the same one as Chrome), fill in the listing and submit.
3. **Publish API** → create API credentials (API v1.1).
4. Secrets: `EDGE_PRODUCT_ID` (the extension's product ID), `EDGE_CLIENT_ID`, `EDGE_API_KEY`.

## Before the first store upload
- Run `npx web-ext lint --source-dir dist/firefox` and fix what it reports.
- Try the Firefox build once: `about:debugging` → This Firefox → Load Temporary Add-on → `dist/firefox/manifest.json`.
- Take the store screenshots on a demo repo, not on private code.
