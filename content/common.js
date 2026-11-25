// Shared helpers for all content scripts (same isolated world).
console.log('[companion] loaded on', location.href);
window.GHC = {
  repo() {
    const m = location.pathname.match(/^\/([^/]+)\/([^/]+)/);
    return m ? `${m[1]}/${m[2]}` : null;
  },
  isPullFiles() {
    return /^\/[^/]+\/[^/]+\/pull\/\d+\/(files|changes)/.test(location.pathname);
  },
  // False once the extension has been reloaded or removed: this copy of the script is orphaned and every chrome.*
  // call throws "Extension context invalidated". The new version injects fresh scripts on the next page load.
  alive() {
    try {
      return !!chrome.runtime?.id;
    } catch {
      return false;
    }
  },
  // Only links to this GitHub host: URLs come from stored data, never trust them blindly (e.g. a "javascript:" URL).
  safeUrl(u) {
    try {
      const url = new URL(u, location.href);
      return url.origin === location.origin ? url.href : "#";
    } catch {
      return "#";
    }
  },
  // A request to this GitHub as the page itself makes it (with its cookies). Firefox runs a content script's own fetch
  // as the extension; its content.fetch is the page's.
  fetch(url, init) {
    const href = new URL(url, location.href).href;
    return typeof content !== "undefined" && typeof content?.fetch === "function" ? content.fetch(href, init) : fetch(href, init);
  },
  debounce(fn, ms) {
    let t;
    return (...a) => {
      clearTimeout(t);
      t = setTimeout(() => fn(...a), ms);
    };
  },
  // The repo's contributors, most commits first, as [{ login, commits, avatar }]: the manual list from the options if
  // there is one, else GitHub's contributors graph (read with this browser's sign-in, no token). Used by the reviewers
  // and assignees pickers.
  // The avatar links in that graph carry a signed token that expires, so the list is cached for minutes, not a day
  // (a day-old list showed names without pictures). If GitHub can't be reached, the last list is better than none.
  contributors: (() => {
    const TTL = 10 * 60e3;
    const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
    const loading = new Map(); // repo -> { at, p: Promise<list> }
    async function load(repo) {
      const key = `contribWeb:${repo}`;
      const s = await chrome.storage.local.get(["repoContributors", key]);
      const manual = s.repoContributors?.[repo];
      if (manual?.length) return manual.map((login) => ({ login, commits: null, avatar: null }));
      if (s[key] && Date.now() - s[key].at < TTL) return s[key].list;
      let error = "GitHub is still computing them, try again in a moment";
      for (let attempt = 0; attempt < 4; attempt++) {
        const r = await GHC.fetch(`/${repo}/graphs/contributors-data`, { headers: { Accept: "application/json" }, credentials: "same-origin" }).catch((e) => ({ fetchError: e }));
        if (r.fetchError) {
          error = String(r.fetchError.message || r.fetchError);
          break;
        }
        if (r.status === 202) {
          await wait(1500); // GitHub is still computing the stats
          continue;
        }
        if (!r.ok) {
          error = String(r.status);
          break;
        }
        const list = (await r.json())
          .filter((c) => c?.author?.login)
          .map((c) => ({ login: c.author.login, commits: c.total, avatar: c.author.avatar }))
          .sort((a, b) => b.commits - a.commits);
        await chrome.storage.local.set({ [key]: { at: Date.now(), list } });
        return list;
      }
      if (s[key]) return s[key].list;
      throw new Error(`contributors: ${error}`);
    }
    return (repo) => {
      const hit = loading.get(repo);
      if (hit && Date.now() - hit.at < TTL) return hit.p;
      const p = load(repo).catch((e) => {
        if (loading.get(repo)?.p === p) loading.delete(repo);
        throw e;
      });
      loading.set(repo, { at: Date.now(), p });
      return p;
    };
  })(),
};
