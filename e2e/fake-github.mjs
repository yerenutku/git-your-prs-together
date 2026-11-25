// A tiny fake GitHub for e2e/notify.mjs: the API (GraphQL + the few REST calls) and the pages the extension reads,
// all built from one "world" object that a test step changes. Nothing here talks to the real GitHub.
//
// world = {
//   me: "me",
//   mine:     [{ repo, number, title, headSha, isDraft, mergeState, checks, reviewDecision,
//                comments: [{ author, at }], threads: [{ resolved, comments: [{ author, at }] }],
//                reviews: [{ id, state, author, at, body }] }],            // my open PRs
//   theirs:   [{ repo, number, title, author, comments: [...], threads: [{ resolved, path, comments: [...] }] }],
//                                                                         // PRs by others I commented on / reviewed
//   reRequested: [{ repo, number, title, author, requestedAt, requestedBy }],
//   dismissed:   [{ repo, number, title, author, approvedSha, headSha, approvedAt, dismissedAt, dismissedBy }],
//   signedIn: true,      // the browser's GitHub session; false = every page redirects to /login
//   ssoExpired: false,   // signed in, but the org's single sign-on expired (lists come back empty)
//   signedInInTabsOnly: false, // like a Firefox container: pages are signed in, the extension's own requests aren't
//   pageData: true,      // false = GitHub's page JSON is unavailable (e.g. GitHub changed it): the token must take over
//   picker: { company: [logins], requested: [ids] },     // PR pages get a reviewers picker that behaves like GitHub's
//   contributors: { "owner/repo": [{ login, commits }] }, // /<repo>/graphs/contributors-data (first call: 202, computing)
// }
// The API is what the token path reads; the pages' JSON (/pulls?q=, <pr>/page_data/...) is what the session path reads.
// Times are ISO strings. A comment's url is derived from its place, so it stays the same across steps.

import http from "node:http";

export const WEB = "https://acme.ghe.com";
export const API = "https://api.acme.ghe.com";

const prUrl = (p) => `${WEB}/${p.repo}/pull/${p.number}`;
const user = (login) => ({ login, __typename: /\[bot\]$/.test(login) ? "Bot" : "User" });
const comment = (p, c, where) => ({
  author: user(c.author),
  createdAt: c.at,
  url: `${prUrl(p)}#${where}`,
  bodyText: c.body || `comment by ${c.author}`,
});
const convo = (p) => (p.comments || []).map((c, k) => comment(p, c, `issuecomment-${p.number}${k}`));
const threadNodes = (p) =>
  (p.threads || []).map((t, ti) => {
    const cs = t.comments.map((c, k) => comment(p, c, `discussion_r${p.number}${ti}${k}`));
    return { isResolved: !!t.resolved, isOutdated: false, path: t.path || "src/app.ts", comments: { nodes: cs }, head: { nodes: cs.slice(0, 1) }, tail: { nodes: cs.slice(-20) } };
  });

function authoredNode(p) {
  const reviews = (p.reviews || []).map((r) => ({
    id: r.id,
    state: r.state,
    submittedAt: r.at,
    bodyText: r.body || "",
    url: `${prUrl(p)}#pullrequestreview-${r.id}`,
    author: user(r.author),
  }));
  return {
    number: p.number,
    title: p.title,
    url: prUrl(p),
    isDraft: !!p.isDraft,
    updatedAt: p.updatedAt || new Date().toISOString(),
    headRefOid: p.headSha || "head1",
    mergeable: p.mergeState === "DIRTY" ? "CONFLICTING" : "MERGEABLE",
    mergeStateStatus: p.mergeState || "BLOCKED",
    reviewDecision: p.reviewDecision ?? "REVIEW_REQUIRED",
    repository: { nameWithOwner: p.repo },
    commits: { nodes: [{ commit: { statusCheckRollup: p.checks ? { state: p.checks } : null } }] },
    reviewRequests: { totalCount: p.pendingReviewers ?? 1 },
    latestOpinionatedReviews: { nodes: reviews.filter((r) => r.state !== "COMMENTED").map((r) => ({ state: r.state, author: r.author })) },
    reviews: { nodes: reviews },
    comments: { nodes: convo(p) },
    reviewThreads: { nodes: threadNodes(p) },
  };
}

