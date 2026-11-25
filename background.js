// Service worker: gets the PR data (GitHub's own page data with the browser's sign-in, else the API with the token),
// stores it for the content scripts, and shows the desktop notifications.
// GHHost (which GitHub), GHCState (shared with the sidebar), refreshFromSession. Firefox has no service worker here:
// it loads these files as a background page, listed in its manifest (scripts/package.mjs).
if (typeof importScripts === "function") importScripts("host.js", "content/prstate.js", "session-source.js");

const DEFAULTS = {
  apiBase: "", // set on the options page (GHHost): nothing runs until then
  token: "",
  repoContributors: {}, // { "owner/repo": ["login", ...] } manual override
  autoViewed: { enabled: true },
  notify: { reReview: true, attention: true, threads: true, ready: true },
};
const IS_FIREFOX = chrome.runtime.getURL("").startsWith("moz-extension:");

async function getSettings() {
  const s = await chrome.storage.local.get(Object.keys(DEFAULTS));
  return {
    ...DEFAULTS,
    ...s,
    autoViewed: { ...DEFAULTS.autoViewed, ...(s.autoViewed || {}) },
    notify: { ...DEFAULTS.notify, ...(s.notify || {}) },
  };
}

async function api(path, settings) {
  const res = await fetch(`${settings.apiBase}${path}`, {
    headers: {
      Authorization: `Bearer ${settings.token}`,
      Accept: "application/vnd.github+json",
    },
  });
  if (!res.ok) {
    let detail = "";
    try {
      const body = await res.json();
      detail = [body.message, ...(body.errors || []).map((e) => e.message)].filter(Boolean).join("; ");
    } catch {}
    throw new Error(`${res.status} ${detail || path}`);
  }
  return res.json();
}

async function apiAll(path, settings) {
  const out = [];
  for (let page = 1; page <= 10; page++) {
    const sep = path.includes("?") ? "&" : "?";
    const items = await api(`${path}${sep}per_page=100&page=${page}`, settings);
    out.push(...items);
    if (items.length < 100) break;
  }
  return out;
}

// PRs I reviewed whose head commit moved after my last review.
async function computeReReview() {
  const settings = await getSettings();
  if (!settings.token) return { error: "no-token", items: [] };

  const me = (await api("/user", settings)).login;
  const q = encodeURIComponent(`is:pr is:open reviewed-by:${me} -author:${me} archived:false`);
  const found = await api(`/search/issues?q=${q}&per_page=50`, settings);

  const items = [];
  await Promise.all(
    found.items.map(async (issue) => {
      const repo = issue.repository_url.split("/repos/")[1];
      const base = `/repos/${repo}/pulls/${issue.number}`;
      try {
        const [pr, reviews] = await Promise.all([api(base, settings), apiAll(`${base}/reviews`, settings)]);
        const mine = reviews.filter((r) => r.user?.login === me && r.state !== "PENDING");
        if (!mine.length) return;
        const last = mine[mine.length - 1];
        if (last.commit_id !== pr.head.sha) {
          items.push({
            repo,
            number: issue.number,
            title: issue.title,
            author: issue.user.login,
            url: issue.html_url,
            key: `${repo}#${issue.number}@${pr.head.sha}`,
          });
        }
      } catch (e) {
        console.warn("[companion] PR check failed", issue.html_url, e);
      }
    })
  );
  items.sort((a, b) => a.repo.localeCompare(b.repo) || a.number - b.number);
  return { items };
}

// ---- /pulls dashboard: review-request count + "My threads" ----

let meCache = null;
async function getMe(settings) {
  if (meCache) return meCache;
  meCache = (await api("/user", settings)).login;
  return meCache;
}

