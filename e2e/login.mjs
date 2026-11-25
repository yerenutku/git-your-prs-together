// One-time sign-in for the test browser.
// Opens Playwright's Chromium as a plain browser window, with no automation attached, on the test profile.
// Sign in to GitHub there the normal way (SSO, MFA), then QUIT Chromium (Cmd+Q). The sign-in stays saved in the profile.
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { chromium } from "playwright";
import { HOST, PROFILE } from "./config.mjs";

// GitHub's SSO session cookie only lasts for the browser session. "Continue where you left off" makes Chromium
// keep session cookies across restarts, so the test runs (e2e/check.mjs) start signed in.
const prefsFile = path.join(PROFILE, "Default", "Preferences");
fs.mkdirSync(path.dirname(prefsFile), { recursive: true });
let prefs = {};
try {
  prefs = JSON.parse(fs.readFileSync(prefsFile, "utf8"));
} catch {}
prefs.session = { ...(prefs.session || {}), restore_on_startup: 1 };
fs.writeFileSync(prefsFile, JSON.stringify(prefs));

const child = spawn(
  chromium.executablePath(),
  [`--user-data-dir=${PROFILE}`, "--no-first-run", "--no-default-browser-check", `${HOST}/`],
  { detached: true, stdio: "ignore" }
);
child.unref();
console.log(
  `Opened Chromium on ${HOST} with the test profile:\n  ${PROFILE}\n` +
    `Sign in, then quit Chromium with Cmd+Q (closing the window isn't enough on macOS).`
);
