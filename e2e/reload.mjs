// npm run e2e:reload — collect every error the extension produces: on a normal page load, and after the extension is reloaded
// while the GitHub tab stays open (what happens when you click reload in arc://extensions).
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";
import { EXT, EXT_ID, HOST, PROFILE, freshWorker, useHost } from "./config.mjs";
freshWorker();
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium", headless: true, viewport: { width: 1440, height: 900 },
  ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await useHost(ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 })), HOST);
const cdpErrors = [];
const page = await ctx.newPage();
const cdp = await ctx.newCDPSession(page);
await cdp.send("Runtime.enable");
cdp.on("Runtime.exceptionThrown", (e) => cdpErrors.push(`exception: ${e.exceptionDetails.exception?.description?.split("\n").slice(0, 3).join(" | ") || e.exceptionDetails.text}`));
cdp.on("Runtime.consoleAPICalled", (e) => e.type === "error" && cdpErrors.push(`console.error: ${e.args.map((a) => a.value ?? a.description).join(" ")}`));
const phase = (name) => cdpErrors.push(`--- ${name} ---`);
phase("normal load");
await page.goto(`${HOST}/pulls/authored`, { waitUntil: "domcontentloaded" });
await page.waitForTimeout(10000);
phase("after extension reload (tab kept open)");
const opts = await ctx.newPage();
await opts.goto(`chrome-extension://${EXT_ID}/options.html`);
await opts.evaluate(() => chrome.runtime.reload()).catch(() => {});
await opts.close().catch(() => {});
await page.waitForTimeout(3000);
await page.evaluate(() => { document.body.appendChild(document.createElement("div")); }); // trigger the MutationObserver
await page.mouse.move(300, 300);
await page.waitForTimeout(4000);
phase("page reloaded with the new version");
await page.reload({ waitUntil: "domcontentloaded" });
await page.waitForTimeout(8000);
console.log("version on page:", await page.locator(".ghc-au-count").getAttribute("title").catch(() => "badge not found"));
const seen = new Map();
for (const e of cdpErrors) seen.set(e, (seen.get(e) || 0) + 1);
for (const [e, n] of seen) console.log(n > 1 ? `${n}× ${e}` : e);
await ctx.close();
// A reload leaves the command-line-loaded extension disabled in the test profile: reset its entry.
const SP = path.join(PROFILE, "Default", "Secure Preferences");
const d = JSON.parse(fs.readFileSync(SP, "utf8"));
delete d.extensions?.settings?.[EXT_ID];
delete d.protection?.macs?.extensions?.settings?.[EXT_ID];
fs.writeFileSync(SP, JSON.stringify(d));
