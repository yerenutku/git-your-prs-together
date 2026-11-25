// Reviewers picker on a PR: the repo's contributors instead of the whole company, with their own search box, and
// "Show all users from the company" as the last item (GitHub's own list, unchanged).
//
// GitHub's picker (a Primer SelectPanel) lists ~10 people alphabetically and searches the whole company as you
// type, so most contributors never show up in it. Our list sits in the same panel; picking someone drives GitHub's
// picker (search their login, click GitHub's own entry), so the request goes through GitHub exactly as by hand.
//
// Careful: when the panel closes, GitHub saves only the selected people visible in its (filtered) list. Closing it
// with text in its search box removes every requested reviewer the search hides (this removed 4 reviewers from a
// real PR on 2026-11-17). So: our list has its own search box and GitHub's stays empty; after picking we clear
// GitHub's search and wait for its full list; and closing with text in GitHub's search first clears it.
(() => {
  const INPUT = "input[aria-label='Filter reviewers']";
  const OPTION = "li[role='option'][data-id]";
  const me = () => document.querySelector('meta[name="user-login"]')?.content || "";
  const lc = (s) => (s || "").toLowerCase();

  const contributors = (repo) => GHC.contributors(repo); // shared with the assignees picker (content/common.js)

  const el = (tag, cls, text) => {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
  };
  const setInput = (input, value) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  };
  const wait = (ms) => new Promise((ok) => setTimeout(ok, ms));
  async function waitFor(f, ms) {
    for (const end = Date.now() + ms; Date.now() < end; await wait(60)) {
      const v = f();
      if (v) return v;
    }
    return null;
  }
  const options = (dialog) => [...dialog.querySelectorAll(OPTION)];
  const optionOf = (dialog, login) => options(dialog).find((o) => lc(o.dataset.id) === lc(login));
  const isOn = (o) => o?.getAttribute("aria-selected") === "true";

  // Empty GitHub's search and wait until its list is the full one again (what it saves on close): GitHub re-renders
  // a moment after the search changes, so wait for the list to change and then hold still, with every reviewer we
  // know is requested in it.
  const listSig = (dialog) => options(dialog).map((o) => `${o.dataset.id}:${isOn(o)}`).join(",");
  async function clearGithubSearch(dialog, input, st) {
    st.settling = true;
    try {
      const before = listSig(dialog);
      const changes = !!input.value;
      if (changes) setInput(input, "");
      let sig = listSig(dialog);
      let since = Date.now();
      let changed = !changes;
      await waitFor(() => {
        const now = listSig(dialog);
        if (now !== sig) (sig = now), (since = Date.now());
        if (now !== before) changed = true;
        return changed && Date.now() - since >= 300 && [...st.selected].every((id) => isOn(optionOf(dialog, id)));
      }, 4000);
    } finally {
      st.settling = false;
    }
  }

  const panels = new Map(); // dialog -> state

  function setup(input) {
    const dialog = input.closest("[role='dialog']");
    if (!dialog || panels.has(dialog)) return;
    const st = { dialog, input, mode: "contrib", selected: new Set(), list: null, error: null, busy: null, settling: false, note: null, q: "", closing: false };
    panels.set(dialog, st);
    syncSelected(st);
    contributors(GHC.repo())
      .then((list) => (st.list = list))
      .catch((e) => ((st.error = String(e.message || e)), (st.mode = "all")))
      .finally(() => render(st));
    render(st);
  }

  // Who is requested: GitHub's list shows them (selected) while its search is empty.
  function syncSelected(st) {
    if (st.busy || st.settling || st.input.value) return false;
    const now = new Set(options(st.dialog).filter(isOn).map((o) => o.dataset.id));
    const same = now.size === st.selected.size && [...now].every((id) => st.selected.has(id));
    if (!same) st.selected = now;
    return !same;
  }

  function render(st) {
    const { dialog, input } = st;
    dialog.dataset.ghcRv = st.mode;
    const listbox = dialog.querySelector("ul[role='listbox']");
    let box = dialog.querySelector(".ghc-rv");
    if (!box) {
      box = el("div", "ghc-rv");
      if (listbox) listbox.before(box);
      else input.closest("div")?.after(box);
    } else if (listbox && box.nextElementSibling !== listbox) {
      listbox.before(box); // GitHub re-rendered its list: stay right above it
    }
    // GitHub's search box is hidden while our list (with its own search box) is shown.
    const wrap = input.parentElement;
    if (wrap) wrap.dataset.ghcRvInput = "";

    const hadFocus = document.activeElement?.classList.contains("ghc-rv-search");
    box.replaceChildren();

    if (st.mode === "all") {
      if (st.error) box.append(el("div", "ghc-rv-note", `Couldn't load the contributors (${st.error}): showing everyone.`));
      else {
        const back = el("button", "ghc-rv-mode", "← Only contributors");
        back.type = "button";
        back.title = "List only the people who contributed to this repository";
        back.onclick = async () => {
          await clearGithubSearch(dialog, input, st);
          st.mode = "contrib";
          render(st);
          box.querySelector(".ghc-rv-search")?.focus();
        };
        box.append(back);
      }
      return;
    }

    const search = el("input", "ghc-rv-search");
    search.type = "text";
    search.placeholder = "Search contributors";
    search.setAttribute("aria-label", "Search contributors");
    search.value = st.q;
    search.oninput = () => {
      st.q = search.value;
      renderList(st, box.querySelector(".ghc-rv-body"));
    };
    search.onkeydown = (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      box.querySelector(".ghc-rv-item")?.click(); // first match
    };
    const repo = GHC.repo() || "";
    box.append(search, el("div", "ghc-rv-head", `Contributors of ${repo.split("/")[1] || repo}`));
    const body = el("div", "ghc-rv-body");
    box.append(body);
    renderList(st, body);

    const all = el("button", "ghc-rv-mode ghc-rv-all", "Show all users from the company");
    all.type = "button";
    all.title = "GitHub's own list: everyone you can request a review from";
    all.onclick = () => {
      st.mode = "all";
      render(st);
      input.focus();
    };
    box.append(all);
    if (hadFocus || document.activeElement === input || document.activeElement === document.body) search.focus();
  }

  function renderList(st, body) {
    if (!body) return;
    body.replaceChildren();
    if (!st.list) return body.append(el("div", "ghc-rv-note", "Loading contributors…"));
    const q = lc(st.q.trim());
    const contrib = st.list.filter((c) => lc(c.login) !== lc(me()));
    const known = new Set(contrib.map((c) => lc(c.login)));
    // Requested reviewers who aren't contributors (e.g. a team) stay visible, so they can be removed here too.
    const others = [...st.selected].filter((id) => !known.has(lc(id))).map((login) => ({ login, commits: null, avatar: null }));
    const shown = [...others, ...contrib].filter((c) => !q || lc(c.login).includes(q));
    const ul = el("ul", "ghc-rv-list");
    for (const c of shown) {
      const on = [...st.selected].some((id) => lc(id) === lc(c.login));
      const b = el("button", `ghc-rv-item${on ? " ghc-rv-on" : ""}${st.busy === c.login ? " ghc-rv-busy" : ""}`);
      b.type = "button";
      b.setAttribute("aria-pressed", String(on));
      b.dataset.login = c.login;
      b.append(el("span", "ghc-rv-check", on ? "✓" : ""));
      if (c.avatar) {
        const img = el("img", "ghc-rv-avatar");
        img.src = c.avatar;
        img.alt = "";
        img.onerror = () => (img.style.visibility = "hidden"); // an expired link: keep the row aligned, no broken-image icon
        b.append(img);
      }
      b.append(el("span", "ghc-rv-login", c.login));
      if (c.commits != null) b.append(el("span", "ghc-rv-meta", `${c.commits} commit${c.commits === 1 ? "" : "s"}`));
      b.onclick = () => toggle(st, c.login);
      const li = el("li");
      li.append(b);
      ul.append(li);
    }
    if (!shown.length) body.append(el("div", "ghc-rv-note", q ? `No contributor matches "${st.q.trim()}".` : "No contributors found."));
    body.append(ul);
    if (st.note) body.append(el("div", "ghc-rv-note ghc-rv-warn", st.note));
  }

  // Request (or remove) a reviewer through GitHub's own picker.
  async function toggle(st, login) {
    if (st.busy) return;
    const { dialog, input } = st;
    st.busy = login;
    st.note = null;
    renderList(st, dialog.querySelector(".ghc-rv-body"));
    setInput(input, login);
    const opt = await waitFor(() => input.value === login && optionOf(dialog, login), 5000);
    if (opt) {
      const want = !isOn(opt);
      opt.click();
      const ok = await waitFor(() => isOn(optionOf(dialog, login)) === want, 1500);
      for (const id of [...st.selected]) if (lc(id) === lc(login)) st.selected.delete(id);
      if (ok ? want : isOn(optionOf(dialog, login))) st.selected.add(opt.dataset.id);
    } else {
      st.note = `GitHub doesn't offer ${login} as a reviewer here (no access to the repository, or the PR's author).`;
    }
    await clearGithubSearch(dialog, input, st);
    st.busy = null;
    renderList(st, dialog.querySelector(".ghc-rv-body"));
    dialog.querySelector(".ghc-rv-search")?.focus();
  }

  // Closing the panel (Escape, or a click outside it) while GitHub's search has text would drop the reviewers the
  // search hides, and closing while we're picking someone would save half a change: wait, clear, then close.
  function guardClose(e) {
    for (const st of panels.values()) {
      if (!st.dialog.isConnected) continue;
      const isEsc = e.type === "keydown" && e.key === "Escape";
      const outside = e.type !== "keydown" && !st.dialog.contains(e.target) && !e.target.closest?.("[role='dialog']");
      if (!isEsc && !outside) continue;
      if (st.closing === "replay") return; // our own replayed Escape
      if (!st.busy && !st.settling && !st.input.value) continue;
      e.preventDefault();
      e.stopImmediatePropagation();
      if (st.closing) return;
      st.closing = true;
      (async () => {
        await waitFor(() => !st.busy && !st.settling, 8000);
        await clearGithubSearch(st.dialog, st.input, st);
        st.closing = "replay";
        st.input.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", code: "Escape", bubbles: true, cancelable: true }));
        st.closing = false;
      })();
      return;
    }
  }
  for (const type of ["keydown", "mousedown", "pointerdown", "click"]) document.addEventListener(type, (e) => GHC.alive() && guardClose(e), true);

  const scan = GHC.debounce(() => {
    if (!GHC.alive()) return mo.disconnect();
    for (const [dialog, st] of panels) {
      if (!dialog.isConnected) {
        panels.delete(dialog);
        continue;
      }
      // Re-render only when needed: the requested reviewers changed, or GitHub re-rendered around our list.
      const box = dialog.querySelector(".ghc-rv");
      const listbox = dialog.querySelector("ul[role='listbox']");
      if (syncSelected(st) || !box || (listbox && box.nextElementSibling !== listbox) || dialog.dataset.ghcRv !== st.mode) render(st);
    }
    for (const input of document.querySelectorAll(INPUT)) setup(input);
  }, 60);
  const mo = new MutationObserver((records) => {
    if (!GHC.alive()) return mo.disconnect();
    // Our own rendering doesn't need a rescan.
    if (records.every((r) => r.target.closest?.(".ghc-rv"))) return;
    if (document.querySelector(INPUT) || panels.size) scan();
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
