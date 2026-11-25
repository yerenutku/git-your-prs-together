// Scratch: run JS in the extension's service worker, with the signed-in test profile. node e2e/probe-sw.mjs <file-with-js>
import fs from "node:fs";
import { chromium } from "playwright";
import { EXT, HOST, PROFILE, freshWorker, useHost } from "./config.mjs";
freshWorker();
const ctx = await chromium.launchPersistentContext(PROFILE, {
  channel: "chromium", headless: true,
  ignoreDefaultArgs: ["--use-mock-keychain", "--password-store=basic"],
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  await useHost(sw, HOST);
  console.log(JSON.stringify(await sw.evaluate(fs.readFileSync(process.argv[2], "utf8")), null, 1));
} finally { await ctx.close(); }
