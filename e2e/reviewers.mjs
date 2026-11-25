// The reviewers picker: contributors first (searchable), "Show all users from the company" last, and picking someone
// requests them through GitHub's own picker. Runs against a fake picker that behaves like GitHub's (e2e/fake-github.mjs).
//
//   npm run e2e:reviewers
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { chromium } from "playwright";
import { EXT, OUT, useHost } from "./config.mjs";
import { WEB, handle } from "./fake-github.mjs";

const contributors = [
  { login: "Marco-Diaz", commits: 900, avatar: "data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==" },
  { login: "Erin-Walsh", commits: 700, avatar: `${WEB}/avatars/u/expired?s=60&token=old` }, // an expired link: GitHub answers with a page, not an image
  { login: "Randy-Lee", commits: 300 },
  { login: "me", commits: 200 },
  { login: "Gone-User", commits: 5 }, // left the company: GitHub won't offer them
];
const company = ["Aaron-Kemp", "Abby-King", "Adam-Lowe", "Ahmed-Ali", "Akira-Sato", "Alex-Reed", "Amanda-Ross", "Ana-Silva", "Andrea-Bell", "Arne-Holm", "Ben-Carter",
  "Erin-Walsh", "Marco-Diaz", "Randy-Lee", "Randall-Moss", "Zoe-Novak"];
const world = { me: "me", mine: [], theirs: [], picker: { company, requested: ["Acme/mobile-platform"] }, contributors: { "acme/app": contributors } };

const results = [];
let failed = 0;
function check(what, ok, detail) {
  results.push({ what, ok: !!ok, ...(ok ? {} : { detail }) });
  if (!ok) failed++;
  console.log(`${ok ? "  ✓" : "  ✗"} ${what}${ok ? "" : `\n      ${JSON.stringify(detail)}`}`);
}

