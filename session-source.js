// PR data from GitHub's own pages, read with the browser's sign-in: no token needed, and it sees every PR you can
// see in the browser (the token often can't: SSO, org policies). Loaded by background.js.
//
// GitHub's PR pages fetch their data as JSON (the same requests the page makes):
//   /pulls?q=<search>                         a PR list (repo, number, title, headSha, updatedAt, isDraft, state)
//   <pr>/page_data/conversation_comments      conversation comments and review summaries (state, dismissedState)
//   <pr>/page_data/threads                    review threads with their comments, resolved or not
//   <pr>/page_data/review_requests            pending review requests (with when) and completed reviews (with commit)
//   <pr>/page_data/merge_box                  GitHub's merge verdict (mergeStateStatus) and latest verdicts
//   <pr>/page_data/status_checks              the checks rollup
// They're turned into the same shape the GraphQL API gives, so the summaries in background.js work on both.

const WEB_HEADERS = { Accept: "application/json", "GitHub-Verified-Fetch": "true", "X-Requested-With": "XMLHttpRequest" };
const webBase = (settings) => "https://" + new URL(settings.apiBase).hostname.replace(/^api\./, "");

class SignedOut extends Error {}
const signedOutUrl = (res) => /^\/(login|session|enterprises\/[^/]+\/sso)\b/.test(new URL(res.url).pathname);

async function web(path, settings) {
  const res = await fetch(webBase(settings) + path, { headers: WEB_HEADERS, credentials: "include" });
  if (signedOutUrl(res)) throw new SignedOut("not signed in to GitHub in this browser");
  if (!res.ok) throw new Error(`${res.status} ${path}`);
  return res.json();
}

// Who is signed in, and whether the org's single sign-on still lets us see its PRs (if not, lists come back empty
// without an error, so this is checked on the page itself).
async function webWhoAmI(settings) {
  const res = await fetch(webBase(settings) + "/pulls/authored", { credentials: "include" });
  if (signedOutUrl(res)) throw new SignedOut("not signed in to GitHub in this browser");
  const html = await res.text();
  const me = html.match(/<meta name="user-login" content="([^"]+)"/)?.[1];
  if (!me) throw new SignedOut("not signed in to GitHub in this browser");
  // "Single sign-on to see results in the <b>A</b> and <b>B</b> organizations": name them, so a sign-in to only one
  // of them shows which one is still missing.
  const sso = html.match(/Single sign-on to see results(?: in the ([\s\S]{1,300}?) organizations?)?/i);
  if (sso) {
    const orgs = (sso[1] || "").replace(/<[^>]*>/g, "").replace(/\s+/g, " ").trim();
    throw new SignedOut(`single sign-on expired${orgs ? ` for ${orgs}` : ""}: open GitHub in the browser and sign in`);
  }
  return me;
}

async function webList(q, settings) {
  const j = await web(`/pulls?q=${encodeURIComponent(q)}`, settings);
  return (j.payload?.pullsDashboardSurfaceContentRoute?.results || []).filter((x) => x.itemType === "pull_request" && x.repoNameWithOwner);
}

// Per-PR page data. Comments, threads and reviews only change when the PR's updatedAt does: cached on it.
// The merge verdict and checks can change without that (base branch moved, a check finished): always fetched.
const webCache = new Map(); // `${pr}|${part}` -> { updatedAt, data }
const PARTS = {
  convo: { path: "/page_data/conversation_comments?direction=desc", cached: true },
  threads: { path: "/page_data/threads", cached: true },
  requests: { path: "/page_data/review_requests", cached: true },
  merge: { path: "/page_data/merge_box?merge_method=SQUASH&bypass_requirements=false", cached: false },
  mergeCached: { path: "/page_data/merge_box?merge_method=SQUASH&bypass_requirements=false", cached: true }, // just for open/merged/closed
  checks: { path: "/page_data/status_checks", cached: false },
};
async function prPart(x, part, settings) {
  const pr = new URL(x.permalink).pathname;
  const id = `${pr}|${part}`;
  const hit = webCache.get(id);
  if (PARTS[part].cached && hit && hit.updatedAt === x.updatedAt) return hit.data;
  const data = await web(pr + PARTS[part].path, settings);
  webCache.set(id, { updatedAt: x.updatedAt, data });
  return data;
}
async function prParts(x, parts, settings) {
  const vals = await Promise.all(parts.map((p) => prPart(x, p, settings)));
  return Object.fromEntries(parts.map((p, k) => [p, vals[k]]));
}

const webUser = (a) => ({ login: a?.login || a?.displayLogin || "ghost", __typename: !a || a.userType === "human" ? "User" : "Bot" });
const webComment = (c) => ({ createdAt: c.createdAt, url: c.url, bodyText: c.body || "", author: webUser(c.author) });
const webThreads = (d) =>
  (d.threads?.threads || []).map((t) => {
    const cs = (t.commentsData?.comments || []).map(webComment);
    return { isResolved: !!t.isResolved, isOutdated: false, path: null, comments: { nodes: cs.slice(-20) }, head: { nodes: cs.slice(0, 1) }, tail: { nodes: cs.slice(-20) } };
  });
