import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const EXT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
// The real GitHub the signed-in scripts (check, login, reload, probe-sw) open: GHC_HOST, else "host" in
// e2e/local.json (not committed: your own GitHub), else github.com. The fake-GitHub tests don't use it.
const local = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(EXT_DIR, "e2e", "local.json"), "utf8"));
  } catch {
    return {};
  }
})();
export const HOST = (process.env.GHC_HOST || local.host || "https://github.com").replace(/\/$/, "");
// The extension under test: this folder, loaded unpacked (the same files Arc loads).
export const EXT = EXT_DIR;
// Test browser profile, kept outside the extension folder (it holds the GitHub sign-in).
export const PROFILE = process.env.GHC_E2E_PROFILE || local.profile || path.join(os.homedir(), ".git-your-prs-together-e2e", "profile");
export const OUT = path.join(EXT, "e2e", "out");
// The manifest pins a public `key`, so the extension ID is fixed (sha256 of the DER key, first 32 hex digits mapped to
// a–p) and does not depend on the folder path.
const KEY = Buffer.from(JSON.parse(fs.readFileSync(path.join(EXT, "manifest.json"), "utf8")).key, "base64");
export const EXT_ID = [...crypto.createHash("sha256").update(KEY).digest("hex").slice(0, 32)].map((c) => String.fromCharCode(97 + parseInt(c, 16))).join("");

// Chrome keeps the extension's background worker in the profile's Service Worker cache and can go on running that
// old copy after background.js changed (the content scripts do load fresh). Clear it before every run.
export function freshWorker() {
  fs.rmSync(path.join(PROFILE, "Default", "Service Worker"), { recursive: true, force: true });
}

// Point the extension at a GitHub, the way the options page does, and wait until its page scripts are registered
// there (before any page opens). `web` is like "https://acme.ghe.com".
export async function useHost(sw, web) {
  await sw.evaluate(async (web) => {
    await chrome.storage.local.set({ apiBase: GHHost.parse(web).api });
    await syncPageScripts();
  }, web);
}