function theirNode(p) {
  return {
    number: p.number,
    title: p.title,
    url: prUrl(p),
    state: p.state || "OPEN",
    isDraft: false,
    updatedAt: p.updatedAt || new Date().toISOString(),
    author: { login: p.author },
    repository: { nameWithOwner: p.repo },
    comments: { nodes: convo(p) },
    reviewThreads: { nodes: threadNodes(p) },
  };
}

function graphql(world, { query }) {
  if (query.includes("REVIEW_DISMISSED_EVENT")) {
    return {
      search: {
        nodes: (world.dismissed || []).map((p) => ({
          id: `pr${p.number}`,
          number: p.number,
          title: p.title,
          url: prUrl(p),
          isDraft: false,
          updatedAt: p.dismissedAt,
          headRefOid: p.headSha,
          author: { login: p.author },
          repository: { nameWithOwner: p.repo },
          reviews: { nodes: [{ id: `rev${p.number}`, state: "DISMISSED", submittedAt: p.approvedAt, commit: { oid: p.approvedSha } }] },
          timelineItems: { nodes: [{ createdAt: p.dismissedAt, previousReviewState: "APPROVED", actor: { login: p.dismissedBy || p.author }, review: { id: `rev${p.number}` } }] },
        })),
      },
    };
  }
  if (query.includes("a: search")) {
    const a = (world.mine || []).map(authoredNode);
    return {
      a: { issueCount: a.length, nodes: a },
      rr: {
        nodes: (world.reRequested || []).map((p) => ({
          number: p.number,
          title: p.title,
          url: prUrl(p),
          author: { login: p.author },
          repository: { nameWithOwner: p.repo },
          timelineItems: { nodes: [{ createdAt: p.requestedAt, actor: { login: p.requestedBy || p.author }, requestedReviewer: { login: world.me } }] },
        })),
      },
    };
  }
  if (query.includes("c: search")) {
    const nodes = (world.theirs || []).map(theirNode);
    return { c: { nodes }, r: { nodes: [] } };
  }
  throw new Error("unknown graphql query");
}