const convoItems = (d) => d.convo?.items || [];
const webReviews = (d) =>
  convoItems(d)
    .filter((i) => i.type === "review_summary")
    .map((i) => ({ id: i.relayId || String(i.id), state: i.state, submittedAt: i.createdAt, bodyText: i.body || "", url: i.url, author: webUser(i.author), dismissedState: i.dismissedState }));

// One of my PRs, shaped like AUTHORED_QUERY's node.
function webAuthoredNode(x, d) {
  const mb = d.merge?.pullRequest || {};
  const mss = mb.mergeStateStatus || null;
  const rollup = d.checks?.statusRollup?.combinedState || null;
  return {
    number: x.number,
    title: x.title,
    url: x.permalink,
    isDraft: !!x.isDraft,
    updatedAt: x.updatedAt,
    headRefOid: mb.headRefOid || x.headSha,
    mergeable: mss === "DIRTY" ? "CONFLICTING" : mss && mss !== "UNKNOWN" ? "MERGEABLE" : "UNKNOWN",
    mergeStateStatus: mss,
    reviewDecision: null, // derived from the verdicts below; GitHub's merge verdict decides "ready"
    repository: { nameWithOwner: x.repoNameWithOwner },
    commits: { nodes: [{ commit: { statusCheckRollup: rollup ? { state: rollup } : null } }] },
    reviewRequests: { totalCount: (mb.pendingReviewRequests || d.requests?.pendingReviewRequests || []).length },
    latestOpinionatedReviews: { nodes: (mb.latestOpinionatedReviews || []).map((r) => ({ state: r.state, author: { login: r.author?.login } })) },
    reviews: { nodes: webReviews(d) },
    comments: { nodes: convoItems(d).filter((i) => i.type === "issue").map(webComment) },
    reviewThreads: { nodes: webThreads(d) },
  };
}

// Someone else's PR I take part in, shaped like DASHBOARD_QUERY's node. A review's text counts as a message too.
function webTheirNode(x, d) {
  return {
    number: x.number,
    title: x.title,
    url: x.permalink,
    state: x.state,
    isDraft: !!x.isDraft,
    updatedAt: x.updatedAt,
    author: { login: x.author?.displayLogin || "ghost" },
    repository: { nameWithOwner: x.repoNameWithOwner },
    comments: { nodes: convoItems(d).filter((i) => i.type === "issue" || (i.type === "review_summary" && i.body?.trim())).map(webComment) },
    reviewThreads: { nodes: webThreads(d) },
  };
}

const keyOf = (x) => `${x.repoNameWithOwner}#${x.number}`;