async function graphqlFull(query, variables, settings) {
  const res = await fetch(`${settings.apiBase}/graphql`, {
    method: "POST",
    headers: { Authorization: `Bearer ${settings.token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`${res.status} graphql`);
  const json = await res.json();
  if (json.errors?.length) console.warn("[companion] graphql errors", json.errors);
  if (json.errors?.length && !json.data) throw new Error(json.errors[0].message);
  return { data: json.data, errors: json.errors || [] };
}

async function graphql(query, variables, settings) {
  return (await graphqlFull(query, variables, settings)).data;
}

const DASHBOARD_QUERY = `
query($c: String!, $r: String!) {
  c: search(type: ISSUE, query: $c, first: 30) { nodes { ...PR } }
  r: search(type: ISSUE, query: $r, first: 30) { nodes { ...PR } }
}
fragment PR on PullRequest {
  number title url state isDraft updatedAt
  author { login }
  repository { nameWithOwner }
  comments(last: 30) { nodes { author { login __typename } createdAt url } }
  reviewThreads(first: 60) {
    nodes {
      isResolved isOutdated path
      head: comments(first: 1) { nodes { author { login __typename } bodyText createdAt url } }
      tail: comments(last: 20) { nodes { author { login __typename } createdAt url } }
    }
  }
}`;

const isHuman = (c) => c.author && c.author.__typename !== "Bot";

// Split a comment list into "my last comment" and "what others wrote after it".
function afterMine(comments, me) {
  let myLastAt = null;
  for (const c of comments) if (c.author?.login === me && (!myLastAt || c.createdAt > myLastAt)) myLastAt = c.createdAt;
  if (!myLastAt) return null;
  const replies = comments
    .filter((c) => isHuman(c) && c.author.login !== me && c.createdAt > myLastAt)
    .map((c) => ({ at: c.createdAt, url: c.url, author: c.author.login }));
  return { myLastAt, replies };
}

function summarizePr(pr, me) {
  const convo = afterMine(pr.comments.nodes, me);
  const threads = [];
  for (const t of pr.reviewThreads.nodes) {
    const seen = new Map();
    for (const c of [...t.head.nodes, ...t.tail.nodes]) seen.set(c.url, c);
    const mine = afterMine([...seen.values()], me);
    if (!mine) continue;
    const first = t.head.nodes[0];
    threads.push({
      path: t.path,
      resolved: t.isResolved,
      outdated: t.isOutdated,
      snippet: (first?.bodyText || "").replace(/\s+/g, " ").slice(0, 140),
      startedBy: first?.author?.login || null,
      url: first?.url || pr.url,
      ...mine,
    });
  }
  if (!convo && !threads.length) return null;
  const repo = pr.repository.nameWithOwner;
  return {
    key: `${repo}#${pr.number}`,
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    state: pr.state, // OPEN | MERGED | CLOSED
    isDraft: pr.isDraft,
    author: pr.author?.login || "ghost",
    updatedAt: pr.updatedAt,
    convo,
    threads,
  };
}

let lastDashboard = 0;
async function refreshDashboard(force) {
  if (!force && Date.now() - lastDashboard < 30_000) return; // page loads ask for a refresh too: don't hammer the API
  lastDashboard = Date.now();
  const settings = await getSettings();
  if (!settings.token) {
    await chrome.storage.local.set({ myThreads: { error: "no-token", items: [], at: Date.now() } });
    return;
  }
  try {
    const me = await getMe(settings);
    const since = new Date(Date.now() - 21 * 864e5).toISOString().slice(0, 10);
    const data = await graphql(
      DASHBOARD_QUERY,
      {
        c: `is:pr archived:false commenter:${me} updated:>=${since} sort:updated-desc`,
        r: `is:pr archived:false reviewed-by:${me} updated:>=${since} sort:updated-desc`,
      },
      settings
    );
    const byKey = new Map();
    for (const pr of [...(data.c?.nodes || []), ...(data.r?.nodes || [])]) {
      if (!pr?.repository) continue;
      const s = summarizePr(pr, me);
      if (s) byKey.set(s.key, s);
    }
    const items = [...byKey.values()].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    await chrome.storage.local.set({
      myThreads: { me, items, at: Date.now() },
    });
  } catch (e) {
    console.warn("[companion] dashboard refresh failed", e);
    const prev = (await chrome.storage.local.get("myThreads")).myThreads;
    await chrome.storage.local.set({ myThreads: { ...(prev || { items: [] }), error: String(e), at: Date.now() } });
  }
}

// ---- "Re-review" tab: open PRs whose approval from me was dismissed (usually by a new push) ----

const DISMISSED_QUERY = `
query($q: String!, $me: String!) {
  search(type: ISSUE, query: $q, first: 50) {
    nodes {
      ... on PullRequest {
        id number title url isDraft updatedAt headRefOid
        author { login }
        repository { nameWithOwner }
        reviews(author: $me, states: [APPROVED, CHANGES_REQUESTED, DISMISSED], last: 1) {
          nodes { id state submittedAt commit { oid } }
        }
        timelineItems(itemTypes: [REVIEW_DISMISSED_EVENT], last: 20) {
          nodes { ... on ReviewDismissedEvent { createdAt previousReviewState actor { login } review { id } } }
        }
      }
    }
  }
}`;

// Files that differ between the commit I approved and the PR's head. Cached per commit pair: it can't change.
// After a rebase / merge of the base branch the compare also holds the base's changes, so then we only count
// files that are part of the PR (and flag the number as approximate).
async function filesSinceApproval(item, settings, cache) {
  if (!item.approvedSha || !item.headSha) return null;
  const id = `${item.repo}@${item.approvedSha}..${item.headSha}`;
  if (cache[id]) return cache[id].v;
  try {
    const cmp = await api(`/repos/${item.repo}/compare/${item.approvedSha}...${item.headSha}`, settings);
    let paths = (cmp.files || []).map((f) => f.filename);
    const clean = cmp.status === "ahead" || cmp.status === "identical";
    if (!clean) {
      const inPr = new Set((await apiAll(`/repos/${item.repo}/pulls/${item.number}/files`, settings)).map((f) => f.filename));
      paths = paths.filter((p) => inPr.has(p));
    }
    const v = { files: paths.length, paths: paths.slice(0, 30), commits: cmp.ahead_by, approx: !clean };
    cache[id] = { v, at: Date.now() };
    return v;
  } catch (e) {
    console.warn("[companion] compare failed", id, e); // e.g. the approved commit is gone after a force-push
    return null;
  }
}

async function refreshReApprove() {
  const settings = await getSettings();
  if (!settings.token) {
    await chrome.storage.local.set({ reApprove: { error: "no-token", items: [], at: Date.now() } });
    return;
  }
  try {
    const me = await getMe(settings);
    const data = await graphql(
      DISMISSED_QUERY,
      { q: `is:pr is:open reviewed-by:${me} -author:${me} archived:false sort:updated-desc`, me },
      settings
    );
    const items = [];
    for (const pr of data.search?.nodes || []) {
      if (!pr?.repository) continue;
      // My latest verdict (comments don't count). Re-approving or requesting changes takes the PR off the list.
      const last = pr.reviews.nodes[0];
      if (last?.state !== "DISMISSED") continue;
      const ev = pr.timelineItems.nodes.filter((e) => e?.review?.id === last.id).pop();
      if (ev && ev.previousReviewState !== "APPROVED") continue; // a dismissed "changes requested" isn't a lost approval
      const repo = pr.repository.nameWithOwner;
      items.push({
        key: `${repo}#${pr.number}`,
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        isDraft: pr.isDraft,
        author: pr.author?.login || "ghost",
        updatedAt: pr.updatedAt,
        approvedAt: last.submittedAt,
        approvedSha: last.commit?.oid || null,
        headSha: pr.headRefOid,
        reviewId: last.id,
        dismissedAt: ev?.createdAt || null,
        dismissedBy: ev?.actor?.login || null,
      });
    }
    items.sort((a, b) => (b.dismissedAt || b.updatedAt).localeCompare(a.dismissedAt || a.updatedAt));
    const { compareCache = {} } = await chrome.storage.local.get("compareCache");
    for (const k of Object.keys(compareCache)) if (compareCache[k].at < Date.now() - 30 * 864e5) delete compareCache[k];
    await Promise.all(items.map((i) => filesSinceApproval(i, settings, compareCache).then((f) => (i.since = f))));
    await chrome.storage.local.set({ compareCache });
    await chrome.storage.local.set({ reApprove: { me, items, at: Date.now() } });
  } catch (e) {
    console.warn("[companion] re-approve refresh failed", e);
    const prev = (await chrome.storage.local.get("reApprove")).reApprove;
    await chrome.storage.local.set({ reApprove: { ...(prev || { items: [] }), error: String(e), at: Date.now() } });
  }
}

// Counts for tab badges: the content script hands us the exact search query behind the tab
// (e.g. "is:pr is:open review-requested:@me repo:o/r"), we keep it fresh while it's being looked at.
const WATCH_TTL = 24 * 60 * 60 * 1000;
let countsChain = Promise.resolve();
function refreshCounts(onlyQ) {
  countsChain = countsChain.then(async () => {
    const settings = await getSettings();
    if (!settings.token) return;
    const me = await getMe(settings);
    const { watchedQueries = {}, tabCounts = {} } = await chrome.storage.local.get(["watchedQueries", "tabCounts"]);
    if (onlyQ) watchedQueries[onlyQ] = Date.now();
    for (const q of Object.keys(watchedQueries)) {
      if (Date.now() - watchedQueries[q] > WATCH_TTL) {
        delete watchedQueries[q];
        delete tabCounts[q];
      }
    }
    for (const q of onlyQ ? [onlyQ] : Object.keys(watchedQueries)) {
      const query = q.replace(/@me\b/g, me);
      try {
        const r = await api(`/search/issues?q=${encodeURIComponent(query)}&per_page=1`, settings);
        tabCounts[q] = { count: r.total_count, at: Date.now() };
        console.log("[companion] count", JSON.stringify(query), "=", r.total_count);
      } catch (e) {
        console.warn("[companion] count failed", query, e);
        let error = String(e.message || e);
        if (error.startsWith("422")) error += " (GitHub refuses a search when the token can't see a repo or user in it: check the token has access to this repo and is SSO-authorized for the org)";
        tabCounts[q] = { count: undefined, error, at: Date.now() };
      }
    }
    await chrome.storage.local.set({ watchedQueries, tabCounts });
  }).catch((e) => console.warn("[companion] counts failed", e));
  return countsChain;
}

// ---- "Authored by me": my open PRs with a state each, plus PRs where my review was re-requested ----

const AUTHORED_QUERY = `
query($a: String!, $rr: String!) {
  a: search(type: ISSUE, query: $a, first: 50) {
    issueCount
    nodes {
      ... on PullRequest {
        number title url isDraft updatedAt headRefOid mergeable mergeStateStatus reviewDecision
        repository { nameWithOwner }
        commits(last: 1) { nodes { commit { statusCheckRollup { state } } } }
        reviewRequests(first: 1) { totalCount }
        latestOpinionatedReviews(first: 20) { nodes { state author { login } } }
        reviews(last: 40) { nodes { id state submittedAt bodyText url author { login __typename } } }
        comments(last: 30) { nodes { createdAt url author { login __typename } } }
        reviewThreads(first: 80) {
          nodes { isResolved comments(last: 20) { nodes { createdAt url author { login __typename } } } }
        }
      }
    }
  }
  rr: search(type: ISSUE, query: $rr, first: 30) {
    nodes {
      ... on PullRequest {
        number title url
        author { login }
        repository { nameWithOwner }
        timelineItems(itemTypes: [REVIEW_REQUESTED_EVENT], last: 10) {
          nodes { ... on ReviewRequestedEvent { createdAt actor { login } requestedReviewer { ... on User { login } } } }
        }
      }
    }
  }
}`;

// Everything the state needs, flattened. "activity" = comments and reviews by others; "answered" when I wrote
// after it in the same place (same thread / the conversation), or the thread was resolved.
function summarizeAuthored(pr, me) {
  const repo = pr.repository.nameWithOwner;
  const mine = (c) => c.author?.login === me;
  const activity = [];

  // Conversation tab: bots (CI, coverage, Sonar…) post there on every push, so only people count.
  const convo = pr.comments.nodes.filter((c) => c?.author);
  const myLastConvo = convo.filter(mine).reduce((m, c) => (c.createdAt > m ? c.createdAt : m), "");
  for (const c of convo) {
    if (mine(c) || !isHuman(c)) continue;
    activity.push({ kind: "comment", at: c.createdAt, url: c.url, author: c.author.login, answered: myLastConvo > c.createdAt });
  }

  // Review threads: bots count here (e.g. Copilot code review), they're real review comments.
  let unanswered = 0;
  let openThreads = 0;
  let myLastAny = myLastConvo;
  for (const t of pr.reviewThreads.nodes) {
    const cs = t.comments.nodes.filter((c) => c?.author);
    const myLast = cs.filter(mine).reduce((m, c) => (c.createdAt > m ? c.createdAt : m), "");
    if (myLast > myLastAny) myLastAny = myLast;
    for (const c of cs) {
      if (mine(c)) continue;
      activity.push({ kind: "thread", at: c.createdAt, url: c.url, author: c.author.login, answered: t.isResolved || myLast > c.createdAt });
    }
    if (!t.isResolved) {
      openThreads++;
      const last = cs[cs.length - 1];
      if (last && !mine(last)) unanswered++;
    }
  }

  // Review submissions by others. A review with a body is a comment; a bare approval isn't "new comments",
  // but it is still reported for notifications ("someone reviewed it").
  const reviews = [];
  for (const r of pr.reviews.nodes) {
    if (!r?.author || mine(r) || r.state === "PENDING" || !r.submittedAt) continue;
    reviews.push({ id: r.id, state: r.state, at: r.submittedAt, url: r.url, author: r.author.login });
    if (r.bodyText?.trim() || r.state === "CHANGES_REQUESTED") {
      activity.push({ kind: "review", at: r.submittedAt, url: r.url, author: r.author.login, answered: myLastAny > r.submittedAt });
    }
  }

  const verdicts = pr.latestOpinionatedReviews?.nodes || [];
  const changesRequested = pr.reviewDecision === "CHANGES_REQUESTED" || verdicts.some((v) => v.state === "CHANGES_REQUESTED");
  const approved =
    pr.reviewDecision === "APPROVED" || (pr.reviewDecision == null && verdicts.some((v) => v.state === "APPROVED") && !changesRequested);
  activity.sort((a, b) => a.at.localeCompare(b.at));

  return {
    key: `${repo}#${pr.number}`,
    repo,
    number: pr.number,
    title: pr.title,
    url: pr.url,
    isDraft: pr.isDraft,
    updatedAt: pr.updatedAt,
    headSha: pr.headRefOid,
    mergeable: pr.mergeable, // MERGEABLE | CONFLICTING | UNKNOWN
    // GitHub's own merge box verdict: CLEAN = "Ready to merge, all requirements are met".
    mergeState: pr.mergeStateStatus, // CLEAN | HAS_HOOKS | BLOCKED | BEHIND | DIRTY | UNSTABLE | DRAFT | UNKNOWN
    checks: pr.commits.nodes[0]?.commit?.statusCheckRollup?.state || null, // SUCCESS | FAILURE | ERROR | PENDING | EXPECTED | null
    reviewDecision: pr.reviewDecision,
    approved,
    changesRequested,
    pendingReviewers: pr.reviewRequests.totalCount,
    reviewCount: reviews.length,
    openThreads,
    unanswered,
    activity,
    reviews,
  };
}

let lastAuthored = 0;
async function refreshAuthored(force) {
  if (!force && Date.now() - lastAuthored < 30_000) return;
  lastAuthored = Date.now();
  const settings = await getSettings();
  if (!settings.token) {
    await chrome.storage.local.set({ authored: { error: "no-token", items: [], at: Date.now() } });
    return;
  }
  try {
    const me = await getMe(settings);
    const { data, errors } = await graphqlFull(
      AUTHORED_QUERY,
      {
        a: `is:pr is:open author:${me} archived:false sort:updated-desc`,
        // I reviewed it before and I'm a requested reviewer (again): a re-review request.
        rr: `is:pr is:open user-review-requested:${me} reviewed-by:${me} archived:false sort:updated-desc`,
      },
      settings
    );
    const items = (data.a?.nodes || []).filter((pr) => pr?.repository).map((pr) => summarizeAuthored(pr, me));
    // A field the token can't read makes GitHub null the whole PR: say so instead of quietly showing fewer PRs.
    const hidden = (data.a?.issueCount ?? items.length) - items.length;
    const error =
      !data.a || hidden > 0
        ? `GitHub returned ${data.a ? `${hidden} of your open PRs` : "no PRs"} without data` +
          (errors.length ? `: ${[...new Set(errors.map((e) => e.message))].join("; ")}` : "") +
          " (check the token's permissions in the extension options)"
        : undefined;
    const reRequested = [];
    for (const pr of data.rr?.nodes || []) {
      if (!pr?.repository) continue;
      const ev = pr.timelineItems.nodes.filter((e) => e?.requestedReviewer?.login === me).pop();
      const repo = pr.repository.nameWithOwner;
      reRequested.push({
        key: `${repo}#${pr.number}`,
        repo,
        number: pr.number,
        title: pr.title,
        url: pr.url,
        author: pr.author?.login || "ghost",
        requestedAt: ev?.createdAt || null,
        requestedBy: ev?.actor?.login || null,
      });
    }
    await chrome.storage.local.set({
      authored: { me, items, total: data.a?.issueCount ?? items.length, error, at: Date.now() },
      reRequested: { me, items: reRequested, at: Date.now() },
    });
  } catch (e) {
    console.warn("[companion] authored refresh failed", e);
    const prev = (await chrome.storage.local.get("authored")).authored;
    await chrome.storage.local.set({ authored: { ...(prev || { items: [] }), error: String(e), at: Date.now() } });
  }
}

// ---- Desktop notifications ----
// Works off the data the refreshes above store. Every event has a key; a key notifies once. The first run, and any
// type that is switched off, only records keys, so turning a type on (or installing) doesn't replay old events.

const NOTIFY_KEEP_MS = 45 * 864e5;
const NOTIFY_MAX = 5; // per poll; more than that becomes one summary
// Every kind of event (key prefix). A kind this install hasn't polled for before (new in an update) is recorded
// silently on its first poll, like a first run, so updating doesn't replay what was already true.
const NOTIFY_KINDS = ["rr", "dis", "rev", "c", "ci", "ready"];
// …except what happened in the last minutes: that is new to the user, not history (e.g. a comment that arrived just
// before the extension was installed or updated).
const FIRST_RUN_GRACE_MS = 15 * 60_000;
let notifyChain = Promise.resolve();

function collectEvents(s, seenOf) {
  const out = []; // { type, key, title, message, context, url }
  const ctx = (i) => `${i.repo}#${i.number}`;
  // macOS shows the browser's attribution (the extension's name), the title and the body, but not the context line:
  // short titles that fit on one line, and the PR's repo and number in the body.
  const body = (i, extra = "") => `${i.title}${extra}\n${i.repo.split("/")[1]}#${i.number}`;

  // 1. Re-review requested.
  for (const i of s.reRequested?.items || []) {
    out.push({
      type: "reReview",
      at: i.requestedAt,
      key: `rr:${i.key}@${i.requestedAt || "?"}`,
      title: `${i.requestedBy || i.author} asks for your re-review`,
      message: body(i),
      context: ctx(i),
      url: `${i.url}/files`,
    });
  }

  // 2. My PRs: someone reviewed / commented, or the checks on the current head passed.
  for (const i of s.authored?.items || []) {
    const seenAt = seenOf(i.key);
    const verb = { APPROVED: "approved", CHANGES_REQUESTED: "requested changes on", COMMENTED: "reviewed", DISMISSED: "reviewed" };
    for (const r of i.reviews || []) {
      if (Date.parse(r.at) <= seenAt) continue;
      out.push({ type: "attention", at: r.at, key: `rev:${r.id}`, title: `${r.author} ${verb[r.state] || "reviewed"} your PR`, message: body(i), context: ctx(i), url: r.url || i.url });
    }
    for (const a of GHCState.freshActivity(i, seenAt)) {
      if (a.kind === "review") continue; // covered by the review itself
      out.push({ type: "attention", at: a.at, key: `c:${a.url}`, title: `${a.author} commented on your PR`, message: body(i), context: ctx(i), url: a.url });
    }
    if (i.checks === "SUCCESS" && i.headSha) {
      out.push({ type: "attention", key: `ci:${i.key}@${i.headSha}`, title: "Checks passed on your PR", message: body(i), context: ctx(i), url: i.url });
    }
    // GitHub (or, without its merge verdict, "approved + checks passed") says it can be merged. Once per head commit.
    if (GHCState.isReady(i)) {
      out.push({ type: "ready", key: `ready:${i.key}@${i.headSha || i.checksText || "?"}`, title: "Your PR is ready to merge", message: body(i), context: ctx(i), url: i.url, rank: 0 });
    }
  }

  // 1b. My approval was dismissed (usually by a new push): look again.
  for (const i of s.reApprove?.items || []) {
    out.push({
      type: "reReview",
      key: `dis:${i.key}@${i.reviewId || i.dismissedAt || i.headSha || "?"}`,
      title: "Your approval was dismissed",
      message: body(i, i.since ? ` (${i.since.approx ? "~" : ""}${i.since.files} file${i.since.files === 1 ? "" : "s"} changed since)` : ""),
      context: ctx(i),
      url: i.approvedSha && i.headSha ? `${i.url}/files/${i.approvedSha}..${i.headSha}` : `${i.url}/files`,
    });
  }

  // 3. New replies in threads I'm part of (PRs I commented on or reviewed).
  for (const i of s.myThreads?.items || []) {
    const seenAt = seenOf(i.key);
    const replies = [...(i.convo?.replies || []), ...i.threads.flatMap((t) => t.replies)];
    for (const r of replies) {
      if (Date.parse(r.at) <= seenAt) continue;
      out.push({ type: "threads", at: r.at, key: `c:${r.url}`, title: `${r.author} replied to you`, message: body(i), context: ctx(i), url: r.url });
    }
  }
  return out;
}

async function showNotification(n) {
  const id = `ghc|${Date.now()}|${Math.random().toString(36).slice(2, 8)}`;
  // What was sent, for the options page ("did it try?" when nothing showed up on screen).
  const { notifyLog = [] } = await chrome.storage.local.get("notifyLog");
  await chrome.storage.local.set({ notifyLog: [{ at: Date.now(), title: n.title, context: n.context || "" }, ...notifyLog].slice(0, 10) });
  const { notifUrls = {} } = await chrome.storage.session.get("notifUrls");
  notifUrls[id] = n.url;
  await chrome.storage.session.set({ notifUrls });
  await chrome.notifications.create(id, {
    type: "basic",
    iconUrl: "icons/icon128.png",
    title: n.title,
    message: n.message || "",
    // Firefox has neither (the body already ends with the PR's repo#number).
    ...(IS_FIREFOX ? {} : { contextMessage: n.context || "", priority: 1 }),
  });
}

function notifyChanges() {
  notifyChain = notifyChain.then(async () => {
    const settings = await getSettings();
    const s = await chrome.storage.local.get(["authored", "reRequested", "reApprove", "myThreads", "threadSeen", "notifyState"]);
    if (!s.authored?.me && !s.myThreads?.me) return; // nothing fetched yet (a failed refresh stores no "me")
    const seen = s.threadSeen || {};
    const state = s.notifyState || { init: false, sent: {} };
    const first = !state.init;
    const kinds = new Set(state.kinds || ["rr", "rev", "c", "ci"]); // what versions before 0.4 polled for
    const now = Date.now();
    const toShow = [];
    const recent = (e) => !!e.at && now - Date.parse(e.at) < FIRST_RUN_GRACE_MS;
    for (const e of collectEvents(s, (k) => seen[k] || 0)) {
      if (state.sent[e.key]) continue;
      state.sent[e.key] = now; // one key, one notification, whichever type gets it first
      const known = !first && kinds.has(e.key.split(":")[0]);
      if ((known || recent(e)) && settings.notify[e.type]) toShow.push(e);
    }
    for (const k of Object.keys(state.sent)) if (now - state.sent[k] > NOTIFY_KEEP_MS) delete state.sent[k];
    state.init = true;
    state.kinds = NOTIFY_KINDS;
    await chrome.storage.local.set({ notifyState: state });

    // One notification per PR: a review with three inline comments is one event for the user.
    const byPr = new Map();
    for (const e of toShow) byPr.set(e.context, [...(byPr.get(e.context) || []), e]);
    // The most important event of a PR is its headline ("ready to merge" beats "checks passed").
    const groups = [...byPr.values()].map((es) => es.sort((a, b) => (a.rank ?? 1) - (b.rank ?? 1))).map((es) =>
      es.length === 1 ? es[0] : { ...es[0], message: `${es[0].message}\n+${es.length - 1} more update${es.length === 2 ? "" : "s"}` }
    );
    if (groups.length > NOTIFY_MAX) {
      await showNotification({
        title: `${groups.length} PRs with updates`, // the browser already shows the extension's name
        message: [...new Set(groups.map((e) => e.title))].slice(0, 4).join("\n"),
        context: "",
        url: webBase(settings) + "/pulls",
      });
    } else {
      for (const e of groups) await showNotification(e);
    }
    if (toShow.length) console.log("[companion] notified", toShow.map((e) => e.key));
  }).catch((e) => console.warn("[companion] notify failed", e));
  return notifyChain;
}

chrome.notifications.onClicked.addListener(async (id) => {
  const { notifUrls = {} } = await chrome.storage.session.get("notifUrls");
  const url = notifUrls[id];
  chrome.notifications.clear(id);
  // Only ever open a page on the GitHub host (the URL comes from stored data).
  try {
    const web = webBase(await getSettings());
    if (url && new URL(url).origin === new URL(web).origin) chrome.tabs.create({ url });
  } catch {}
  delete notifUrls[id];
  await chrome.storage.session.set({ notifUrls });
});

// When I open a PR, its replies count as read.
async function markSeen(key) {
  const { threadSeen = {} } = await chrome.storage.local.get("threadSeen");
  const cutoff = Date.now() - 60 * 864e5;
  for (const k of Object.keys(threadSeen)) if (threadSeen[k] < cutoff) delete threadSeen[k];
  threadSeen[key] = Date.now();
  await chrome.storage.local.set({ threadSeen });
}

// Where the data comes from: GitHub's own page data with the browser's sign-in (sees everything the browser sees),
// else the API with the token. Page loads ask for a refresh too: at most one every 30 s unless forced.
let lastRefresh = 0;
async function refresh(force) {
  const settings = await getSettings();
  if (!GHHost.parse(settings.apiBase)) return; // no GitHub picked yet (the options page asks on install)
  if (!force && Date.now() - lastRefresh < 30_000) return;
  lastRefresh = Date.now();
  if (force) refreshCounts();
  try {
    await refreshFromSession(settings);
    return notifyChanges();
  } catch (e) {
    console.warn("[companion] session data failed", e);
    if (!settings.token) {
      // Nothing else to fall back on: say why on every surface (the bar, the tabs) instead of showing nothing.
      const error = e instanceof SignedOut ? `${e.message} (or add a token in the options)` : `couldn't read GitHub's page data: ${e.message}`;
      const prev = await chrome.storage.local.get(["authored", "myThreads", "reApprove", "reReview"]);
      const failed = Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, { items: [], ...v, me: undefined, error, at: Date.now() }]));
      for (const k of ["authored", "myThreads", "reApprove", "reReview"]) failed[k] ||= { items: [], error, at: Date.now() };
      await chrome.storage.local.set(failed);
      return;
    }
  }
  // The data notifications read: wait for it, then compare with what was already notified.
  const feeds = Promise.allSettled([refreshDashboard(true), refreshAuthored(true), refreshReApprove()]).then(() => notifyChanges());
  try {
    const result = await computeReReview();
    console.log("[companion] re-review result", result);
    await chrome.storage.local.set({ reReview: { ...result, at: Date.now() } });
  } catch (e) {
    console.warn("[companion] refresh failed", e);
    await chrome.storage.local.set({ reReview: { items: [], error: String(e), at: Date.now() } });
  }
  await feeds;
}

