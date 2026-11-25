// Tick "Viewed" on a file once it has been read: both its first and its last line have been on screen, and then the
// whole card has scrolled out of the top of the screen (and stayed there for OUT_DELAY_MS).
// The last files on the page can never scroll out of the top. Those are ticked when the user is done with the page:
// they point at the review button or another PR tab, click a link away, switch browser tabs or move the mouse out.
// Polls geometry (and samples on every scroll frame) instead of using IntersectionObserver, so re-rendered nodes can't
// make us miss files.
// Each file header gets an "Auto" switch left of GitHub's Viewed button: switched off, that file is never ticked
// automatically (remembered per PR, keyed by the file's diff id, which is a hash of its path).
(() => {
  const VIEWED = "input.js-reviewed-checkbox, input[type='checkbox'][name='viewed'], button[aria-label*='Viewed' i][aria-pressed], label.js-reviewed-toggle input";
  // The whole file (sticky header + diff) is the div whose id is "diff-<hash>".
  const FILE_ID = /^diff-[0-9a-f]{16,}$/;
  const TICK_MS = 100;
  const SCROLL_IDLE_MS = 250;
  const OUT_DELAY_MS = 300; // how long a read file must stay above the screen before it is ticked
  const END_SLACK_PX = 8; // "at the end of the page" tolerance

  let cfg = { enabled: true };
  chrome.storage.local.get("autoViewed").then((s) => {
    cfg = { ...cfg, ...(s.autoViewed || {}) };
    renderFab();
  });
  chrome.storage.onChanged.addListener((c) => {
    if (!c.autoViewed) return;
    cfg = { ...cfg, ...c.autoViewed.newValue };
    if (!cfg.enabled) queue.length = 0;
    renderFab();
  });

  // Files switched to manual, per PR: { "owner/repo#12": { "diff-<hash>": ms switched off } }
  const SKIP_KEEP_MS = 60 * 864e5;
  let skip = {};
  chrome.storage.local.get("autoViewedSkip").then((s) => {
    skip = s.autoViewedSkip || {};
    renderFileSwitches();
  });
  chrome.storage.onChanged.addListener((c) => {
    if (!c.autoViewedSkip) return;
    skip = c.autoViewedSkip.newValue || {};
    renderFileSwitches();
  });
  const prKey = () => {
    const m = location.pathname.match(/^\/([^/]+\/[^/]+)\/pull\/(\d+)/);
    return m ? `${m[1]}#${m[2]}` : null;
  };
  const isSkipped = (el) => !!skip[prKey()]?.[el.id];

  async function setSkipped(fileId, off) {
    const key = prKey();
    if (!key) return;
    const { autoViewedSkip = {} } = await chrome.storage.local.get("autoViewedSkip");
    const pr = { ...(autoViewedSkip[key] || {}) };
    if (off) pr[fileId] = Date.now();
    else delete pr[fileId];
    if (Object.keys(pr).length) autoViewedSkip[key] = pr;
    else delete autoViewedSkip[key];
    for (const k of Object.keys(autoViewedSkip)) {
      if (Object.values(autoViewedSkip[k]).every((t) => Date.now() - t > SKIP_KEEP_MS)) delete autoViewedSkip[k];
    }
    skip = autoViewedSkip;
    if (off) for (let i = queue.length - 1; i >= 0; i--) if (queue[i].id === fileId) queue.splice(i, 1);
    console.log("[companion] autoviewed:", fileId.slice(0, 12), off ? "switched to manual" : "back on auto");
    renderFileSwitches();
    await chrome.storage.local.set({ autoViewedSkip });
  }

  const isChecked = (box) => (box.matches("input") ? box.checked : box.getAttribute("aria-pressed") === "true");
  const fileElements = () => [...document.querySelectorAll("div[id^='diff-']")].filter((el) => FILE_ID.test(el.id));

  // Keyed by file id so progress survives React re-mounting the node.
  // topSeen / bottomSeen: the card's top / bottom edge has been on screen.
  // outSince: when the whole card went above the top of the screen (null while it isn't).
  // done: we ticked it once; never tick it again, so a file the user un-ticks stays un-ticked.
  const progress = new Map(); // id -> { topSeen, bottomSeen, outSince, done }
  const state = (el) => {
    let p = progress.get(el.id);
    if (!p) progress.set(el.id, (p = { topSeen: false, bottomSeen: false, outSince: null, done: false }));
    return p;
  };
  const queue = []; // files to mark right away (the user is finishing up)
  let lastScroll = 0;
  let busy = false;
  let sampleQueued = false;
  addEventListener("scroll", () => {
    lastScroll = performance.now();
    if (sampleQueued) return;
    sampleQueued = true;
    requestAnimationFrame(() => {
      sampleQueued = false;
      sample();
    });
  }, { passive: true });

  const atEnd = () => scrollY + innerHeight >= document.documentElement.scrollHeight - END_SLACK_PX;

  // Record which edges of each card are on screen right now.
  function sample() {
    if (!cfg.enabled || !GHC.isPullFiles() || document.hidden) return;
    const now = performance.now();
    const vh = innerHeight;
    for (const el of fileElements()) {
      const r = el.getBoundingClientRect();
      if (!r.height) continue; // not rendered
      const p = state(el);
      if (r.top >= 0 && r.top < vh) p.topSeen = true;
      if (r.bottom > 0 && r.bottom <= vh) p.bottomSeen = true;
      if (r.bottom <= 0) p.outSince ??= now;
      else p.outSince = null;
    }
  }

  // Files that were read and are only waiting to be ticked: those already above the screen, and, when the page is
  // scrolled to the very end, those still on screen (they have nowhere left to scroll to).
  function finishable() {
    const end = atEnd();
    const vh = innerHeight;
    const out = [];
    for (const el of fileElements()) {
      const p = progress.get(el.id);
      if (!p || p.done || !p.topSeen || !p.bottomSeen || isSkipped(el)) continue;
      if (p.outSince == null) {
        const r = el.getBoundingClientRect();
        if (!(end && r.bottom > 0 && r.top < vh)) continue;
      }
      const box = el.querySelector(VIEWED);
      if (box && !isChecked(box)) out.push(el);
    }
    return out;
  }

  // Run `action`, then compensate for the layout shift it causes (a collapsing file) until the page settles.
  // The anchor is the first file still on screen. Each frame we compare where it is with where it should be if only
  // the user had scrolled: layout shifts and programmatic scrolls (GitHub scrolling to the header) are undone,
  // the user's own scrolling is left alone.
  const INPUT_QUIET_MS = 250;
  let lastWheel = 0;
  let lastOtherInput = 0;
  let wheelPending = 0; // wheel distance received but not yet seen as scrolling (smooth scrolling lags the event)
  let pointerDown = false;
  addEventListener("wheel", (e) => {
    lastWheel = performance.now();
    wheelPending += e.deltaY * (e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? innerHeight : 1);
  }, { passive: true, capture: true });
  for (const ev of ["touchmove", "keydown"]) addEventListener(ev, () => (lastOtherInput = performance.now()), { passive: true, capture: true });
  addEventListener("mousedown", () => (pointerDown = true), { passive: true, capture: true });
  addEventListener("mouseup", () => (pointerDown = false), { passive: true, capture: true });

  function withPin(files, exclude, action) {
    return new Promise((resolve) => {
      const anchor = files.find((el) => !exclude.includes(el) && el.getBoundingClientRect().bottom > 0);
      let prevY = scrollY;
      let prevDocY = anchor ? anchor.getBoundingClientRect().top + scrollY : 0;

      const start = performance.now();
      let lastChange = start;
      let corrected = 0;

      const frame = () => {
        const now = performance.now();
        if (anchor?.isConnected) {
          const top = anchor.getBoundingClientRect().top;
          const y = scrollY;
          const dScroll = y - prevY;
          const shift = top + y - prevDocY; // layout moved the anchor within the document

          // How far the user is responsible for scrolling this frame: only what the wheel has actually delivered,
          // so scroll anchoring / GitHub's own scrolling is never mistaken for the user.
          let expectedUser = 0;
          if (now - lastWheel > INPUT_QUIET_MS) wheelPending = 0;
          if (pointerDown || now - lastOtherInput < INPUT_QUIET_MS) {
            expectedUser = dScroll;
          } else if (wheelPending !== 0 && Math.sign(dScroll) === Math.sign(wheelPending)) {
            expectedUser = Math.sign(dScroll) * Math.min(Math.abs(dScroll), Math.abs(wheelPending));
            wheelPending -= expectedUser;
          }

          const adjust = shift - (dScroll - expectedUser);
          if (Math.abs(shift) > 0.5) lastChange = now;
          if (Math.abs(adjust) > 0.5) {
            scrollBy({ top: adjust, behavior: "instant" });
            corrected += scrollY - y;
            lastChange = now;
          }
          prevY = scrollY;
          prevDocY = anchor.getBoundingClientRect().top + scrollY;
        }
        if ((now - start > 600 && now - lastChange > 400) || now - start > 3000) return resolve(corrected);
        requestAnimationFrame(frame);
      };

      action();
      requestAnimationFrame(frame);
    });
  }

  async function markViewed(file, box, files) {
    busy = true;
    const corrected = await withPin(files, [file], () => box.click());
    const now = file.querySelector(VIEWED) || box;
    console.log("[companion] autoviewed: marked", file.id.slice(0, 12), "checked:", isChecked(now), "corrected px:", Math.round(corrected));
    if (isChecked(now)) {
      state(file).done = true;
      showToast(file, now);
    }
    busy = false;
  }

  // Debug: re-open every file.
  async function uncheckAll() {
    if (busy) return;
    busy = true;
    const files = fileElements();
    let n = 0;
    await withPin(files, [], () => {
      for (const el of files) {
        const box = el.querySelector(VIEWED);
        if (box && isChecked(box)) {
          box.click();
          n++;
        }
      }
    });
    progress.clear();
    queue.length = 0;
    console.log(`[companion] autoviewed: unchecked ${n} of ${files.length} files`);
    busy = false;
  }

  // Floating copy of the checked Viewed button that drifts in and fades out.
  let toastLayer;
  function showToast(file, box) {
    if (!toastLayer) {
      toastLayer = document.createElement("div");
      toastLayer.id = "ghc-toast-layer";
      document.documentElement.appendChild(toastLayer);
    }
    const toast = document.createElement("div");
    toast.className = "ghc-toast";

    const copy = box.cloneNode(true);
    copy.removeAttribute("id");
    copy.setAttribute("aria-pressed", "true");
    if (copy.matches("input")) copy.checked = true;
    copy.tabIndex = -1;

    const name = document.createElement("span");
    const path = file.querySelector("h3, [class*='file-name'], [class*='fileName']")?.textContent?.trim() || "";
    name.textContent = path.split("/").pop();

    toast.append(copy, name);
    toast.addEventListener("animationend", () => toast.remove());
    toastLayer.appendChild(toast);
  }

  // Floating switch to pause the feature (e.g. to search the page without files getting ticked).
  // Shift-click prints what the tracker knows about every file, for debugging.
  const sw = document.createElement("button");
  sw.id = "ghc-switch";
  sw.setAttribute("role", "switch");
  sw.hidden = true;
  sw.innerHTML = '<span class="ghc-switch-label">Auto-viewed</span><span class="ghc-switch-track"><span class="ghc-switch-thumb"></span></span>';
  sw.onclick = (e) => {
    if (e.shiftKey) return debugDump();
    chrome.storage.local.set({ autoViewed: { ...cfg, enabled: !cfg.enabled } });
  };
  document.documentElement.appendChild(sw);
  function renderFab() {
    sw.setAttribute("aria-checked", String(cfg.enabled));
    sw.title = cfg.enabled ? "Auto-viewed is on. Click to pause." : "Auto-viewed is paused. Click to resume.";
  }
  renderFab();

  function debugDump() {
    const now = performance.now();
    console.table(
      fileElements().map((el) => {
        const p = progress.get(el.id);
        const box = el.querySelector(VIEWED);
        const r = el.getBoundingClientRect();
        return {
          file: el.querySelector("h3, [class*='file-name'], [class*='fileName']")?.textContent?.trim().slice(-50) || el.id.slice(5, 13),
          topSeen: !!p?.topSeen,
          bottomSeen: !!p?.bottomSeen,
          outForMs: p?.outSince != null ? Math.round(now - p.outSince) : null,
          done: !!p?.done,
          auto: !isSkipped(el),
          hasButton: !!box,
          checked: box ? isChecked(box) : null,
          top: Math.round(r.top),
          height: Math.round(r.height),
        };
      })
    );
    console.log("[companion] autoviewed:", { enabled: cfg.enabled, busy, queued: queue.length, atEnd: atEnd() });
  }

  const resetBtn = document.createElement("button");
  resetBtn.id = "ghc-uncheck-all";
  resetBtn.textContent = "Uncheck all viewed (debug)";
  resetBtn.hidden = true;
  resetBtn.onclick = uncheckAll;
  document.documentElement.appendChild(resetBtn);

  // The user is finishing up but still looking at the page: queue the read files, ticked one by one with the page pinned.
  function flush(reason) {
    if (!cfg.enabled || !GHC.isPullFiles()) return;
    sample();
    const added = finishable().filter((el) => !queue.includes(el));
    queue.push(...added);
    if (added.length) console.log("[companion] autoviewed:", reason, "- queued", added.length, "files");
  }

  // The user is leaving (another browser tab, a link away): tick all read files at once, no need to keep the page steady.
  function flushNow(reason) {
    if (!cfg.enabled || !GHC.isPullFiles()) return;
    sample();
    const els = [...new Set([...queue.filter((el) => el.isConnected), ...finishable()])];
    queue.length = 0;
    let n = 0;
    for (const el of els) {
      const box = el.querySelector(VIEWED);
      if (!box || isChecked(box) || isSkipped(el)) continue;
      box.click();
      state(el).done = true;
      n++;
    }
    if (n) console.log("[companion] autoviewed:", reason, "- marked", n, "files");
  }

  // The mouse left the page (tabs, address bar, another window).
  // Not every browser reports leaving through its own toolbar (Arc's hidden bar), so also treat touching the edge as leaving.
  const EDGE_PX = 2;
  let atEdge = false;
  document.addEventListener("mouseout", (e) => !e.relatedTarget && flush("mouse left"));
  document.documentElement.addEventListener("mouseleave", () => flush("mouse left"));
  document.addEventListener("mousemove", (e) => {
    const edge = e.clientY <= EDGE_PX || e.clientX <= EDGE_PX || e.clientX >= innerWidth - EDGE_PX || e.clientY >= innerHeight - EDGE_PX;
    if (edge && !atEdge) flush("mouse at edge");
    atEdge = edge;
  }, { passive: true });

  // Pointing at the review button or another PR tab (Conversation, Commits, Checks) means the user is about to finish here.
  const REVIEW_TEXT = /\b(submit|finish)\b.*\breview\b|\breview changes\b/i;
  const PR_TAB = /\/pull\/\d+(\/(commits|checks))?\/?$/;
  function exitControl(target) {
    const el = target?.closest?.("a[href], button, summary, [role='button'], [role='tab']");
    if (!el) return null;
    if (REVIEW_TEXT.test(el.getAttribute("aria-label") || "") || REVIEW_TEXT.test(el.textContent || "")) return el;
    if (el.matches("a[href]")) {
      const u = new URL(el.href, location.href);
      if (u.origin === location.origin && PR_TAB.test(u.pathname)) return el;
    }
    return null;
  }
  let hoveredExit = null;
  document.addEventListener("mouseover", (e) => {
    const el = exitControl(e.target);
    if (el && el !== hoveredExit) flush("pointing at " + (el.textContent || "").trim().slice(0, 30));
    hoveredExit = el;
  }, { passive: true, capture: true });

  // Clicking the review button (its dialog covers the files) or a link that leaves this page.
  document.addEventListener("click", (e) => {
    if (e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    if (exitControl(e.target)) return flushNow("clicked review/tab");
    const a = e.target?.closest?.("a[href]");
    if (!a || a.target === "_blank") return;
    if (new URL(a.href, location.href).pathname !== location.pathname) flushNow("navigating away");
  }, true);

  // Switched browser tab or window, or closing the tab.
  document.addEventListener("visibilitychange", () => document.hidden && flushNow("tab hidden"));
  addEventListener("pagehide", () => flushNow("page hidden"));

  let lastSwitches = 0;
  function tick() {
    const now = performance.now();
    resetBtn.hidden = sw.hidden = !GHC.isPullFiles();
    if (GHC.isPullFiles() && !document.hidden && now - lastSwitches > 400) {
      lastSwitches = now;
      renderFileSwitches();
    }
    if (!cfg.enabled || !GHC.isPullFiles() || document.hidden) return;

    sample();
    if (busy) return;
    const files = fileElements();

    // The user is finishing up: drain the queue, no need to wait for scrolling to stop.
    while (queue.length) {
      const el = queue.shift();
      const box = el.isConnected && el.querySelector(VIEWED);
      if (box && !isChecked(box) && !isSkipped(el)) return void markViewed(el, box, files);
    }

    // Otherwise: a fully read file that has been above the screen for OUT_DELAY_MS, one at a time,
    // and only while the user isn't scrolling (ticking collapses the file, which would fight the scroll).
    if (now - lastScroll < SCROLL_IDLE_MS) return;
    for (const el of files) {
      const p = progress.get(el.id);
      if (!p || p.done || !p.topSeen || !p.bottomSeen || p.outSince == null || now - p.outSince < OUT_DELAY_MS || isSkipped(el)) continue;
      const box = el.querySelector(VIEWED);
      if (box && !isChecked(box)) return void markViewed(el, box, files);
    }
  }

  // ---------- per-file "Auto" switch, left of GitHub's Viewed button ----------

  function makeFileSwitch(fileId) {
    const t = document.createElement("button");
    t.type = "button";
    t.className = "ghc-file-av";
    t.setAttribute("role", "switch");
    t.setAttribute("aria-label", "Auto-view this file"); // not "Viewed": the VIEWED selector must never match us
    t.dataset.file = fileId;
    t.innerHTML = '<span class="ghc-file-av-label">Auto</span><span class="ghc-file-av-track"><span class="ghc-file-av-thumb"></span></span>';
    t.addEventListener("click", (e) => {
      e.preventDefault();
      e.stopPropagation();
      setSkipped(t.dataset.file, t.getAttribute("aria-checked") === "true");
    });
    return t;
  }

  function renderFileSwitches() {
    if (!GHC.isPullFiles()) return;
    for (const el of fileElements()) {
      const box = el.querySelector(VIEWED);
      if (!box) continue; // no Viewed button (e.g. your own PR): nothing to automate
      const anchor = box.closest("label.js-reviewed-toggle") || box;
      let t = anchor.previousElementSibling;
      if (!t?.classList.contains("ghc-file-av") || t.dataset.file !== el.id) {
        for (const old of el.querySelectorAll(".ghc-file-av")) old.remove();
        t = makeFileSwitch(el.id);
        anchor.before(t);
      }
      const on = !isSkipped(el);
      if (t.getAttribute("aria-checked") !== String(on)) t.setAttribute("aria-checked", String(on));
      t.classList.toggle("ghc-file-av-paused", !cfg.enabled);
      const tip = !cfg.enabled
        ? `Auto-viewed is paused for the whole page (switch at the bottom right). This file: ${on ? "auto" : "manual"}.`
        : on
          ? "Auto-view is on for this file: it gets marked Viewed once you've read it and scrolled past. Click to turn it off for this file only."
          : "Auto-view is off for this file: it is never marked Viewed automatically. Click to turn it back on.";
      if (t.title !== tip) t.title = tip;
    }
  }

  // Extension reloaded: stop this orphaned copy, so it neither throws nor marks files alongside the new one.
  const timer = setInterval(() => (GHC.alive() ? tick() : clearInterval(timer)), TICK_MS);
})();
