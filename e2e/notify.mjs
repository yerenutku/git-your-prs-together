// Notifications and "your turn" marks, end to end, against a fake GitHub (e2e/fake-github.mjs).
// Loads this folder unpacked into a fresh Chromium profile (no sign-in needed), plays a story step by step
// (someone comments on my PR, someone replies to me, my PR becomes ready, a re-review is needed, I opt out…)
// and checks which desktop notifications the extension shows and what it draws on the PR pages.
// The story runs twice: with the data from GitHub's pages and the browser's sign-in ("session", no token),
// and signed out with a token ("token": the API fallback).
//
//   npm run e2e:notify
//   npm run e2e:notify -- session    # one source only
//   HEADED=1 npm run e2e:notify     # watch it
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { EXT, OUT, useHost } from "./config.mjs";
import { API, WEB, handle, serve } from "./fake-github.mjs";

const ago = (min) => new Date(Date.now() - min * 60_000).toISOString();
const ME = "me";
const MODES = process.argv.slice(2).length ? process.argv.slice(2) : ["session", "token"];
const results = [];
let failed = 0;
let mode = "";
function check(step, what, ok, detail) {
  results.push({ mode, step, what, ok: !!ok, ...(ok ? {} : { detail }) });
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}
fs.mkdirSync(OUT, { recursive: true });
for (mode of MODES) {
  console.log(`\n===== ${mode === "session" ? "Session: GitHub's page data, browser signed in, no token" : "Token: GitHub's page data unavailable, API with a token"} =====`);
  await story(mode);
}
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${path.join(OUT, "notify-*.png")}`);
fs.writeFileSync(path.join(OUT, "notify.json"), JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);

async function story(mode) {
let world = {
  pageData: mode === "session", // token run: signed in, but GitHub's page data can't be read, so the token takes over
  me: ME,
  // Before the extension is installed: an old comment (history) and one from 2 minutes ago (news).
  mine: [{ repo: "acme/app", number: 11, title: "Add login screen", headSha: "aaa1", checks: "PENDING", mergeState: "BLOCKED", comments: [{ author: "olga", at: ago(24 * 60) }, { author: "sa-snyk", at: ago(2) }], threads: [], reviews: [] }],
  theirs: [
    { repo: "acme/api", number: 21, title: "Rate limit the token endpoint", author: "bob", comments: [], threads: [{ comments: [{ author: ME, at: ago(50) }] }] },
    { repo: "acme/app", number: 22, title: "Update SKILL.md", author: "randy", unsearchable: true, comments: [{ author: "randy", at: ago(30) }], threads: [] },
    // Merged, with a reply I never read: only listed when My threads shows closed PRs too.
    { repo: "acme/api", number: 23, title: "Old merged change", author: "frank", state: "MERGED", comments: [{ author: ME, at: ago(45) }, { author: "frank", at: ago(40) }], threads: [] },
  ],
  reRequested: [],
  dismissed: [],
};
const mine = (n) => world.mine.find((p) => p.number === n);
const theirs = (n) => world.theirs.find((p) => p.number === n);

const server = await serve(() => world);
const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ghc-notify-"));
const shot = (name) => path.join(OUT, `notify-${mode}-${name}.png`);
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: process.env.HEADED !== "1",
  viewport: { width: 1280, height: 800 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});

// Pages (and the content scripts' own fetches) go to the fake GitHub too.
const routed = []; // URLs the pages (and their content scripts) asked for
await ctx.route(`${WEB}/**`, async (route) => {
  const r = route.request();
  routed.push(r.url());
  const out = handle(world, { url: r.url(), method: r.method(), body: r.postData(), headers: r.headers() });
  if (out.redirect) return route.fulfill({ status: 302, headers: { location: WEB + out.redirect } });
  await route.fulfill({
    status: out.status || 200,
    contentType: out.html != null ? "text/html" : "application/json",
    body: out.html != null ? out.html : JSON.stringify(out.json),
  });
});

try {
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const extId = new URL(sw.url()).host;

  // In the service worker: GitHub calls go to the fake server, notifications are recorded instead of shown,
  // no background polling (each step polls once, explicitly).
  await sw.evaluate(
    async ({ port, hosts, token }) => {
      const realFetch = self.fetch.bind(self);
      self.fetch = (input, init = {}) => {
        const url = typeof input === "string" ? input : input.url;
        if (hosts.some((h) => url.startsWith(h + "/"))) return realFetch(`http://127.0.0.1:${port}/${encodeURIComponent(url)}`, { ...init, credentials: "omit" });
        return realFetch(input, init);
      };
      self.__notes = [];
      const record = async (id, opts) => (self.__notes.push({ id, ...opts }), id);
      try {
        chrome.notifications.create = record;
      } catch {}
      if (chrome.notifications.create !== record) Object.defineProperty(chrome.notifications, "create", { value: record });
      await chrome.alarms.clearAll();
      if (token) await chrome.storage.local.set({ token });
    },
    { port: server.port, hosts: [WEB, API], token: mode === "token" ? "fake-token" : null }
  );
  await useHost(sw, WEB);

  // One poll of the extension; returns the notifications it showed: [{ title, message, context, url }]
  async function poll() {
    return sw.evaluate(async () => {
      self.__notes = [];
      await refresh(true);
      const { notifUrls = {} } = await chrome.storage.session.get("notifUrls");
      return self.__notes.map((n) => ({ title: n.title, message: n.message, context: n.contextMessage, url: notifUrls[n.id] }));
    });
  }
  async function step(name, change, expect) {
    console.log(`\n${name}`);
    change?.();
    const notes = await poll();
    expect(notes);
    return notes;
  }
  const one = (notes, title, extra = {}) => notes.length === 1 && notes[0].title.includes(title) && Object.entries(extra).every(([k, v]) => String(notes[0][k] || "").includes(v));
  const none = (notes) => notes.length === 0;
  const fits = (notes) => notes.every((x) => x.title.length <= 40 && /\n\S+#\d+$/.test(x.message)); // one line on macOS; PR in the body

  // Change the notification options the way a person does: on the options page, then Save.
  async function setOption(id, on) {
    const p = await ctx.newPage();
    await p.goto(`chrome-extension://${extId}/options.html`);
    await p.waitForFunction(() => document.getElementById("host").value !== "");
    await p.setChecked(`#${id}`, on);
    await p.click("#save");
    await p.waitForSelector("#status:text('Saved')");
    await p.close();
  }

  // ---- the story ----

  await step("1. First run after install", null, (n) =>
    check(1, "nothing old is replayed, but the comment from 2 minutes ago is news", one(n, "sa-snyk commented on your PR", { context: "acme/app#11" }), n)
  );

  await step(
    "2. Alice comments on my PR",
    () => mine(11).comments.push({ author: "alice", at: ago(1) }),
    (n) => check(2, "\"alice commented on your PR\", opens the comment", one(n, "alice commented on your PR", { context: "acme/app#11", url: "issuecomment-" }), n)
  );

  await step(
    "3. A bot comments on my PR",
    () => mine(11).comments.push({ author: "sonar[bot]", at: ago(0.5) }),
    (n) => check(3, "bots in the conversation don't notify", none(n), n)
  );

  await step(
    "4. Bob replies to my comment on his PR",
    () => theirs(21).threads[0].comments.push({ author: "bob", at: ago(0.5) }),
    (n) => check(4, "\"bob replied to you\", opens the reply", one(n, "bob replied to you", { context: "acme/api#21", url: "discussion_r" }), n)
  );

  // GitHub's commenter: search never returns #22. I open it in the browser and comment; then Randy answers.
  const opened = await ctx.newPage();
  await opened.goto(`${WEB}/acme/app/pull/22`);
  await opened.waitForTimeout(500);
  await opened.close();
  await step(
    "4b. I comment on Randy's PR, which GitHub's search doesn't find",
    () => theirs(22).comments.push({ author: ME, at: ago(0) }), // after I opened it
    (n) => check(4, "my own comment doesn't notify", none(n), n)
  );
  await step(
    "4c. Randy answers my comment",
    () => theirs(22).comments.push({ author: "randy", at: ago(0) }),
    (n) => {
      check(4, "\"randy replied to you\", although search doesn't list the PR", one(n, "randy replied", { context: "acme/app#22" }), n);
      check(4, "the title fits on one line and the body names the PR (\"Update SKILL.md\" + \"app#22\")", fits(n) && n[0]?.message === "Update SKILL.md\napp#22", n);
    }
  );
  const reread = await ctx.newPage(); // I read Randy's answer
  await reread.goto(`${WEB}/acme/app/pull/22`);
  await reread.waitForTimeout(500);
  await reread.close();

  await step(
    "5. My PR becomes ready to merge",
    () => Object.assign(mine(11), { checks: "SUCCESS", mergeState: "CLEAN", reviewDecision: "APPROVED" }),
    (n) => check(5, "\"Your PR is ready to merge\" (checks passed folded into it)", one(n, "ready to merge", { context: "acme/app#11" }), n)
  );

  await step("6. Nothing changes", null, (n) => check(6, "nothing is notified twice", none(n), n));

  await step(
    "7. Carol asks me to re-review",
    () => world.reRequested.push({ repo: "acme/web", number: 31, title: "New checkout flow", author: "carol", requestedAt: ago(0.5), requestedBy: "carol" }),
    (n) => check(7, "\"carol asks for your re-review\", opens Files changed", one(n, "carol asks for your re-review", { context: "acme/web#31", url: "/files" }), n)
  );

  await step(
    "8. A push dismisses my approval",
    () => world.dismissed.push({ repo: "acme/web", number: 41, title: "Bump SDK", author: "dave", approvedSha: "old1", headSha: "new1", approvedAt: ago(60), dismissedAt: ago(0.5) }),
    // Only the API knows which commit I approved; GitHub's page data doesn't, so the session opens Files changed.
    (n) => check(8, `"Your approval was dismissed", opens ${mode === "token" ? "the changes since my approval" : "Files changed"}`, one(n, "approval was dismissed", { context: "acme/web#41", url: mode === "token" ? "/files/old1..new1" : "/pull/41/files" }), n)
  );

  console.log("\n9. Opting out and in (options page)");
  await setOption("nThreads", false);
  await step(
    "9a. Bob replies again, threads switched off",
    () => theirs(21).threads[0].comments.push({ author: "bob", at: ago(0.2) }),
    (n) => check(9, "no notification while \"thread I'm following\" is off", none(n), n)
  );
  await setOption("nThreads", true);
  await step("9b. Switched back on", null, (n) => check(9, "turning it on doesn't replay the reply missed while off", none(n), n));
  await step(
    "9c. Bob replies once more",
    () => theirs(21).threads[0].comments.push({ author: "bob", at: ago(0.1) }),
    (n) => check(9, "notifies again once switched on", one(n, "bob replied"), n)
  );

  for (const [id, label, change] of [
    ["nAttention", "a comment on my PR", () => mine(11).comments.push({ author: "alice", at: ago(0.05) })],
    ["nReady", "a PR becoming ready (\"checks passed\" still comes, it's part of \"needs attention\")", () => world.mine.push({ repo: "acme/app", number: 12, title: "Fix typo", headSha: "bbb1", checks: "SUCCESS", mergeState: "CLEAN", reviewDecision: "APPROVED", comments: [], threads: [], reviews: [] })],
    ["nReReview", "a re-review request", () => world.reRequested.push({ repo: "acme/web", number: 32, title: "Refactor cart", author: "carol", requestedAt: ago(0.05) })],
  ]) {
    await setOption(id, false);
    const allowed = id === "nReady" ? (n) => n.every((x) => !/ready to merge/.test(x.title)) : none;
    await step(`9d. ${id} off: ${label}`, change, (n) => check(9, `no notification for ${label} while ${id} is off`, allowed(n), n));
    await setOption(id, true);
  }

  // ---- what stays on the page once the notification is gone ----
  console.log("\n10. On GitHub's PR pages, after the notifications are gone");
  mine(11).comments.push({ author: "erin", at: ago(0.02) }); // something new and unread on my PR
  theirs(21).threads[0].comments.push({ author: "bob", at: ago(0.02) }); // and a reply to me
  await poll();
  const page = await ctx.newPage();
  await page.goto(`${WEB}/pulls/authored`);
  const marks = async () => {
    await page.waitForTimeout(1500);
    return page.evaluate(() => {
      const t = (s) => document.querySelector(s)?.textContent.trim() || null;
      return {
        authoredCount: t(".ghc-au-count"),
        authoredHot: !!document.querySelector(".ghc-au-count.ghc-au-hot"),
        chip11: t("a[href$='/pull/11'] ~ .ghc-au-chip, li:has(a[href$='/pull/11']) .ghc-au-chip"),
        sideRow11: t(".ghc-au-row[href*='/pull/11'] .ghc-au-state, .ghc-au-row[href*='app/pull/11'] .ghc-au-state"),
        threadsCount: (() => {
          const c = document.querySelector("[data-ghc-threads='threads'] .ghc-threads-count");
          return c && !c.hidden ? c.textContent : null;
        })(),
        threadsOpen: document.querySelector("[data-ghc-threads='threads'] .ghc-threads-open:not([hidden])")?.textContent || null,
        reReviewCount: (() => {
          const c = document.querySelector("[data-ghc-threads='reapprove'] .ghc-threads-count");
          return c && !c.hidden ? c.textContent : null;
        })(),
      };
    });
  };
  let m = await marks();
  await page.screenshot({ path: shot("1-unread") });
  check(10, "my PR #11 shows its unread comments in the list (it's also ready: \"Ready to merge · N new\")", /\d+ new/.test(m.chip11 || ""), m);
  check(10, "the Authored count is red (something waits for me)", m.authoredHot, m);
  check(10, "\"My threads\" shows 1 PR with new replies", m.threadsCount === "1", m);
  check(10, "\"My threads\" counts the open PRs I take part in (2: bob's and Randy's, not the merged one)", m.threadsOpen === "2", m);
  check(10, "\"Re-review\" shows 1 PR to approve again", m.reReviewCount === "1", m);
  const sticker = await page.evaluate(() => {
    const t = document.querySelector("header a .gypt-sticker");
    return t && { text: t.textContent, tilt: getComputedStyle(t).transform !== "none", clicksThrough: getComputedStyle(t).pointerEvents === "none" };
  });
  check(10, "the tilted \"Git Your PRs Together\" sticker sits on GitHub's logo, and the logo stays clickable", sticker?.text === "Git Your PRs Together" && sticker.tilt && sticker.clicksThrough, sticker);

  // The "new comments" marks pulse a few times, then stay still, also after a reload.
  const anims = () =>
    page.evaluate(() =>
      // (#11 is also ready to merge: its chip is green "Ready to merge · N new", which never blinks)
      [".ghc-au-count.ghc-au-hot", ".ghc-au-row-hot", ".ghc-au-row-hot .ghc-au-chip"].map((q) => {
        const e = document.querySelector(q);
        return e ? `${q}:${getComputedStyle(e).animationName}` : `${q}:missing`;
      })
    );
  const a0 = await anims();
  check(10, "the new-comment marks (count, row) pulse when the comment is new", a0.slice(0, 2).every((x) => !/:none$|missing/.test(x)), a0);
  await page.waitForTimeout(5000);
  const a1 = await anims();
  check(10, "…and are still after the pulses (about 4 s)", a1.every((x) => !/ghc-au-(badge|row|blink)$/.test(x)), a1);
  await page.reload();
  await page.waitForTimeout(1500);
  const a2 = await anims();
  check(10, "…and stay still on the next page load", a2.every((x) => !/ghc-au-(badge|row|blink)$/.test(x)), a2);

  await page.click("[data-ghc-threads='threads'] a, [data-ghc-threads='threads']");
  await page.waitForSelector("#ghc-threads-panel .ghc-tp-row");
  const panelText = await page.locator("#ghc-threads-panel").innerText();
  await page.screenshot({ path: shot("2-my-threads") });
  check(10, "the My threads panel lists bob's PR with a new reply", /Rate limit the token endpoint/.test(panelText) && /new repl/.test(panelText), panelText);
  check(10, "My threads shows open PRs only by default (the merged one is hidden)", !/Old merged change/.test(panelText), panelText);
  await page.click("#ghc-threads-panel .ghc-tp-open-only");
  const allText = await page.locator("#ghc-threads-panel").innerText();
  const allCount = await page.locator("[data-ghc-threads='threads'] .ghc-threads-count").innerText();
  await page.screenshot({ path: shot("2b-my-threads-all") });
  check(10, "\"Show closed too\" lists the merged PR, and the tab counts its unread reply", /Old merged change/.test(allText) && /Merged/.test(allText) && allCount === "2", { allText, allCount });
  await page.click("#ghc-threads-panel .ghc-tp-open-only");
  check(10, "\"Open only\" hides it again", !/Old merged change/.test(await page.locator("#ghc-threads-panel").innerText()), null);
  await page.keyboard.press("Escape");

  // Opening a PR = I've looked: its marks go away.
  await page.goto(`${WEB}/acme/app/pull/11`);
  await page.goto(`${WEB}/acme/api/pull/21`);
  await page.waitForTimeout(500);
  await page.goto(`${WEB}/pulls/authored`);
  m = await marks();
  await page.screenshot({ path: shot("3-after-opening") });
  check(10, "after opening #11, nothing on it is new any more", m.chip11 && !/new/.test(m.chip11) && !m.authoredHot, m);
  check(10, "after opening #21, My threads has nothing new", m.threadsCount === null, m);

  // ---- Firefox containers: GitHub signed in only inside a container (Zen space), the background's requests aren't ----
  if (mode === "session") {
    console.log("\n10b. Signed in only in the GitHub tab (a Firefox container): the data comes through the tab");
    world.signedInInTabsOnly = true;
    await sw.evaluate(() => (self.__testTabRelay = true)); // the Firefox path, in Chromium
    await page.goto(`${WEB}/pulls/authored`);
    await page.waitForTimeout(500);
    routed.length = 0;
    await poll();
    let st = await sw.evaluate(() => chrome.storage.local.get(["authored", "myThreads"]));
    check("10b", "my PRs and threads still load, without an error", st.authored?.me === ME && !st.authored?.error && st.myThreads?.me === ME && st.authored.items.some((i) => i.number === 11), { me: st.authored?.me, error: st.authored?.error });
    check("10b", "…read through the open tab", routed.some((u) => u.includes("/pulls?q=")) && routed.some((u) => u.includes("/page_data/")), routed.slice(0, 5));

    console.log("\n10b2. …also through a tab without this version's page scripts (opened before an update)");
    await sw.evaluate(() => chrome.scripting.unregisterContentScripts({ ids: ["pages"] }));
    await page.goto(`${WEB}/pulls/authored`);
    await page.waitForTimeout(500);
    const bare = await page.evaluate(() => !document.querySelector("[data-ghc-threads], #ghc-bar"));
    await sw.evaluate(() => chrome.storage.local.remove("authored"));
    routed.length = 0;
    await poll();
    st = await sw.evaluate(() => chrome.storage.local.get("authored"));
    check("10b2", "the tab has none of the extension's page scripts, and the data still loads through it", bare && st.authored?.me === ME && !st.authored?.error && routed.some((u) => u.includes("/pulls?q=")), { bare, me: st.authored?.me, error: st.authored?.error });
    await sw.evaluate(() => syncPageScripts());

    console.log("\n10c. …and no GitHub tab open: say how to fix it");
    await page.goto("about:blank");
    await poll();
    st = await sw.evaluate(() => chrome.storage.local.get("authored"));
    check("10c", "the error says to keep a GitHub tab open", /keep a GitHub tab open/.test(st.authored?.error || ""), st.authored?.error);
    check("10c", "the PRs from before stay listed", st.authored?.items?.some((i) => i.number === 11), st.authored?.items?.length);

    world.signedInInTabsOnly = false;
    await sw.evaluate(() => (self.__testTabRelay = false));
    await poll();
  }

  // ---- when the data can't be read, say so (instead of quietly showing nothing) ----
  if (mode === "session") {
    console.log("\n11. The organization's single sign-on expires");
    world.ssoExpired = true;
    await poll();
    await page.goto(`${WEB}/pulls/authored`);
    await page.waitForTimeout(1000);
    let bar = await page.locator("#ghc-bar").innerText().catch(() => "");
    await page.screenshot({ path: shot("4-sso-expired") });
    check(11, "the bar says single sign-on expired", /single sign-on expired/i.test(bar), bar);
    check(11, "and names the organization", /for Acme:/.test(bar), bar);

    console.log("\n11b. Signing in again clears it on the next page load (no waiting for the poll)");
    world.ssoExpired = false;
    await page.goto(`${WEB}/pulls/authored`);
    await page.waitForFunction(() => !/single sign-on/i.test(document.querySelector("#ghc-bar")?.innerText || ""), null, { timeout: 5000 }).catch(() => {});
    bar = await page.locator("#ghc-bar").innerText().catch(() => "");
    check("11b", "the error is gone", !/single sign-on/i.test(bar), bar);

    console.log("\n12. Signed out of GitHub, no token");
    world.ssoExpired = false;
    world.signedIn = false;
    await poll();
    await page.goto(`${WEB}/pulls/authored`); // lands on the sign-in page, where the bar says why
    await page.waitForTimeout(1000);
    bar = await page.locator("#ghc-bar").innerText().catch(() => "");
    check(12, "the bar says not signed in", /not signed in/i.test(bar), bar);
    world.signedIn = true;
  }
} finally {
  await ctx.close();
  server.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
}