// One handler for every request: { method, path (with query), body } -> { status, json | html }
export function handle(world, req) {
  const u = new URL(req.url);
  const path = u.pathname;
  if (u.origin === API) {
    if (path === "/user") return { json: { login: world.me } };
    if (path === "/graphql") return { json: { data: graphql(world, JSON.parse(req.body || "{}")) } };
    if (path === "/search/issues") return { json: { total_count: 0, items: [] } };
    if (/\/compare\//.test(path)) return { json: { status: "ahead", ahead_by: 1, files: [{ filename: "src/app.ts" }] } };
    if (/\/pulls\/\d+\/files$/.test(path)) return { json: [{ filename: "src/app.ts" }] };
    return { status: 404, json: { message: `fake api: no ${path}` } };
  }
  if (u.origin === WEB) return web(world, req, u);
  return { status: 404, json: { message: "not fake github" } };
}

// ---- pages ----

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const webUser = (login) => ({ login, displayLogin: login, userType: /\[bot\]$/.test(login) ? "bot" : "human" });
const allPrs = (w) => [
  ...(w.mine || []).map((p) => ({ ...p, author: w.me })),
  ...(w.theirs || []),
  ...(w.reRequested || []),
  ...(w.dismissed || []),
];
// Last time anything happened on a PR: GitHub bumps updatedAt on comments, reviews, requests, pushes.
function updatedAt(w, p) {
  const ts = [
    p.updatedAt,
    p.requestedAt,
    p.dismissedAt,
    ...(p.comments || []).map((c) => c.at),
    ...(p.threads || []).flatMap((t) => t.comments.map((c) => c.at)),
    ...(p.reviews || []).map((r) => r.at),
  ].filter(Boolean);
  return ts.sort().pop() || "2026-01-01T00:00:00Z";
}
const listItem = (w, p) => ({
  itemType: "pull_request",
  repoNameWithOwner: p.repo,
  number: p.number,
  title: p.title,
  permalink: prUrl(p),
  headSha: p.headSha || "head1",
  updatedAt: updatedAt(w, p),
  isDraft: !!p.isDraft,
  state: p.state || "OPEN",
  author: { displayLogin: p.author },
});

// Search behind /pulls?q=… : only the queries the extension makes.
function search(w, q) {
  const open = (p) => (p.state || "OPEN") === "OPEN";
  if (/author:@me/.test(q) && !/-author:@me/.test(q)) return w.mine || [];
  if (/user-review-requested:@me/.test(q)) return w.reRequested || [];
  if (/reviewed-by:@me/.test(q)) return [...(w.reRequested || []), ...(w.dismissed || [])].filter((p) => !/is:open/.test(q) || open(p));
  // unsearchable: GitHub's commenter: search misses it (as it did for a real PR), only opening it in the browser finds it.
  if (/commenter:@me/.test(q)) return (w.theirs || []).filter((p) => !p.unsearchable);
  return [];
}

// <pr>/page_data/<part>
function prPart(w, p, part) {
  const me = w.me;
  const myReview = p.approvedAt
    ? [{ id: `${p.number}9`, state: "DISMISSED", dismissedState: "APPROVED", at: p.approvedAt, author: me }]
    : p.requestedAt
      ? [{ id: `${p.number}8`, state: "COMMENTED", at: new Date(Date.parse(p.requestedAt) - 3600e3).toISOString(), author: me }]
      : [];
  const reviews = [...(p.reviews || []), ...myReview];
  if (part === "conversation_comments") {
    return {
      items: [
        ...(p.comments || []).map((c, k) => ({ type: "issue", id: k, author: webUser(c.author), createdAt: c.at, body: c.body || `comment by ${c.author}`, url: `${prUrl(p)}#issuecomment-${p.number}${k}`, viewerDidAuthor: c.author === me })),
        ...reviews.map((r) => ({ type: "review_summary", id: r.id, relayId: `PRR_${r.id}`, state: r.state, dismissedState: r.dismissedState || null, author: webUser(r.author), createdAt: r.at, body: r.body || "", url: `${prUrl(p)}#pullrequestreview-${r.id}`, viewerDidAuthor: r.author === me })),
      ].sort((a, b) => b.createdAt.localeCompare(a.createdAt)),
    };
  }
  if (part === "threads") {
    return {
      threads: (p.threads || []).map((t, ti) => ({
        id: `${p.number}${ti}`,
        isResolved: !!t.resolved,
        commentsData: { comments: t.comments.map((c, k) => ({ author: webUser(c.author), createdAt: c.at, body: c.body || `comment by ${c.author}`, url: `${prUrl(p)}#discussion_r${p.number}${ti}${k}`, viewerDidAuthor: c.author === me })) },
      })),
    };
  }
  const pending = [...(p.pendingReviewers || []), ...(p.requestedAt ? [{ login: me, at: p.requestedAt }] : [])];
  if (part === "review_requests") {
    return {
      pendingReviewRequests: pending.map((r) => ({ reviewer: { displayLogin: r.login }, createdAt: r.at })),
      completedReviews: reviews.filter((r) => r.state !== "DISMISSED").map((r) => ({ reviewer: { displayLogin: r.author }, state: `REVIEW_STATE_${r.state}`, headSha: r.headSha || p.reviewedSha || p.headSha, submittedAt: r.at })),
    };
  }
  if (part === "merge_box") {
    return {
      pullRequest: {
        headRefOid: p.headSha || "head1",
        isDraft: !!p.isDraft,
        mergeStateStatus: p.mergeState || "BLOCKED",
        pendingReviewRequests: pending.map((r) => ({ reviewer: { login: r.login } })),
        latestOpinionatedReviews: reviews.filter((r) => r.state !== "COMMENTED").map((r) => ({ state: r.state, author: { login: r.author } })),
      },
    };
  }
  if (part === "status_checks") return { statusChecks: [], statusRollup: p.checks ? { combinedState: p.checks } : null };
  return null;
}

function web(world, req, u) {
  const wantsJson = /json/.test(req.headers?.accept || "");
  const path = u.pathname;
  if (path === "/login") return { html: "<!doctype html><title>Sign in</title><p>Sign in to GitHub" };
  if (world.signedIn === false) return { redirect: `/login?return_to=${encodeURIComponent(u.href)}` };
  if (world.pageData === false && wantsJson) return { status: 406, json: {} };
  const graph = path.match(/^\/([^/]+\/[^/]+)\/graphs\/contributors-data$/);
  if (graph) {
    const list = world.contributors?.[graph[1]];
    if (!list) return { status: 404, json: {} };
    world.contributorCalls = (world.contributorCalls || 0) + 1;
    if (world.contributorCalls === 1) return { status: 202, json: {} }; // GitHub computes the stats first
    return { json: list.map((c) => ({ total: c.commits, author: { login: c.login, avatar: c.avatar ?? null } })) };
  }
  const part = path.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)\/page_data\/(\w+)$/);
  if (part) {
    const p = allPrs(world).find((x) => x.repo === part[1] && x.number === Number(part[2]));
    const data = p && prPart(world, p, part[3]);
    return data ? { json: data } : { status: 404, json: {} };
  }
  if (wantsJson && /^\/pulls(\/|$)/.test(path)) {
    const q = u.searchParams.get("q") || (path.startsWith("/pulls/authored") ? "is:pr is:open author:@me" : "");
    const results = world.ssoExpired ? [] : search(world, q).map((p) => listItem(world, p));
    return { json: { payload: { pullsDashboardSurfaceContentRoute: { results, pageInfo: { openCount: results.length }, error: null } } } };
  }
  const prJson = wantsJson && path.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)$/);
  if (prJson) {
    // The PR page's own data: when it last changed; title and author are only in the page title.
    const p = allPrs(world).find((x) => x.repo === prJson[1] && x.number === Number(prJson[2]));
    if (!p) return { status: 404, json: {} };
    return { json: { meta: { title: `${p.title} by ${p.author} · Pull Request #${p.number} · ${p.repo}` }, payload: { pullRequestsOverviewIndexRoute: { lastActivityTimestamp: updatedAt(world, p) } } } };
  }
  if (wantsJson) return { status: 406, json: {} };
  const pr = path.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)/);
  if (pr) return { html: page(world, `PR ${pr[1]}#${pr[2]}`, `<h1>Fake PR ${esc(pr[1])}#${pr[2]}</h1>${world.picker ? picker(world.picker) : ""}`) };
  if (/^\/pulls(\/|$)/.test(path)) {
    const rows = (world.ssoExpired ? [] : world.mine || [])
      .map((p) => `<li class="js-issue-row"><a data-testid="listitem-title-link" href="/${p.repo}/pull/${p.number}">${esc(p.title)}</a><span class="trailingBadgesContainer"></span></li>`)
      .join("");
    const sso = world.ssoExpired ? "<p>Single sign-on to see results in the Acme organization</p>" : "";
    return { html: page(world, "Pull requests", `${sso}<h2>Authored by me</h2><ul class="list">${rows}</ul>`) };
  }
  return { html: page(world, "Fake GitHub", "<p>fake</p>") };
}

