// Load Git Your PRs Together into Playwright's Chromium (signed-in test profile), open GitHub pages,
// and report what the extension drew: badges, PR state labels, the re-review bar, its own logs, plus a screenshot.
//
//   npm run e2e:check                                   # your Authored pages
//   npm run e2e:check -- /owner/repo/pull/123/files
//   HEADED=1 npm run e2e:check                          # watch it in a window
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { EXT, HOST, OUT, PROFILE, freshWorker, useHost } from "./config.mjs";

const targets = process.argv.slice(2);
const urls = (targets.length ? targets : ["/pulls/authored"]).map((u) => (u.startsWith("http") ? u : HOST + u));
const SETTLE_MS = Number(process.env.SETTLE_MS || 8000); // the extension polls GitHub's page data after load

if (!fs.existsSync(PROFILE)) {
  console.error(`No test profile yet. Run: npm run e2e:login`);
  process.exit(2);
}
if (fs.existsSync(path.join(PROFILE, "SingletonLock"))) {
  console.error("The test browser is still open (from npm run e2e:login?). Quit it with Cmd+Q, then run this again.");
  process.exit(2);
}
fs.mkdirSync(OUT, { recursive: true });

freshWorker();
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium", // full Chromium (new headless), which can run extensions
  headless: process.env.HEADED !== "1",
  viewport: { width: 1440, height: 900 },
  // The sign-in (e2e/login.mjs) stored its cookies encrypted with the real macOS Keychain;
  // Playwright's default mock keychain can't read them, so the profile would look signed out.
  ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

const report = { extension: null, pages: [] };
try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  await useHost(sw, HOST);
  report.extension = await sw.evaluate(async () => {
    const s = await chrome.storage.local.get(null);
    return {
      version: chrome.runtime.getManifest().version,
      tokenSet: !!s.token, // never the token itself
      storageKeys: Object.keys(s).filter((k) => k !== "token").sort(),
    };
  });

  for (const url of urls) {
    const page = await ctx.newPage();
    const logs = [];
    page.on("console", (m) => /companion|ghc/i.test(m.text()) && logs.push(`${m.type()}: ${m.text()}`));
    page.on("pageerror", (e) => logs.push(`pageerror: ${e.message}`));
    await page.goto(url, { waitUntil: "domcontentloaded" });
    const user = await page.locator('meta[name="user-login"]').getAttribute("content").catch(() => null);
    if (!user) {
      report.pages.push({ url, landed: page.url(), error: "Not signed in in the test profile (GitHub's SSO session expired?). Run: npm run e2e:login" });
      await page.close();
      continue;
    }
    await page.waitForTimeout(SETTLE_MS);
    const drawn = await page.evaluate(() => {
      const txt = (e) => e.textContent.replace(/\s+/g, " ").trim();
      const prOf = (e) => e.closest("li, [role='row'], .js-issue-row")?.querySelector("a[href*='/pull/']")?.getAttribute("href") || null;
      const counts = {};
      for (const e of document.querySelectorAll("[class*='ghc-'], [id^='ghc-']")) {
        for (const c of [...e.classList, e.id].filter((c) => c.startsWith("ghc-"))) counts[c] = (counts[c] || 0) + 1;
      }
      const bar = document.getElementById("ghc-bar");
      return {
        badges: [...document.querySelectorAll(".ghc-rr-badge, .ghc-au-count, .ghc-threads-open, .ghc-threads-count")].map((e) => ({
          class: e.className,
          text: txt(e),
          title: e.title,
        })),
        prStates: [...document.querySelectorAll(".ghc-au-chip, .ghc-au-row")].map((e) => ({
          text: txt(e.matches(".ghc-au-row") ? e.querySelector(".ghc-au-state") || e : e),
          class: e.className,
          pr: e.matches("a") ? e.getAttribute("href") : prOf(e),
          title: e.title,
        })),
        reReviewBar: bar && !bar.hidden ? txt(bar) : null,
        elementsByClass: counts,
      };
    });
    const shot = path.join(OUT, `${new URL(url).pathname.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "home"}.png`);
    await page.screenshot({ path: shot });
    report.pages.push({ url, user, ...drawn, logs, screenshot: shot });
    await page.close();
  }
} finally {
  await ctx.close();
}
console.log(JSON.stringify(report, null, 2));