// The scripts for GitHub's pages run only on the GitHub picked in the options, so they're registered here rather
// than in the manifest, and again whenever that choice changes.
const PAGE_SCRIPTS = {
  id: "pages",
  js: ["content/common.js", "content/brand.js", "content/assignee.js", "content/reviewers.js", "content/autoviewed.js", "content/statusbar.js", "content/prstate.js", "content/pulls.js"],
  css: ["content/statusbar.css", "content/autoviewed.css", "content/pulls.css", "content/reviewers.css", "content/brand.css"],
  runAt: "document_idle",
};
let pageScriptsChain = Promise.resolve();
function syncPageScripts() {
  pageScriptsChain = pageScriptsChain.then(async () => {
    const host = GHHost.parse((await getSettings()).apiBase);
    const matches = host ? [`${host.web}/*`] : null;
    const [current] = await chrome.scripting.getRegisteredContentScripts({ ids: [PAGE_SCRIPTS.id] });
    if (current && matches && JSON.stringify(current.matches) === JSON.stringify(matches)) return;
    if (current) await chrome.scripting.unregisterContentScripts({ ids: [PAGE_SCRIPTS.id] });
    if (matches) await chrome.scripting.registerContentScripts([{ ...PAGE_SCRIPTS, matches }]);
  }).catch((e) => console.warn("[companion] registering the page scripts failed", e));
  return pageScriptsChain;
}
chrome.storage.onChanged.addListener((c, area) => area === "local" && c.apiBase && syncPageScripts());