const profile = fs.mkdtempSync(path.join(os.tmpdir(), "ghc-reviewers-"));
fs.mkdirSync(OUT, { recursive: true });
const ctx = await chromium.launchPersistentContext(profile, {
  channel: "chromium",
  headless: process.env.HEADED !== "1",
  viewport: { width: 1100, height: 760 },
  args: [`--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
await ctx.route(`${WEB}/**`, async (route) => {
  const r = route.request();
  const out = handle(world, { url: r.url(), method: r.method(), body: r.postData(), headers: r.headers() });
  await route.fulfill({ status: out.status || 200, contentType: out.html != null ? "text/html" : "application/json", body: out.html != null ? out.html : JSON.stringify(out.json) });
});

try {
  await useHost(ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 })), WEB);
  const page = await ctx.newPage();
  if (process.env.DEBUG) page.on("console", (m) => /ghc-debug/.test(m.text()) && console.log("   ", m.text().slice(0, 200)));
  await page.goto(`${WEB}/acme/app/pull/50`);
  const open = async () => {
    await page.click("#rv-open");
    await page.waitForSelector(".ghc-rv-item", { timeout: 10000 });
  };
  const idle = () => page.waitForFunction(() => !document.querySelector(".ghc-rv-busy"), null, { timeout: 10000 });
  const state = () =>
    page.evaluate(() => ({
      open: !!document.querySelector("[role='dialog']"),
      ours: [...document.querySelectorAll(".ghc-rv-item")].map((b) => `${b.dataset.login}${b.getAttribute("aria-pressed") === "true" ? "*" : ""}`),
      githubListVisible: !!document.querySelector("[role='dialog'] ul[role='listbox']")?.offsetParent,
      githubSearchVisible: !!document.querySelector("input[aria-label='Filter reviewers']")?.offsetParent,
      githubSearch: document.querySelector("input[aria-label='Filter reviewers']")?.value,
      githubList: [...document.querySelectorAll("[role='dialog'] li[role='option']")].map((o) => o.dataset.id),
      last: document.querySelector(".ghc-rv > :last-child")?.textContent,
      note: document.querySelector(".ghc-rv-warn")?.textContent || null,
      requests: window.__requests,
    }));
  const saved = async () => (await state()).requests;

  console.log("\nOpening the picker");
  await open();
  let s = await state();
  await page.screenshot({ path: path.join(OUT, "reviewers-1-contributors.png") });
  check("lists the requested team, then the contributors by commits (not me, not the whole company)", JSON.stringify(s.ours) === JSON.stringify(["Acme/mobile-platform*", "Marco-Diaz", "Erin-Walsh", "Randy-Lee", "Gone-User"]), s);
  check("GitHub's own list and search box are hidden; ours is shown", !s.githubListVisible && !s.githubSearchVisible, s);
  check("the last item is \"Show all users from the company\"", s.last === "Show all users from the company", s);
  const avatars = await page.evaluate(async () => {
    await new Promise((ok) => setTimeout(ok, 800));
    return Object.fromEntries([...document.querySelectorAll(".ghc-rv-item")].map((b) => [b.dataset.login, b.querySelector("img") ? getComputedStyle(b.querySelector("img")).visibility : null]));
  });
  check("an avatar that loads is shown; an expired one is hidden, not a broken-image icon; no link, no image", avatars["Marco-Diaz"] === "visible" && avatars["Erin-Walsh"] === "hidden" && avatars["Randy-Lee"] === null, avatars);

  console.log("\nThe assignees picker (same contributors, no token)");
  const assignees = () => page.evaluate(() => [...document.querySelectorAll("#assignees li")].filter((li) => li.style.display !== "none").map((li) => li.textContent));
  await page.waitForFunction(() => [...document.querySelectorAll("#assignees li")].some((li) => li.style.display === "none"), null, { timeout: 10000 });
  check("assignees show only the repo's contributors, plus who is already assigned", JSON.stringify(await assignees()) === JSON.stringify(["Erin-Walsh", "Marco-Diaz", "Randy-Lee", "Zoe-Novak"]), await assignees());

  console.log("\nSearching and picking");
  await page.fill(".ghc-rv-search", "ran");
  s = await state();
  await page.screenshot({ path: path.join(OUT, "reviewers-2-search.png") });
  check("\"ran\" finds only the contributor Randy-Lee (not Randall-Moss, who isn't a contributor)", JSON.stringify(s.ours) === JSON.stringify(["Randy-Lee"]), s);
  check("GitHub's own search stays empty while searching ours", s.githubSearch === "", s);
  await page.click(".ghc-rv-item[data-login='Randy-Lee']");
  await idle();
  s = await state();
  check("clicking Randy-Lee ticks them; GitHub's search is empty again", s.ours.includes("Randy-Lee*") && s.githubSearch === "", s);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[role='dialog']"));
  check("closing saves exactly that: Randy-Lee requested, the team kept", JSON.stringify(await saved()) === JSON.stringify([["request", "Randy-Lee"]]), await saved());

  await open();
  s = await state();
  check("reopening shows Randy-Lee and the team ticked", s.ours.includes("Randy-Lee*") && s.ours.includes("Acme/mobile-platform*"), s);
  await page.click(".ghc-rv-item[data-login='Randy-Lee']");
  await idle();
  await page.fill(".ghc-rv-search", "erin");
  await page.press(".ghc-rv-search", "Enter");
  await idle();
  await page.mouse.click(1000, 700); // close by clicking outside
  await page.waitForFunction(() => !document.querySelector("[role='dialog']"));
  check("untick Randy-Lee, Enter on \"erin\", click outside: Randy removed, Erin requested, the team kept", JSON.stringify((await saved()).slice(1)) === JSON.stringify([["remove", "Randy-Lee"], ["request", "Erin-Walsh"]]), await saved());

  await open();
  await page.fill(".ghc-rv-search", "gone");
  await page.click(".ghc-rv-item[data-login='Gone-User']");
  await idle();
  s = await state();
  check("a contributor GitHub doesn't offer gets a clear message", /doesn't offer Gone-User/.test(s.note || ""), s);

  console.log("\nEveryone (GitHub's own list)");
  await page.click(".ghc-rv-all");
  await page.waitForTimeout(400);
  s = await state();
  await page.screenshot({ path: path.join(OUT, "reviewers-3-all.png") });
  check("\"Show all users from the company\" shows GitHub's own list and search box", s.githubListVisible && s.githubSearchVisible && s.githubList.includes("Aaron-Kemp") && s.ours.length === 0, s);
  const before = (await saved()).length;
  await page.fill("input[aria-label='Filter reviewers']", "zo");
  await page.waitForTimeout(400);
  await page.keyboard.press("Escape");
  await page.waitForFunction(() => !document.querySelector("[role='dialog']"), null, { timeout: 10000 });
  check("closing with a search in GitHub's box no longer drops the reviewers it hides (what removed 4 reviewers on a real PR)", (await saved()).length === before, (await saved()).slice(before));

  await open();
  await page.click(".ghc-rv-all");
  await page.click(".ghc-rv-mode:not(.ghc-rv-all)");
  await page.waitForSelector(".ghc-rv-item");
  s = await state();
  check("\"← Only contributors\" goes back", !s.githubListVisible && s.ours.includes("Marco-Diaz"), s);
  await page.keyboard.press("Escape");
  check("nothing else was saved along the way", (await saved()).length === before, (await saved()).slice(before));
  check("the contributors were fetched once (GitHub's \"still computing\" answer retried)", world.contributorCalls === 2, world.contributorCalls);

  console.log("\nThe cached list");
  const sw = ctx.serviceWorkers()[0] || (await ctx.waitForEvent("serviceworker", { timeout: 15000 }));
  const seed = (ageMin) => sw.evaluate(([age]) => chrome.storage.local.set({ "contribWeb:acme/app": { at: Date.now() - age * 60e3, list: [{ login: "Stale-Person", commits: 1, avatar: null }] } }), [ageMin]);
  const reopen = async () => {
    await page.goto(`${WEB}/acme/app/pull/50`);
    await open();
    return state();
  };
  await seed(60);
  s = await reopen();
  check("a list older than 10 minutes is fetched again (its avatar links expire)", world.contributorCalls === 3 && !s.ours.includes("Stale-Person") && s.ours.includes("Marco-Diaz"), { calls: world.contributorCalls, ours: s.ours });
  await page.keyboard.press("Escape");
  await seed(3);
  s = await reopen();
  check("a list a few minutes old is reused, no new request", world.contributorCalls === 3 && s.ours.includes("Stale-Person"), { calls: world.contributorCalls, ours: s.ours });
  await page.keyboard.press("Escape");
  await seed(60);
  world.contributors = {}; // GitHub can't give the list now (404)
  s = await reopen();
  check("if GitHub can't be read, the old list is better than none", s.ours.includes("Stale-Person"), s.ours);
} finally {
  await ctx.close();
  fs.rmSync(profile, { recursive: true, force: true });
}
console.log(`\n${results.length - failed}/${results.length} checks passed. Screenshots: ${path.join(OUT, "reviewers-*.png")}`);
process.exit(failed ? 1 : 0);
