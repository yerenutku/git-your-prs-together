// PR list pages (/pulls and /<owner>/<repo>/pulls):
// red counter on "Review requests", and "My threads" + "Re-review" in place of "Assigned to me".
// "Authored by me": count of my open PRs, a state per PR (sidebar list + chips on PR list rows).
(() => {
  const repoPulls = () => location.pathname.match(/^\/([^/]+\/[^/]+)\/pulls(\/|$)/)?.[1] || null;
  const onDashboard = () => /^\/pulls(\/|$)/.test(location.pathname) || !!repoPulls();
  const scopeKey = () => repoPulls()?.toLowerCase() || "*";
  const inScope = (repo) => scopeKey() === "*" || repo.toLowerCase() === scopeKey();
  const reduceMotion = matchMedia("(prefers-reduced-motion: reduce)");
  const VERSION = chrome.runtime.getManifest().version; // read once: chrome.* throws after an extension reload

  let counts = {}; // { query: { count, at } } from the background
  let threads = null; // { items, error, at }
  let reApprove = null; // { items, error, at }: PRs whose approval from me was dismissed
  let seen = {}; // { "owner/repo#12": ms }
  let shownMap = {}; // { scope: count the badge last displayed } (persisted, so an increase while away still animates)
  let allRepos = false; // panel toggle on a repo page
  let openOnly = true; // My threads: only open PRs (panel toggle, remembered)
  let authored = null; // { items, total, error, at }: my open PRs
  let pulsed = {}; // { "owner/repo#12": url of the newest unread comment the "new comments" marks already pulsed for }

  chrome.storage.local.get(["tabCounts", "myThreads", "reApprove", "threadSeen", "rrShown", "authored", "auPulsed", "threadsOpenOnly"]).then((s) => {
    pulsed = s.auPulsed || {};
    openOnly = s.threadsOpenOnly !== false;
    counts = s.tabCounts || {};
    threads = s.myThreads || null;
    reApprove = s.reApprove || null;
    authored = s.authored || null;
    seen = s.threadSeen || {};
    shownMap = s.rrShown && typeof s.rrShown === "object" ? s.rrShown : {};
    apply();
  });
  chrome.storage.onChanged.addListener((c) => {
    if (c.tabCounts) counts = c.tabCounts.newValue || {};
    if (c.myThreads) threads = c.myThreads.newValue;
    if (c.reApprove) reApprove = c.reApprove.newValue;
    if (c.threadSeen) seen = c.threadSeen.newValue || {};
    if (c.authored) authored = c.authored.newValue;
    if (c.tabCounts || c.myThreads || c.reApprove || c.threadSeen || c.authored) apply();
  });

  // ---------- finding GitHub's tabs (old subnav and the new sidebar) ----------

  const OURS = ".ghc-rr-badge, .ghc-threads-count, .ghc-threads-open, .ghc-au-count, .ghc-au-chip, #ghc-threads-panel, [data-ghc-threads]";
  const LABEL = {
    review: /^Review requests?( \d+)?$/i,
    assigned: /^Assigned( to me)?( \d+)?$/i,
    authored: /^(Authored|Created)( by me)?( \d+)?$/i,
  };
  const HREF = {
    review: /\/pulls\/review-requested\b|review-requested:@me/i,
    assigned: /\/pulls\/assigned\b|assignee:@me/i,
    authored: /\/pulls\/(authored|created)\b|author:@me/i,
  };

  const pathOf = (a) => {
    try {
      const u = new URL(a.getAttribute("href"), location.href);
      return u.origin === location.origin ? decodeURIComponent((u.pathname + u.search).replace(/\+/g, " ")) : "";
    } catch {
      return "";
    }
  };
  function ownText(el) {
    let t = "";
    const w = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) if (!n.parentElement.closest(OURS)) t += n.textContent;
    return t.replace(/\s+/g, " ").trim();
  }

  function findTab(kind) {
    const cands = [...document.querySelectorAll("a[href], button, [role='link'], [role='menuitem'], [role='tab']")].filter(
      (a) => a.textContent.length < 80 && !a.closest(OURS)
    );
    const byLabel = cands.filter((a) => LABEL[kind].test(ownText(a)));
    const nav = (a) => a.closest("nav, aside, ul, [role='tablist'], [role='navigation']");
    return byLabel.find(nav) || byLabel[0] || cands.find((a) => a.matches("a[href]") && HREF[kind].test(pathOf(a))) || null;
  }

  // The element that directly holds the tab's label text.
  // Only skips our badges: our own tabs are marked [data-ghc-threads] too, and their label must still be found.
  function labelEl(tab, word) {
    const w = document.createTreeWalker(tab, NodeFilter.SHOW_TEXT);
    for (let n; (n = w.nextNode()); ) if (n.textContent.includes(word) && !n.parentElement.closest(".ghc-rr-badge, .ghc-threads-count, .ghc-threads-open, .ghc-au-count")) return n.parentElement;
    return tab;
  }
  // Put `node` at the end of the label, so it stays on the label's line whatever layout the tab uses.
  function placeAfterLabel(tab, word, node) {
    labelEl(tab, word).appendChild(node);
  }

  // ---------- review-requests counter ----------

  let badge = null;
  let animating = false;
  let animShown = 0;
  let animTimer = null;

  // The search behind the tab itself, so the badge counts exactly what the tab lists.
  function tabQuery(tab) {
    let q = null;
    try {
      q = new URL(tab.getAttribute("href") || "", location.href).searchParams.get("q");
    } catch {}
    q ||= "is:pr is:open review-requested:@me";
    const repo = repoPulls();
    if (repo && !/(^|\s)repo:/.test(q)) q += ` repo:${repo}`;
    return q.replace(/\s+/g, " ").trim();
  }
  const asked = new Set();
  function rrCount(q) {
    if (!asked.has(q)) {
      asked.add(q);
      chrome.runtime.sendMessage({ type: "watchCount", q });
    }
    return counts[q]?.count ?? null;
  }

  // Primary source: the tab's own page. GitHub serves its data as JSON (with openCount) to the logged-in browser,
  // so this counts exactly what the tab lists, without needing the token to see the repo.
  const POLL_MS = 55_000;
  const live = {}; // href -> { count, error, at }
  const inflight = new Set();
  function findCount(o, depth = 0) {
    if (!o || typeof o !== "object" || depth > 5) return null;
    if (typeof o.openCount === "number") return o.openCount;
    for (const v of Object.values(o)) {
      if (Array.isArray(v)) continue;
      const n = findCount(v, depth + 1);
      if (n != null) return n;
    }
    return null;
  }
  async function fetchTabCount(href) {
    const r = await GHC.fetch(href, { headers: { Accept: "application/json" }, credentials: "same-origin" });
    if (!r.ok || !r.headers.get("content-type")?.includes("json")) throw new Error(`page data unavailable (${r.status})`);
    const n = findCount((await r.json()).payload);
    if (n == null) throw new Error("no openCount in page data");
    return n;
  }
  function pageCount(href) {
    const e = live[href];
    if ((!e || Date.now() - e.at > POLL_MS) && !inflight.has(href)) {
      inflight.add(href);
      fetchTabCount(href)
        .then((count) => (live[href] = { count, at: Date.now() }))
        .catch((err) => (live[href] = { error: String(err.message || err), at: Date.now() }))
        .finally(() => {
          inflight.delete(href);
          if (!GHC.alive()) return;
          renderBadge();
          renderAuthored();
        });
    }
    return e;
  }
  const pollTimer = setInterval(() => GHC.alive() && onDashboard() && !document.hidden && renderBadge(), POLL_MS + 1000);
  const onVisible = () => GHC.alive() && !document.hidden && onDashboard() && renderBadge();
  document.addEventListener("visibilitychange", onVisible);

  let lastLog = "";
  function renderBadge() {
    const tab = findTab("review");
    if (!tab) {
      if (lastLog !== "nf") console.log("[companion] review badge: tab NOT found"), (lastLog = "nf");
      return;
    }
    const href = tab.getAttribute("href");
    const page = href ? pageCount(href) : null;
    let target = page?.count ?? null;
    let source = href;
    let err = null;
    if (target == null && (!href || page?.error)) {
      // Fallback (e.g. the classic /pulls page): count through the API with the tab's search.
      const q = tabQuery(tab);
      target = rrCount(q);
      source = q;
      err = counts[q]?.error ? `${page?.error ? page.error + "; " : ""}${counts[q].error}` : null;
    }
    const why = `[companion] review badge: ${source} → ${target ?? (err ? "error " + err : "loading")}`;
    if (why !== lastLog) console.log((lastLog = why));
    const q = source;
    const key = q.toLowerCase();
    if (!badge) {
      badge = document.createElement("span");
      badge.className = "ghc-rr-badge";
      badge.innerHTML = '<span class="ghc-rr-num"></span>';
      const start = animating ? animShown : shownMap[key] ?? target;
      if (start != null) setNum(start, false);
    }
    // GitHub swaps the tab's link on every navigation: move the same badge (same number) into the new one.
    if (!tab.contains(badge)) placeAfterLabel(tab, "Review", badge);
    if (target == null && !err && shownMap[key] != null) {
      // Still counting after a reload: keep showing the last number rather than flashing "…".
      if (!animating) setNum(shownMap[key], false);
      badge.title = `Updating… ${q}`;
      return;
    }
    if (target == null) {
      // Never counted yet, or the count failed: say so instead of showing nothing.
      badge.querySelector(".ghc-rr-num").textContent = err ? "!" : "…";
      badge.classList.add("ghc-rr-zero");
      badge.title = err ? `Couldn't count review requests: ${err}\nSource: ${q}` : `Counting… ${q}`;
      return;
    }
    badge.title = `${target} open review request${target === 1 ? "" : "s"}`;
    if (animating) return;
    const shown = shownMap[key];
    if (shown == null || target === shown || reduceMotion.matches) setNum(target, false);
    else animateChange(shown, target);
    if (shown !== target) {
      shownMap = { ...shownMap, [key]: target };
      chrome.storage.local.set({ rrShown: shownMap });
    }
  }

  function setNum(n, roll) {
    const num = badge.querySelector(".ghc-rr-num");
    const text = n > 99 ? "99+" : String(n);
    if (num.textContent !== text) num.textContent = text; // writing unchanged text would wake our own MutationObserver
    badge.classList.toggle("ghc-rr-zero", n === 0);
    if (roll) restart(num, "ghc-roll");
  }

  function restart(el, cls) {
    el.classList.remove(cls);
    void el.offsetWidth; // reflow so the animation plays again
    el.classList.add(cls);
  }

  // Effects live in a fixed overlay on top of the badge, so the sidebar's overflow can't clip them.
  function overlay(life) {
    const r = badge.getBoundingClientRect();
    const fx = document.createElement("div");
    fx.className = "ghc-rr-fx";
    Object.assign(fx.style, { left: `${r.left}px`, top: `${r.top}px`, width: `${r.width}px`, height: `${r.height}px` });
    document.documentElement.appendChild(fx);
    setTimeout(() => fx.remove(), life);
    return fx;
  }

  // A "+N" (red) or "−N" (green) bubble flies in from the right; the number changes only once it has merged.
  function animateChange(from, to) {
    clearTimeout(animTimer);
    animating = true;
    animShown = from;
    setNum(from, false);
    const up = to > from;

    const bubble = document.createElement("span");
    bubble.className = `ghc-rr-bubble ${up ? "ghc-up" : "ghc-down"}`;
    bubble.textContent = `${up ? "+" : "−"}${Math.abs(to - from)}`;
    overlay(2000).appendChild(bubble);

    let merged = false;
    const merge = () => {
      if (merged) return;
      merged = true;
      clearTimeout(animTimer);
      bubble.remove();
      animating = false;
      animShown = to;
      if (badge?.isConnected) {
        setNum(to, true);
        restart(badge, "ghc-pulse");
        const ring = document.createElement("span");
        ring.className = `ghc-rr-ring ${up ? "ghc-up" : "ghc-down"}`;
        overlay(3200).appendChild(ring);
      }
      renderBadge(); // the count may have moved again meanwhile
    };
    bubble.addEventListener("animationend", merge, { once: true });
    animTimer = setTimeout(merge, 1500); // in case the animation never runs (hidden tab)
  }

  // ---------- our tabs ("My threads", "Re-review") ----------

  // Octicon path data for each tab's icon (built as DOM nodes, not HTML).
  const ICONS = {
    threads:
      "M1.75 1h8.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 10.25 10H7.061l-2.574 2.573A1.458 1.458 0 0 1 2 11.543V10h-.25A1.75 1.75 0 0 1 0 8.25v-5.5C0 1.784.784 1 1.75 1ZM1.5 2.75v5.5c0 .138.112.25.25.25h1a.75.75 0 0 1 .75.75v2.19l2.72-2.72a.749.749 0 0 1 .53-.22h3.5a.25.25 0 0 0 .25-.25v-5.5a.25.25 0 0 0-.25-.25h-8.5a.25.25 0 0 0-.25.25Zm13 2a.25.25 0 0 0-.25-.25h-.5a.75.75 0 0 1 0-1.5h.5c.966 0 1.75.784 1.75 1.75v5.5A1.75 1.75 0 0 1 14.25 12H14v1.543a1.458 1.458 0 0 1-2.487 1.03L9.22 12.28a.749.749 0 0 1 1.06-1.06l2.22 2.22v-2.19a.75.75 0 0 1 .75-.75h1a.25.25 0 0 0 .25-.25Z",
    reapprove:
      "M1.705 8.005a.75.75 0 0 1 .834.656 5.5 5.5 0 0 0 9.592 2.97l-1.204-1.204a.25.25 0 0 1 .177-.427h3.646a.25.25 0 0 1 .25.25v3.646a.25.25 0 0 1-.427.177l-1.38-1.38A7.002 7.002 0 0 1 1.05 8.84a.75.75 0 0 1 .656-.834ZM8 2.5a5.487 5.487 0 0 0-4.131 1.869l1.204 1.204A.25.25 0 0 1 4.896 6H1.25A.25.25 0 0 1 1 5.75V2.104a.25.25 0 0 1 .427-.177l1.38 1.38A7.002 7.002 0 0 1 14.95 7.16a.75.75 0 0 1-1.49.178A5.5 5.5 0 0 0 8 2.5Z",
  };
  const TABS = {
    threads: { label: "My threads", hash: "#my-threads", tip: "PRs where you commented: new replies, open and resolved threads" },
    reapprove: { label: "Re-review", hash: "#re-review", tip: "PRs you approved whose approval was dismissed (e.g. by a new push): approve again" },
  };
  const tabs = {}; // kind -> { host, link } (host: the cloned <li> in the sidebar, or the link itself in the old subnav)

  // Clone GitHub's "Assigned to me" entry into one of our tabs.
  function makeTab(source, kind) {
    const { label, hash, tip } = TABS[kind];
    const host = source.cloneNode(true);
    host.style.display = "";
    host.setAttribute("data-ghc-threads", kind);
    const link = host.matches("a, button") ? host : host.querySelector("a, button, [role='link']") || host;
    if (link.matches("a")) link.setAttribute("href", hash);
    for (const e of [host, ...host.querySelectorAll("*")]) {
      for (const attr of ["id", "aria-current", "aria-selected", "data-hotkey", "data-turbo-frame", "data-selected-links", "data-pjax", "aria-labelledby", "aria-describedby"]) e.removeAttribute(attr);
      e.classList.remove("selected");
    }
    for (const svg of host.querySelectorAll("svg")) {
      svg.setAttribute("viewBox", "0 0 16 16");
      const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
      path.setAttribute("d", ICONS[kind]);
      svg.replaceChildren(path);
    }
    // First piece of text becomes the label; other text (GitHub counters) goes.
    const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
    let first = true;
    for (let t; (t = walker.nextNode()); ) {
      if (!t.textContent.trim()) continue;
      t.textContent = first ? label : "";
      first = false;
    }
    for (const c of host.querySelectorAll("[title]")) c.setAttribute("title", label); // GitHub's truncation tooltip
    for (const c of host.querySelectorAll(".Counter, [class*='CounterLabel'], [class*='TrailingVisual']")) c.remove();
    if (kind === "threads") {
      // Grey: open PRs I take part in (like GitHub's own tab counters). The blue count after it: those with new replies.
      const open = document.createElement("span");
      open.className = "ghc-threads-open";
      open.hidden = true;
      placeAfterLabel(link, label, open);
    }
    const count = document.createElement("span");
    count.className = "ghc-threads-count";
    count.hidden = true;
    placeAfterLabel(link, label, count);
    link.title = tip;
    link.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel(kind);
    });
    return { host, link };
  }

  function installTab() {
    const assigned = findTab("assigned");
    if (!assigned) return;
    const source = assigned.closest("li") || assigned;
    if (source.style.display !== "none") source.style.display = "none";
    // Our tabs go right below "Review requests" (next to "Assigned to me" if that can't be found).
    const review = findTab("review");
    const reviewHost = review && (review.closest("li") || review);
    let prev = reviewHost?.parentElement === source.parentElement ? reviewHost : source;
    for (const kind of Object.keys(TABS)) {
      const t = tabs[kind];
      if (!t?.host.isConnected || t.host.previousElementSibling !== prev) {
        t?.host.remove();
        tabs[kind] = makeTab(source, kind);
        prev.after(tabs[kind].host);
      }
      prev = tabs[kind].host;
    }
  }

  // Compact list of the PRs to approve again, right under the "Re-review" tab (sidebar layout only).
  const SIDE_MAX = 8;
  let sideList = null;

  function filesLabel(since) {
    if (!since) return null;
    const n = since.files;
    return `${since.approx ? "~" : ""}${n} file${n === 1 ? "" : "s"}`;
  }
  function filesTip(since) {
    if (!since) return "";
    const head = `${since.files} file${since.files === 1 ? "" : "s"} differ from the commit you approved (${since.commits} new commit${since.commits === 1 ? "" : "s"})`;
    const approx = since.approx ? "\nRebased or merged with the base branch since: only files that are part of the PR are counted." : "";
    const more = since.files > since.paths.length ? `\n…and ${since.files - since.paths.length} more` : "";
    return `${head}${approx}\n\n${since.paths.join("\n")}${more}`;
  }
  const sinceHref = (i) => (i.approvedSha && i.headSha ? `${i.url}/files/${i.approvedSha}..${i.headSha}` : `${i.url}/files`);

  function renderSideList() {
    const host = tabs.reapprove?.host;
    const items = host?.matches("li") ? scopedItems("reapprove", false) : [];
    if (!items.length) {
      sideList?.remove();
      sideList = null;
      return;
    }
    const sig = JSON.stringify(items.map((i) => [i.key, i.title, i.since?.files, i.since?.approx, i.headSha]));
    if (sideList?.isConnected && sideList.previousElementSibling === host && sideList.dataset.sig === sig) return;
    sideList?.remove();
    sideList = document.createElement("li");
    sideList.className = "ghc-side";
    sideList.setAttribute("data-ghc-threads", "reapprove-list");
    sideList.dataset.sig = sig;
    const ul = el("ul", "ghc-side-list");
    ul.setAttribute("aria-label", "PRs to approve again");
    for (const i of items.slice(0, SIDE_MAX)) {
      const a = el("a", "ghc-side-row");
      a.href = GHC.safeUrl(sinceHref(i));
      a.title = `${i.repo}#${i.number} ${i.title}\nby ${i.author}`;
      const meta = el("span", "ghc-side-meta");
      meta.append(el("span", "ghc-side-num", `#${i.number}`));
      const label = filesLabel(i.since);
      if (label) {
        const l = el("span", "ghc-side-label", label);
        l.title = filesTip(i.since);
        meta.append(l);
      }
      a.append(el("span", "ghc-side-title", i.title), meta);
      const li = el("li");
      li.append(a);
      ul.append(li);
    }
    if (items.length > SIDE_MAX) {
      const more = el("button", "ghc-side-more", `+${items.length - SIDE_MAX} more`);
      more.onclick = () => togglePanel("reapprove");
      const li = el("li");
      li.append(more);
      ul.append(li);
    }
    sideList.append(ul);
    host.after(sideList);
  }

  // ---------- thread status ----------

  const seenAt = (key) => seen[key] || 0;
  const unread = (item, replies) => replies.filter((r) => Date.parse(r.at) > seenAt(item.key));

  function status(item) {
    const convoNew = item.convo ? unread(item, item.convo.replies) : [];
    let newCount = convoNew.length;
    let firstNew = convoNew[0]?.url || null;
    let open = 0;
    let resolved = 0;
    for (const t of item.threads) {
      const n = unread(item, t.replies);
      newCount += n.length;
      if (n.length && !firstNew) firstNew = n[0].url;
      if (t.resolved) resolved++;
      else open++;
    }
    return { newCount, firstNew, open, resolved };
  }

  const DATA = { threads: () => threads, reapprove: () => reApprove };
  const isOpen = (i) => (i.state || "OPEN") === "OPEN";
  const scopedItems = (kind, all) =>
    (DATA[kind]()?.items || []).filter((i) => (all || inScope(i.repo)) && (kind !== "threads" || !openOnly || isOpen(i)));

  function setCount(kind, n, what) {
    const c = tabs[kind]?.host.querySelector(".ghc-threads-count");
    if (!c || c.textContent === String(n)) return;
    c.textContent = String(n);
    c.hidden = n === 0;
    c.title = `${n} PR${n === 1 ? "" : "s"} ${what}`;
  }
  function renderOpenCount() {
    const c = tabs.threads?.host.querySelector(".ghc-threads-open");
    if (!c) return;
    const n = (threads?.items || []).filter((i) => inScope(i.repo) && isOpen(i)).length;
    if (c.textContent === String(n)) return;
    c.textContent = String(n);
    c.hidden = !threads?.items;
    c.title = `${n} open PR${n === 1 ? "" : "s"} you commented on or reviewed (last 3 weeks)`;
  }
  function renderCount() {
    renderOpenCount();
    setCount("threads", scopedItems("threads", false).filter((i) => status(i).newCount > 0).length, "with new replies");
    setCount("reapprove", scopedItems("reapprove", false).length, "to approve again");
  }

  // ---------- panel ----------

  let panel = null;
  let panelKind = null;

  function togglePanel(kind) {
    const wasOpen = panelKind;
    closePanel();
    if (wasOpen === kind || !tabs[kind]) return;
    panelKind = kind;
    panel = document.createElement("div");
    panel.id = "ghc-threads-panel";
    panel.setAttribute("role", "dialog");
    panel.setAttribute("aria-label", TABS[kind].label);
    document.documentElement.appendChild(panel);
    position(tabs[kind].link);
    renderPanel();
    chrome.runtime.sendMessage({ type: "refresh", force: true });
    setTimeout(() => {
      document.addEventListener("mousedown", outside, true);
      document.addEventListener("keydown", esc, true);
    });
    addEventListener("resize", closePanel, { once: true });
  }
  function closePanel() {
    panel?.remove();
    panel = null;
    panelKind = null;
    document.removeEventListener("mousedown", outside, true);
    document.removeEventListener("keydown", esc, true);
  }
  // Clicks on our tabs are left to their own handlers (which switch or close the panel).
  const outside = (e) => panel && !panel.contains(e.target) && !Object.values(tabs).some((t) => t.host.contains(e.target)) && closePanel();
  const esc = (e) => e.key === "Escape" && closePanel();

  // Beside the tab when it sits in a sidebar, under it otherwise.
  function position(anchor) {
    const r = anchor.getBoundingClientRect();
    const w = Math.min(620, innerWidth - 32);
    panel.style.width = `${w}px`;
    if (r.right + 12 + w <= innerWidth - 16 && r.left < innerWidth / 3) {
      panel.style.left = `${Math.round(r.right + 12 + scrollX)}px`;
      panel.style.top = `${Math.round(Math.max(r.top - 8, 16) + scrollY)}px`;
    } else {
      panel.style.left = `${Math.round(Math.max(16, Math.min(r.left, innerWidth - w - 16)) + scrollX)}px`;
      panel.style.top = `${Math.round(r.bottom + 6 + scrollY)}px`;
    }
  }

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };

  function ago(ms) {
    const s = Math.round((Date.now() - ms) / 1000);
    if (s < 60) return "just now";
    if (s < 3600) return `${Math.round(s / 60)}m ago`;
    if (s < 86400) return `${Math.round(s / 3600)}h ago`;
    return `${Math.round(s / 86400)}d ago`;
  }

  // Header, token / error notices. Returns false when there is nothing more to show.
  function panelHead(title, data, showAll, repo, extra) {
    const head = el("div", "ghc-tp-head");
    head.append(el("strong", null, showAll ? title : `${title} in ${repo.split("/")[1]}`));
    const right = el("span", "ghc-tp-meta", data?.at ? `updated ${ago(data.at)}` : "loading…");
    if (repo) {
      const t = el("button", "ghc-tp-toggle", allRepos ? "This repo" : "All repos");
      t.onclick = () => {
        allRepos = !allRepos;
        renderPanel();
      };
      right.append(" · ", t);
    }
    if (extra) right.append(" · ", extra);
    head.append(right);
    panel.append(head);
    if (data?.error === "no-token") {
      panel.append(el("p", "ghc-tp-empty", "Add a personal access token in the Git Your PRs Together options to use this tab."));
      return false;
    }
    if (data?.error) panel.append(el("p", "ghc-tp-error", `Last refresh failed: ${data.error}`));
    return true;
  }

  function row(href, title, isDraft, state, subText, chipList, unreadRow, onClick) {
    const li = el("li", unreadRow ? "ghc-tp-row ghc-tp-unread" : "ghc-tp-row");
    const a = el("a", "ghc-tp-link");
    a.href = GHC.safeUrl(href);
    if (onClick) a.addEventListener("click", onClick);
    const top = el("div", "ghc-tp-top");
    top.append(el("span", "ghc-tp-title", title));
    if (state && state !== "OPEN") top.append(el("span", `ghc-tp-state ghc-tp-${state.toLowerCase()}`, state === "MERGED" ? "Merged" : "Closed"));
    else if (isDraft) top.append(el("span", "ghc-tp-state ghc-tp-draft", "Draft"));
    const sub = el("div", "ghc-tp-sub");
    sub.append(el("span", "ghc-tp-repo", subText));
    const chips = el("span", "ghc-tp-chips");
    for (const [cls, text, tip] of chipList) {
      const c = el("span", `ghc-tp-chip ${cls}`, text);
      if (tip) c.title = tip;
      chips.append(c);
    }
    sub.append(chips);
    a.append(top, sub);
    li.append(a);
    return li;
  }

  function renderPanel() {
    if (!panel) return;
    panel.replaceChildren();
    const repo = repoPulls();
    const showAll = !repo || allRepos;
    if (panelKind === "reapprove") renderReApprove(repo, showAll);
    else renderThreads(repo, showAll);
  }

  function renderThreads(repo, showAll) {
    // Open only, or also merged / closed PRs (remembered).
    const filter = el("button", "ghc-tp-toggle ghc-tp-open-only", openOnly ? "Show closed too" : "Open only");
    filter.title = openOnly ? "Also list merged and closed PRs" : "List only open PRs";
    filter.onclick = () => {
      openOnly = !openOnly;
      chrome.storage.local.set({ threadsOpenOnly: openOnly });
      renderCount();
      renderPanel();
    };
    if (!panelHead(openOnly ? "My threads (open)" : "My threads", threads, showAll, repo, filter)) return;
    const items = scopedItems("threads", showAll)
      .map((i) => ({ i, s: status(i) }))
      .sort((a, b) => (b.s.newCount > 0) - (a.s.newCount > 0) || (b.s.open > 0) - (a.s.open > 0) || b.i.updatedAt.localeCompare(a.i.updatedAt));

    if (!items.length) {
      if (threads) panel.append(el("p", "ghc-tp-empty", `No ${openOnly ? "open " : ""}PRs you commented on${showAll ? "" : " in this repo"} in the last 3 weeks.`));
      return;
    }

    const list = el("ul", "ghc-tp-list");
    for (const { i, s } of items) {
      const chips = [];
      if (s.newCount) chips.push(["ghc-tp-chip-new", `${s.newCount} new repl${s.newCount === 1 ? "y" : "ies"}`]);
      if (s.open) chips.push(["ghc-tp-chip-open", `${s.open} open`]);
      if (s.resolved) chips.push(["ghc-tp-chip-resolved", `✓ ${s.resolved} resolved`]);
      if (!i.threads.length && !s.newCount) chips.push(["ghc-tp-chip-open", "commented"]);
      list.append(
        row(s.firstNew || i.url, i.title, i.isDraft, i.state, `${showAll ? i.repo : ""}#${i.number} · ${i.author}`, chips, s.newCount > 0, () =>
          chrome.runtime.sendMessage({ type: "prSeen", key: i.key })
        )
      );
    }
    panel.append(list);
  }

  function renderReApprove(repo, showAll) {
    if (!panelHead("Re-review", reApprove, showAll, repo)) return;
    const items = scopedItems("reapprove", showAll);
    if (!items.length) {
      if (reApprove) panel.append(el("p", "ghc-tp-empty", `No dismissed approvals${showAll ? "" : " in this repo"}: nothing to approve again.`));
      return;
    }
    const list = el("ul", "ghc-tp-list");
    for (const i of items) {
      // Straight to "changes since my approval" when we know both commits.
      const href = sinceHref(i);
      const when = i.dismissedAt ? ` ${ago(Date.parse(i.dismissedAt))}` : "";
      const who = i.dismissedBy && i.dismissedBy !== i.author ? ` by ${i.dismissedBy}` : "";
      const chips = [["ghc-tp-chip-new", `approval dismissed${when}`, `You approved ${i.approvedSha?.slice(0, 7) || ""} ${i.approvedAt ? ago(Date.parse(i.approvedAt)) : ""}; dismissed${who}${when}`]];
      const label = filesLabel(i.since);
      if (label) chips.unshift(["ghc-tp-chip-open", label, filesTip(i.since)]);
      list.append(row(href, i.title, i.isDraft, "OPEN", `${showAll ? i.repo : ""}#${i.number} · ${i.author}`, chips, true));
    }
    panel.append(list);
  }

  // ---------- "Authored by me": count of my open PRs, one state each ----------
  // States come from GHCState.authoredState (content/prstate.js), shared with the notifications.

  // My open PRs with their state. The background worker reads them from GitHub's own page data with this browser's
  // sign-in (or with the token), see session-source.js.
  const authoredItems = () => authored?.items || [];

  const AU_SIDE_MAX = 8;
  const AU_SHORT = { attention: "New comments", ready: "Ready to merge", their: "Their turn", progress: "In progress" };
  let auList = null;

  const prPath = (url) => {
    try {
      return new URL(url, location.href).pathname.replace(/\/$/, "").toLowerCase();
    } catch {
      return "";
    }
  };
  const auSorted = (all) =>
    authoredItems()
      .filter((i) => all || inScope(i.repo))
      .map((i) => ({ i, s: GHCState.authoredState(i, seenAt(i.key)) }))
      .sort((a, b) => a.s.order - b.s.order || b.i.updatedAt.localeCompare(a.i.updatedAt));
  const auChipText = (s) =>
    s.state === "attention"
      ? `${s.fresh.length} new comment${s.fresh.length === 1 ? "" : "s"}`
      : s.state === "ready" && s.fresh.length
        ? `${AU_SHORT.ready} · ${s.fresh.length} new`
        : AU_SHORT[s.state];
  // The "new comments" marks pulse a few times when a comment is new to me, then stay still (also on later page loads),
  // until a newer comment arrives. CSS plays the animation 3 times; .ghc-still switches it off.
  const newest = (s) => s.fresh.reduce((m, a) => (Date.parse(a.at) > Date.parse(m.at) ? a : m), s.fresh[0]);
  const pulsing = (i, s) => s.fresh.length > 0 && pulsed[i.key] !== newest(s).url;
  let pulseTimer = null;
  function settlePulses(rows) {
    if (pulseTimer || !rows.some(({ i, s }) => pulsing(i, s))) return;
    pulseTimer = setTimeout(() => {
      pulseTimer = null;
      if (!GHC.alive()) return;
      const next = {};
      for (const { i, s } of auSorted(true)) if (s.fresh.length) next[i.key] = newest(s).url;
      pulsed = next;
      chrome.storage.local.set({ auPulsed: next });
      renderAuthored();
    }, 4000); // the 3 pulses
  }
  const auTip = (i, s) => `${i.repo}#${i.number} ${i.title}\n${s.label}: ${s.reason}`;

  function renderAuthored() {
    const tab = findTab("authored");
    const rows = auSorted(false);
    if (tab) renderAuthoredCount(tab, rows);
    settlePulses(rows);
    renderAuthoredSide(tab, rows);
    renderAuthoredRows();
  }

  // Count badge on the tab: all my open PRs, counted by GitHub's own page (your logged-in session).
  // Green when one is ready to merge, red and pulsing while one has new comments.
  function renderAuthoredCount(tab, rows) {
    let c = tab.querySelector(".ghc-au-count");
    const href = tab.getAttribute("href");
    const page = href ? pageCount(href) : null;
    const total = page?.count ?? (rows.length || null);
    if (total == null && !page?.error && !authored?.error) return c?.remove();
    if (!c) {
      c = el("span", "ghc-au-count");
      placeAfterLabel(tab, ownText(tab).split(" ")[0] || "Authored", c);
    }
    // Only when GitHub's own data failed too: some PRs have no state.
    const missing = !!authored?.at && total != null && rows.length < total;
    const text = total == null ? "!" : missing ? `${total} ⚠` : String(total);
    if (c.textContent !== text) c.textContent = text;
    const by = (st) => rows.filter((r) => r.s.state === st).length;
    const attn = by("attention");
    // Red whenever something unread waits for me, also on a PR that is otherwise ready to merge.
    const unreadPrs = rows.filter((r) => r.s.fresh.length).length;
    c.classList.toggle("ghc-au-warn", missing || total == null);
    c.classList.toggle("ghc-au-hot", unreadPrs > 0);
    c.classList.toggle("ghc-still", !rows.some(({ i, s }) => pulsing(i, s)));
    c.classList.toggle("ghc-au-allready", !unreadPrs && !missing && by("ready") > 0);
    const v = VERSION;
    const states = Object.keys(AU_SHORT)
      .map((st) => [by(st), GHCState.STATES[st].label])
      .filter(([n]) => n)
      .map(([n, l]) => `${n} · ${l}`)
      .join("\n");
    c.title =
      total == null
        ? `Couldn't count your PRs: ${page?.error || authored?.error}\nGit Your PRs Together ${v}`
        : `${total} open PR${total === 1 ? "" : "s"} by you  ·  Git Your PRs Together ${v}\n${states}` +
          (missing ? `\nNo state for ${total - rows.length}: ${authored?.error || "GitHub didn't return their status"}` : "");
  }

  // Compact list of my PRs right under the tab (sidebar layout only), with each PR's state.
  function renderAuthoredSide(tab, rows) {
    const host = tab?.closest("li");
    if (!host || !rows.length) {
      auList?.remove();
      auList = null;
      return;
    }
    const sig = JSON.stringify(rows.slice(0, AU_SIDE_MAX + 1).map(({ i, s }) => [i.key, i.title, s.state, s.reason, s.fresh[0]?.url, pulsing(i, s)]));
    if (auList?.isConnected && auList.previousElementSibling === host && auList.dataset.sig === sig) return;
    auList?.remove();
    auList = el("li", "ghc-side ghc-au-side");
    auList.setAttribute("data-ghc-threads", "authored-list");
    auList.dataset.sig = sig;
    const ul = el("ul", "ghc-side-list");
    ul.setAttribute("aria-label", "Your open PRs and their state");
    for (const { i, s } of rows.slice(0, AU_SIDE_MAX)) {
      const a = el("a", `ghc-side-row ghc-au-row ghc-au-${s.state}${pulsing(i, s) ? "" : " ghc-still"}`);
      a.href = GHC.safeUrl(s.fresh[0]?.url || i.url);
      a.title = auTip(i, s);
      const meta = el("span", "ghc-side-meta");
      meta.append(el("span", "ghc-side-num", `#${i.number}`), el("span", `ghc-au-state ghc-au-${s.state}${pulsing(i, s) ? "" : " ghc-still"}`, auChipText(s)));
      a.append(el("span", "ghc-side-title", i.title), meta);
      const li = el("li");
      li.append(a);
      ul.append(li);
    }
    if (rows.length > AU_SIDE_MAX) {
      const more = el("a", "ghc-side-more", `+${rows.length - AU_SIDE_MAX} more`);
      more.href = "/pulls/authored";
      const li = el("li");
      li.append(more);
      ul.append(li);
    }
    auList.append(ul);
    host.after(auList);
  }

  // A state chip on every one of my PRs in GitHub's own lists (Authored by me, Inbox, repo PR lists).
  const LIST_TITLE = "a[data-testid='listitem-title-link'], a.js-navigation-open[data-hovercard-type='pull_request']";
  function renderAuthoredRows() {
    const byPath = new Map(authoredItems().map((i) => [prPath(i.url), i]));
    for (const a of document.querySelectorAll(LIST_TITLE)) {
      const row = a.closest("li, [role='row'], .js-issue-row");
      if (!row) continue;
      const i = byPath.get(prPath(a.href));
      let chip = row.querySelector(".ghc-au-chip");
      if (!i) {
        chip?.remove();
        row.classList.remove("ghc-au-row-hot");
        continue;
      }
      const s = GHCState.authoredState(i, seenAt(i.key));
      if (!chip) {
        chip = el("span", "ghc-au-chip");
        const slot = row.querySelector("[class*='trailingBadgesContainer']");
        if (slot) slot.append(chip);
        else a.after(chip);
      }
      const text = auChipText(s);
      if (chip.dataset.state !== s.state) chip.className = `ghc-au-chip ghc-au-${s.state}`;
      chip.dataset.state = s.state;
      if (chip.textContent !== text) chip.textContent = text;
      chip.title = `${s.label}: ${s.reason}`;
      row.classList.toggle("ghc-au-row-hot", s.fresh.length > 0);
      chip.classList.toggle("ghc-still", !pulsing(i, s));
      row.classList.toggle("ghc-still", !pulsing(i, s));
    }
  }

  // ---------- wiring ----------

  function apply() {
    if (!onDashboard()) return;
    renderBadge();
    installTab();
    renderSideList();
    renderAuthored();
    renderCount();
    renderPanel();
  }

  // Opening a PR marks its replies as read.
  let lastPr = null;
  function trackPr() {
    const m = location.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    const key = m ? `${m[1]}#${m[2]}` : null;
    if (key && key !== lastPr) chrome.runtime.sendMessage({ type: "prSeen", key });
    lastPr = key;
  }
  trackPr();

  let lastPath = location.pathname;
  const run = GHC.debounce(() => {
    if (!GHC.alive()) return;
    trackPr();
    if (location.pathname !== lastPath) {
      lastPath = location.pathname;
      closePanel();
    }
    if (!onDashboard()) return;
    renderBadge();
    installTab();
    renderSideList();
    renderAuthored();
    renderCount();
  }, 120);
  // Put our badge back before the browser paints (a mutation callback runs before the next frame), so it never blinks.
  // Everything else waits for the page to settle.
  const observer = new MutationObserver(() => {
    if (!GHC.alive()) return shutdown();
    if (GHC.isPullFiles()) return;
    if (badge && !badge.isConnected && onDashboard()) renderBadge();
    run();
  });
  observer.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("turbo:load", run);
  // Extension reloaded: this copy of the script is orphaned. Stop reacting to the page; the new version takes over
  // on the next page load (what it drew stays until then).
  function shutdown() {
    observer.disconnect();
    clearInterval(pollTimer);
    document.removeEventListener("visibilitychange", onVisible);
    document.removeEventListener("turbo:load", run);
    console.log("[companion] extension was reloaded: this tab's old copy stopped; reload the page for the new version");
  }
  for (const kind of Object.keys(TABS)) if (location.hash === TABS[kind].hash) setTimeout(() => tabs[kind] && togglePanel(kind), 800);
})();