chrome.runtime.onInstalled.addListener(async () => {
  chrome.alarms.create("poll", { periodInMinutes: 1 });
  await syncPageScripts();
  if (GHHost.parse((await getSettings()).apiBase)) refresh(true);
  else chrome.runtime.openOptionsPage(); // first install (or an update from before the host was a choice): pick a GitHub
});
chrome.runtime.onStartup.addListener(() => {
  chrome.alarms.create("poll", { periodInMinutes: 1 });
  syncPageScripts(); // Firefox may not keep registered scripts across restarts
});
chrome.alarms.onAlarm.addListener((a) => a.name === "poll" && refresh(true));

chrome.runtime.onMessage.addListener((msg, sender, send) => {
  if (sender.id !== chrome.runtime.id) return; // only this extension's own pages and content scripts
  if (msg.type === "refresh") {
    refresh(msg.force).then(() => send(true));
    return true;
  }
  if (msg.type === "watchCount") {
    refreshCounts(msg.q).then(() => send(true));
    return true;
  }
  if (msg.type === "prSeen") {
    markSeen(msg.key).then(() => send(true));
    return true;
  }
  if (msg.type === "testNotification") {
    showNotification({ title: "Git Your PRs Together", message: "Notifications work.", context: "Test", url: msg.url || "" })
      .then(() => send(true))
      .catch((e) => send(String(e)));
    return true;
  }
});
