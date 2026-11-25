// Builds the store uploads from this folder:
//   dist/chrome/  + dist/chrome-<version>.zip    Chrome Web Store and Edge Add-ons (manifest.json as is)
//   dist/firefox/ + dist/firefox-<version>.zip   addons.mozilla.org (background page instead of a service worker, gecko settings)
//
//   npm run package
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const DIST = path.join(ROOT, "dist");
// What the extension needs at runtime; nothing else ships (no tests, docs, node_modules or the icon artwork).
const FILES = ["background.js", "host.js", "session-source.js", "options.html", "options.js", "content", "icons/icon16.png", "icons/icon32.png", "icons/icon48.png", "icons/icon128.png"];
// The add-on's ID on addons.mozilla.org. It can never change once the add-on is published there.
const GECKO_ID = "git-your-prs-together@extension";

const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, "manifest.json"), "utf8"));
const swImports = fs.readFileSync(path.join(ROOT, "background.js"), "utf8").match(/importScripts\(([^)]*)\)/)?.[1];
const backgroundScripts = [...(swImports || "").matchAll(/"([^"]+)"/g)].map((m) => m[1]).concat("background.js");

// The manifest's `key` only pins the ID of the unpacked development copy; the stores assign their own IDs and
// refuse a package that has one.
const { key: _devKey, ...storeManifest } = manifest;

const variants = {
  chrome: storeManifest,
  firefox: {
    ...storeManifest,
    // Firefox runs the background as an event page: the files importScripts loads in Chrome come first.
    background: { scripts: backgroundScripts },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: "140.0",
        data_collection_permissions: { required: ["none"] }, // nothing leaves the browser except to GitHub (PRIVACY.md)
      },
      // Firefox for Android only reads data_collection_permissions from 142 on.
      gecko_android: { strict_min_version: "142.0" },
    },
  },
};

fs.rmSync(DIST, { recursive: true, force: true });
for (const [name, m] of Object.entries(variants)) {
  const dir = path.join(DIST, name);
  for (const f of FILES) fs.cpSync(path.join(ROOT, f), path.join(dir, f), { recursive: true });
  fs.writeFileSync(path.join(dir, "manifest.json"), JSON.stringify(m, null, 2) + "\n");
  for (const f of fs.readdirSync(dir, { recursive: true })) if (path.basename(f) === ".DS_Store") fs.rmSync(path.join(dir, f));
  const zip = path.join(DIST, `${name}-${manifest.version}.zip`);
  execFileSync("zip", ["-r", "-X", "-q", zip, "."], { cwd: dir });
  console.log(`${path.relative(ROOT, zip)}  (${(fs.statSync(zip).size / 1024).toFixed(0)} KB)`);
}