// GitHub's search misses some PRs for "commenter:" (seen on a GHE.com tenant: a PR with comments from three people,
// found by none of their commenter: searches an hour later). So PRs opened in this browser (threadSeen) are checked
// directly too: the PR page's JSON says when it last changed and, in its title, what it is and who wrote it.
// Checked every poll: PRs opened in the last 2 hours and PRs I'm known to take part in; the rest in turns, at most
// FOLLOW_BATCH per poll, each at most every FOLLOW_EVERY_MS.
const FOLLOW_RECENT_MS = 2 * 3600e3;
const FOLLOW_EVERY_MS = 15 * 60e3;
const FOLLOW_BATCH = 5;
async function seenPrs(settings, me, known) {
  const { threadSeen = {}, followCache = {} } = await chrome.storage.local.get(["threadSeen", "followCache"]);
  const now = Date.now();
  const cands = Object.entries(threadSeen)
    .filter(([k, at]) => now - at < 21 * 864e5 && !known.has(k.toLowerCase()))
    .map(([k, at]) => ({ k, at, c: followCache[k] }))
    .filter(({ c }) => !c?.authoredByMe);
  const due = cands.filter(({ at, c }) => !c || c.mine || now - at < FOLLOW_RECENT_MS);
  const rest = cands
    .filter((x) => !due.includes(x) && now - (x.c?.checkedAt || 0) > FOLLOW_EVERY_MS)
    .sort((a, b) => (a.c?.checkedAt || 0) - (b.c?.checkedAt || 0))
    .slice(0, FOLLOW_BATCH);
  const out = [];
  await settle([...due, ...rest], async ({ k }) => {
    const [, repo, num] = k.match(/^(.+)#(\d+)$/) || [];
    if (!repo) return;
    const ov = await web(`/${repo}/pull/${num}`, settings);
    const t = ov.meta?.title?.match(/^(.*) by (\S+) · Pull Request #\d+ · /);
    const author = t?.[2] || "ghost";
    const prev = followCache[k];
    if (author === me) return (followCache[k] = { checkedAt: now, authoredByMe: true });
    const x = {
      repoNameWithOwner: repo,
      number: Number(num),
      title: t?.[1] || k,
      permalink: `${webBase(settings)}/${repo}/pull/${num}`,
      updatedAt: ov.payload?.pullRequestsOverviewIndexRoute?.lastActivityTimestamp || prev?.updatedAt || "",
      author: { displayLogin: author },
    };
    const d = await prParts(x, ["convo", "threads", "mergeCached"], settings);
    x.state = d.mergeCached?.pullRequest?.state || "OPEN";
    x.isDraft = !!d.mergeCached?.pullRequest?.isDraft;
    const item = summarizePr(webTheirNode(x, d), me);
    followCache[k] = { checkedAt: now, mine: !!item, updatedAt: x.updatedAt };
    if (item) out.push(item);
  });
  for (const k of Object.keys(followCache)) if (!threadSeen[k]) delete followCache[k];
  await chrome.storage.local.set({ followCache });
  return out;
}
const settle = async (xs, f) => (await Promise.allSettled(xs.map(f))).flatMap((r) => (r.status === "fulfilled" && r.value ? [r.value] : []));

// Everything the extension shows, from the browser's session. Stores the same keys as the token refreshes.
// Throws SignedOut when the browser isn't signed in (the caller then falls back to the token).
async function refreshFromSession(settings) {
  const me = await webWhoAmI(settings);
  const since = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
  const [mine, rr, reviewed, commented, reviewedRecent] = await Promise.all([
    webList("is:pr is:open author:@me archived:false sort:updated-desc", settings),
    webList("is:pr is:open user-review-requested:@me reviewed-by:@me archived:false sort:updated-desc", settings),
    webList("is:pr is:open reviewed-by:@me -author:@me archived:false sort:updated-desc", settings),
    webList(`is:pr archived:false commenter:@me updated:>=${since} sort:updated-desc`, settings),
    webList(`is:pr archived:false reviewed-by:@me updated:>=${since} sort:updated-desc`, settings),
  ]);

  // My open PRs.
  const authoredItems = await settle(mine, async (x) => {
    const d = await prParts(x, ["convo", "threads", "merge", "checks"], settings);
    return { ...summarizeAuthored(webAuthoredNode(x, d), me), session: true };
  });

  // Re-review requested: I reviewed it before and I'm a requested reviewer again.
  const reRequested = await settle(rr, async (x) => {
    const d = await prParts(x, ["requests"], settings);
    const req = (d.requests?.pendingReviewRequests || []).filter((r) => r.reviewer?.displayLogin === me).pop();
    return { key: keyOf(x), repo: x.repoNameWithOwner, number: x.number, title: x.title, url: x.permalink, author: x.author?.displayLogin || "ghost", requestedAt: req?.createdAt || null, requestedBy: null };
  });

  // Open PRs I reviewed: approval dismissed (Re-review tab), and new commits since my last review (the bar).
  const reApprove = [];
  const moved = [];
  await settle(reviewed, async (x) => {
    const d = await prParts(x, ["convo", "requests"], settings);
    const base = { key: keyOf(x), repo: x.repoNameWithOwner, number: x.number, title: x.title, url: x.permalink, author: x.author?.displayLogin || "ghost" };
    // My latest verdict (comments don't count). Re-approving or requesting changes takes the PR off the list.
    const verdict = webReviews(d)
      .filter((r) => r.author.login === me && ["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(r.state))
      .sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    if (verdict?.state === "DISMISSED" && verdict.dismissedState === "APPROVED") {
      reApprove.push({ ...base, isDraft: !!x.isDraft, updatedAt: x.updatedAt, approvedAt: verdict.submittedAt, approvedSha: null, headSha: x.headSha, reviewId: verdict.id, dismissedAt: null, dismissedBy: null, since: null });
    }
    const last = (d.requests?.completedReviews || []).filter((r) => r.reviewer?.displayLogin === me).sort((a, b) => b.submittedAt.localeCompare(a.submittedAt))[0];
    if (last?.headSha && x.headSha && last.headSha !== x.headSha) moved.push({ ...base, key: `${base.key}@${x.headSha}` });
  });

  // PRs I commented on or reviewed in the last 3 weeks: replies after my last message.
  const byUrl = new Map([...commented, ...reviewedRecent].map((x) => [x.permalink, x]));
  const found = await settle([...byUrl.values()], async (x) => summarizePr(webTheirNode(x, await prParts(x, ["convo", "threads"], settings)), me));
  // Plus PRs opened in this browser that the search missed (my own PRs aren't "threads I follow").
  const known = new Set([...byUrl.values(), ...mine].map((x) => keyOf(x).toLowerCase()));
  const threadItems = [...found, ...(await seenPrs(settings, me, known))].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));

  const at = Date.now();
  const byRepoNum = (a, b) => a.repo.localeCompare(b.repo) || a.number - b.number;
  await chrome.storage.local.set({
    authored: { me, items: authoredItems, total: mine.length, source: "session", at },
    reRequested: { me, items: reRequested, source: "session", at },
    reApprove: { me, items: reApprove.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)), source: "session", at },
    myThreads: { me, items: threadItems, source: "session", at },
    reReview: { items: moved.sort(byRepoNum), source: "session", at },
  });
  return me;
}