// GitHub's reviewers picker as it behaves on GitHub (Primer SelectPanel): empty search = requested
// reviewers + the first 10 users alphabetically; typing searches the whole company (after a delay, max 70);
// the list is re-rendered on every change; clicking an option requests / removes that reviewer at once.
function picker({ company, requested }) {
  // The assignees picker, always open: every company user, Zoe-Novak already assigned.
  const assignees = company.map((u) => `<li role="option" aria-selected="${u === "Zoe-Novak"}">${u}</li>`).join("");
  return `<button id="rv-open" aria-label="Manage reviewers">Reviewers</button>
<div aria-label="Assignees"><ul id="assignees">${assignees}</ul></div>
<script>
(() => {
  // Like GitHub: clicking only changes the selection in the panel; closing it (Escape, click outside) saves the
  // selected people that are in its list at that moment, so a search that hides a requested reviewer removes them.
  const company = ${JSON.stringify(company)}.sort();
  const requested = new Set(${JSON.stringify(requested || [])});
  window.__requests = [];
  let dialog, input, ul, timer, selection;
  function render(q) {
    const items = q
      ? company.filter((u) => u.toLowerCase().includes(q.toLowerCase())).slice(0, 70)
      : [...selection, ...company.filter((u) => !selection.has(u)).slice(0, 10)];
    ul.replaceChildren(...items.map((id) => {
      const li = document.createElement("li");
      li.setAttribute("role", "option");
      li.dataset.id = id;
      li.setAttribute("aria-selected", String(selection.has(id)));
      li.textContent = id;
      li.onclick = () => { selection.has(id) ? selection.delete(id) : selection.add(id); render(input.value); };
      return li;
    }));
  }
  function close() {
    if (!dialog) return;
    const saved = new Set([...ul.querySelectorAll("li[aria-selected='true']")].map((li) => li.dataset.id));
    for (const id of requested) if (!saved.has(id)) window.__requests.push(["remove", id]);
    for (const id of saved) if (!requested.has(id)) window.__requests.push(["request", id]);
    requested.clear();
    saved.forEach((id) => requested.add(id));
    dialog.remove();
    dialog = null;
  }
  document.addEventListener("keydown", (e) => e.key === "Escape" && close());
  document.addEventListener("mousedown", (e) => dialog && !dialog.contains(e.target) && e.target.id !== "rv-open" && close());
  document.getElementById("rv-open").onclick = () => {
    if (dialog) return;
    selection = new Set(requested);
    dialog = document.createElement("div");
    dialog.setAttribute("role", "dialog");
    dialog.style.cssText = "position:absolute;left:320px;top:120px;width:320px;max-height:560px;overflow:auto;background:#fff;border:1px solid #ccc;border-radius:12px;box-shadow:0 8px 24px #0003;padding:8px";
    dialog.innerHTML = '<h2 style="font-size:14px;margin:4px 8px">Request up to 100 reviewers</h2><span class="TextInput"><input aria-label="Filter reviewers" placeholder="Type or choose a user" style="width:90%;margin:4px 8px"></span><div class="scroll"><ul role="listbox" aria-multiselectable="true" style="list-style:none;padding:0 8px"></ul></div>';
    document.body.append(dialog);
    input = dialog.querySelector("input");
    ul = dialog.querySelector("ul");
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => render(input.value), 250); });
    render("");
    input.focus();
  };
})();
</script>`;
}

