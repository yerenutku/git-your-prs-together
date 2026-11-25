// Picking a GitHub: the options page opens on install and asks; nothing runs until then; the page scripts run only on
// the GitHub picked; switching to another one keeps the settings and clears the old GitHub's data. Against the fake
// GitHub (e2e/fake-github.mjs), served for both acme.ghe.com and github.com.
//
//   npm run e2e:host
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { EXT, OUT } from "./config.mjs";
import { handle, serve } from "./fake-github.mjs";

const ACME = "https://acme.ghe.com";
const DOTCOM = "https://github.com";
const world = { me: "me", mine: [], theirs: [], reRequested: [], dismissed: [] };
const results = [];
let failed = 0;
function check(what, ok, detail) {
  results.push({ what, ok: !!ok, ...(ok ? {} : { detail }) });
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}

fs.mkdirSync(OUT, { recursive: true });
const server = await serve(() => world);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ghc-host-"));
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: process.env.HEADED !== "1",
  viewport: { width: 1100, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
for (const host of [ACME, DOTCOM]) {
  await ctx.route(`${host}/**`, async (route) => {
    const r = route.request();
    const out = handle(world, { url: r.url().replace(DOTCOM, ACME), method: r.method(), body: r.postData(), headers: r.headers() });
    await route.fulfill({ status: out.status || 200, contentType: out.html != null ? "text/html" : "application/json", body: out.html != null ? out.html : JSON.stringify(out.json) });
  });
}

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = new URL(sw.url()).host;
  // The worker's GitHub requests go to the fake too; never to the real github.com.
  await sw.evaluate(
    ({ port, hosts }) => {
      const realFetch = self.fetch.bind(self);
      self.fetch = (input, init = {}) => {
        const url = typeof input === "string" ? input : input.url;
        if (hosts.some((h) => url.startsWith(h + "/"))) return realFetch(`http://127.0.0.1:${port}/${encodeURIComponent(url)}`, { ...init, credentials: "omit" });
        return Promise.reject(new Error(`unexpected request in the test: ${url}`));
      };
    },
    { port: server.port, hosts: [ACME, "https://api.acme.ghe.com", DOTCOM, "https://api.github.com"] }
  );
  const stored = () => sw.evaluate(() => chrome.storage.local.get(null));
  const registered = () => sw.evaluate(async () => (await chrome.scripting.getRegisteredContentScripts()).map((s) => s.matches).flat());
  const sticker = async (url) => {
    const p = await ctx.newPage();
    await p.goto(url);
    const on = await p.waitForSelector(".gypt-sticker", { timeout: 4000 }).then(() => true, () => false);
    await p.close();
    return on;
  };

  console.log("\nFirst install");
  const optionsUrl = `chrome-extension://${extId}/options.html`;
  let opts = null;
  for (let i = 0; i < 50 && !opts; i++) (opts = ctx.pages().find((p) => p.url() === optionsUrl)) || (await new Promise((r) => setTimeout(r, 200)));
  check("the options page opens by itself", !!opts, ctx.pages().map((p) => p.url()));
  const page = opts || (await ctx.newPage());
  if (!opts) await page.goto(optionsUrl);
  await page.waitForLoadState();
  check("it says welcome and asks which GitHub", await page.isVisible("#welcome"), null);
  check("no page scripts are registered yet", (await registered()).length === 0, await registered());
  check("nothing runs on a GitHub page yet", !(await sticker(`${ACME}/pulls`)), null);
  await page.screenshot({ path: path.join(OUT, "host-1-welcome.png") });

  console.log("\nA wrong address");
  await page.fill("#host", "gitlab.com");
  await page.click("#save");
  check("is refused with a message", /github\.com/.test(await page.textContent("#hostError")), await page.textContent("#hostError"));
  check("and nothing is saved", !(await stored()).apiBase, await stored());

  console.log("\nPicking acme.ghe.com");
  await page.fill("#host", "https://acme.ghe.com/pulls");
  await page.fill("#token", "keep-me");
  await page.click("#save");
  await page.waitForSelector("#status:text('Saved')");
  await page.screenshot({ path: path.join(OUT, "host-2-saved.png") });
  check("stores its API address", (await stored()).apiBase === "https://api.acme.ghe.com", (await stored()).apiBase);
  check("shows the cleaned-up address and hides the welcome", (await page.inputValue("#host")) === "acme.ghe.com" && !(await page.isVisible("#welcome")), await page.inputValue("#host"));
  await page.waitForTimeout(500);
  check("registers the page scripts for acme.ghe.com only", JSON.stringify(await registered()) === JSON.stringify([`${ACME}/*`]), await registered());
  check("runs on acme.ghe.com", await sticker(`${ACME}/pulls`), null);
  check("doesn't run on github.com", !(await sticker(`${DOTCOM}/pulls`)), null);
  await sw.evaluate(() => refresh(true));
  check("reads that GitHub's data", (await stored()).authored?.me === "me", (await stored()).authored);

  console.log("\nSwitching to github.com");
  await page.fill("#host", "github.com");
  await page.click("#save");
  await page.waitForSelector("#status:text('Saved')");
  await page.waitForTimeout(500);
  const s = await stored();
  check("stores github.com's API address", s.apiBase === "https://api.github.com", s.apiBase);
  check("keeps the settings (token)", s.token === "keep-me", Object.keys(s));
  check("moves the page scripts to github.com", JSON.stringify(await registered()) === JSON.stringify([`${DOTCOM}/*`]), await registered());
  const onDotcom = await sticker(`${DOTCOM}/pulls`);
  const onAcme = await sticker(`${ACME}/pulls`);
  check("runs on github.com now, not on acme.ghe.com", onDotcom && !onAcme, { onDotcom, onAcme });
} finally {
  await ctx.close();
  server.close?.();
}
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${path.join(OUT, "host-*.png")}`);
process.exit(failed ? 1 : 0);
