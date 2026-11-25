// Hide non-contributors in the Assignees picker.
(() => {
  const ITEM = '[role="option"], [role="menuitemcheckbox"], [role="menuitemradio"], .select-menu-item, li[data-value]';
  const CTX = /assignee/i;
  let cache = { repo: null, set: null };

  async function allowedSet() {
    const repo = GHC.repo();
    if (!repo) return null;
    if (cache.repo === repo) return cache.set;
    // The repo's contributors (manual list, else GitHub's contributors graph with this browser's sign-in). If they
    // can't be read, don't hide anyone.
    const list = await GHC.contributors(repo).catch(() => null);
    if (!GHC.alive()) return null;
    cache = { repo, set: list && list.length ? new Set(list.map((c) => c.login.toLowerCase())) : null };
    return cache.set;
  }

  // Is this list item inside the assignees picker (as opposed to labels, reviewers...)?
  function inAssigneePicker(el) {
    for (let n = el, i = 0; n && i < 10; n = n.parentElement, i++) {
      const hints = [n.getAttribute?.("aria-label"), n.id, n.getAttribute?.("data-testid"), n.getAttribute?.("data-menu-id")];
      const labelledBy = n.getAttribute?.("aria-labelledby");
      if (labelledBy) hints.push(document.getElementById(labelledBy.split(" ")[0])?.textContent);
      if (hints.some((h) => h && CTX.test(h))) return true;
      const heading = n.querySelector?.(":scope > header, :scope > .select-menu-header, :scope > [class*='Header']");
      if (heading && CTX.test(heading.textContent)) return true;
    }
    return false;
  }

  function isSelected(el) {
    return el.getAttribute("aria-selected") === "true" || el.getAttribute("aria-checked") === "true" || !!el.querySelector("input:checked");
  }

  async function apply() {
    const allowed = await allowedSet();
    if (!allowed) return;
    for (const el of document.querySelectorAll(ITEM)) {
      if (!inAssigneePicker(el)) continue;
      const tokens = el.textContent.toLowerCase().split(/\s+/).filter(Boolean);
      const keep = isSelected(el) || tokens.some((t) => allowed.has(t));
      el.style.display = keep ? "" : "none";
    }
  }

  // The assignees picker doesn't exist on the diff view, and that page mutates constantly: don't scan it.
  const run = GHC.debounce(() => GHC.alive() && !GHC.isPullFiles() && apply(), 150);
  const mo = new MutationObserver(() => (GHC.alive() ? run() : mo.disconnect())); // extension reloaded: stop for good
  mo.observe(document.documentElement, { childList: true, subtree: true });
  document.addEventListener("turbo:load", () => (cache = { repo: null, set: null }));
})();
