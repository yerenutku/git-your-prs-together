// A small tilted "Git Your PRs Together" sticker on GitHub's logo in the header: the extension is on, and which version.
(() => {
  const VERSION = chrome.runtime.getManifest().version; // read once: chrome.* throws after an extension reload
  const LOGO = "header svg.octicon-mark-github, .AppHeader svg.octicon-mark-github, .Header svg.octicon-mark-github";

  function place() {
    const svg = document.querySelector(LOGO);
    const home = svg?.closest("a") || svg?.parentElement;
    if (!home || home.querySelector(":scope > .gypt-sticker")) return;
    home.classList.add("gypt-logo");
    const tag = document.createElement("span");
    tag.className = "gypt-sticker";
    tag.textContent = "Git Your PRs Together";
    tag.setAttribute("aria-hidden", "true");
    tag.title = `Git Your PRs Together ${VERSION}`;
    home.append(tag);
  }

  place();
  const run = GHC.debounce(() => (GHC.alive() ? place() : mo.disconnect()), 100);
  const mo = new MutationObserver(() => (GHC.alive() ? run() : mo.disconnect())); // GitHub swaps the header on navigation
  mo.observe(document.documentElement, { childList: true, subtree: true });
})();
