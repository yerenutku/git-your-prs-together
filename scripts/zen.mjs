// Runs the Firefox build in Zen (or another Firefox-based browser) with its own profile that keeps your sign-in, and
// reloads the extension whenever dist/firefox changes (npm run package, and every git push via .githooks/pre-push).
//
//   npm run zen                       Zen from /Applications
//   FIREFOX=/path/to/firefox npm run zen
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const browser = process.env.FIREFOX || "/Applications/Zen.app/Contents/MacOS/zen";
const profile = path.join(os.homedir(), ".git-your-prs-together-zen");
if (!fs.existsSync(browser)) {
  console.error(`No browser at ${browser}. Set FIREFOX to a Firefox-based browser's binary.`);
  process.exit(1);
}
if (!fs.existsSync(path.join(ROOT, "dist/firefox/manifest.json"))) {
  console.error("No dist/firefox yet: run npm run package first.");
  process.exit(1);
}
const args = ["--yes", "web-ext@10.8.0", "run", "--source-dir", "dist/firefox", "--firefox", browser, "--firefox-profile", profile, "--keep-profile-changes", "--profile-create-if-missing"];
spawn("npx", args, { cwd: ROOT, stdio: "inherit" }).on("exit", (code) => process.exit(code ?? 0));