function page(world, title, main) {
  const nav = [
    ["/pulls", "Inbox"],
    ["/pulls/authored", "Authored by me"],
    ["/pulls/assigned", "Assigned to me"],
    ["/pulls/review-requested", "Review requests"],
  ]
    .map(([h, l]) => `<li><a href="${h}"><span>${l}</span></a></li>`)
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="user-login" content="${esc(world.me)}"><title>${esc(title)}</title>
<style>body{font:14px system-ui;margin:0;display:flex}aside{width:260px;padding:16px;border-right:1px solid #ddd}aside ul{list-style:none;padding:0;margin:0}aside li a{display:block;padding:6px 8px;color:#222;text-decoration:none}main{padding:16px;flex:1}.list li{padding:10px;border-bottom:1px solid #eee}</style>
</head><body><header style="position:fixed;top:0;left:0;right:0;height:48px;display:flex;align-items:center;padding:0 16px;background:#f6f8fa;border-bottom:1px solid #ddd;z-index:1"><a href="/" aria-label="Homepage" style="display:inline-flex;width:32px;height:32px;align-items:center;justify-content:center"><svg class="octicon octicon-mark-github" width="32" height="32" viewBox="0 0 16 16"><circle cx="8" cy="8" r="8"/></svg></a></header><aside style="margin-top:49px"><nav><ul>${nav}</ul></nav></aside><main style="margin-top:49px">${main}</main></body></html>`;
}

// A local HTTP server the extension's service worker is pointed at (its fetch is redirected here), with CORS open.
export function serve(getWorld) {
  const srv = http.createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", () => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Headers", "*");
      if (req.method === "OPTIONS") return res.end();
      if (req.url.startsWith("/login")) return res.end("<!doctype html><title>Sign in</title>"); // where a signed-out redirect lands
      const target = decodeURIComponent(req.url.slice(1)); // /<full original url>
      let out;
      try {
        // This server only sees the service worker's requests (pages go through the browser's route).
        const world = getWorld();
        out = handle(world.signedInInTabsOnly ? Object.create(world, { signedIn: { value: false } }) : world, { url: target, method: req.method, body, headers: req.headers });
      } catch (e) {
        out = { status: 500, json: { message: String(e) } };
      }
      if (out.redirect) {
        res.statusCode = 302;
        res.setHeader("Location", out.redirect); // a path: lands on this server's /login, like GitHub's
        return res.end();
      }
      res.statusCode = out.status || 200;
      res.setHeader("Content-Type", out.html != null ? "text/html" : "application/json");
      res.end(out.html != null ? out.html : JSON.stringify(out.json));
    });
  });
  return new Promise((ok) => srv.listen(0, "127.0.0.1", () => ok({ port: srv.address().port, close: () => srv.close() })));
}
