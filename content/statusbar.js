// Bouncing "re-review" bar, shown on every page of the host.
(() => {
  const bar = document.createElement("div");
  bar.id = "ghc-bar";
  bar.hidden = true;
  document.documentElement.appendChild(bar);

  const dismissedKey = "ghcDismissed";
  const dismissed = () => JSON.parse(sessionStorage.getItem(dismissedKey) || "[]");

  function render(state) {
    const items = (state?.items || []).filter((i) => !dismissed().includes(i.key));
    bar.hidden = items.length === 0 && !state?.error;
    bar.classList.toggle("ghc-error", !!state?.error);
    bar.replaceChildren();
    if (state?.error) {
      bar.textContent = `Git Your PRs Together: ${state.error}`;
      return;
    }
    if (!items.length) return;

    const label = document.createElement("strong");
    label.textContent = `Re-review (${items.length})`;
    bar.append(label);

    for (const i of items) {
      const a = document.createElement("a");
      a.href = GHC.safeUrl(i.url);
      a.textContent = `${i.repo}#${i.number} ${i.title}`;
      a.title = `by ${i.author}`;
      const x = document.createElement("button");
      x.textContent = "×";
      x.title = "Dismiss until next push";
      x.onclick = () => {
        sessionStorage.setItem(dismissedKey, JSON.stringify([...dismissed(), i.key]));
        chrome.storage.local.get("reReview").then((s) => render(s.reReview));
      };
      const chip = document.createElement("span");
      chip.className = "ghc-chip";
      chip.append(a, x);
      bar.append(chip);
    }
  }

  chrome.storage.local.get("reReview").then((s) => render(s.reReview));
  chrome.storage.onChanged.addListener((c) => c.reReview && render(c.reReview.newValue));
  chrome.runtime.sendMessage({ type: "refresh" }); // fresh data on every page load
})();
