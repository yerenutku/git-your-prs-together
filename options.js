const $ = (id) => document.getElementById(id);

function parseRepos(text) {
  const out = {};
  for (const line of text.split("\n")) {
    const m = line.match(/^\s*([^:\s]+\/[^:\s]+)\s*:\s*(.+)$/);
    if (m) out[m[1]] = m[2].split(/[,\s]+/).filter(Boolean);
  }
  return out;
}

async function load() {
  const s = await chrome.storage.local.get(["apiBase", "token", "repoContributors", "autoViewed", "notify"]);
  const av = { enabled: true, ...(s.autoViewed || {}) };
  const n = { reReview: true, attention: true, threads: true, ready: true, ...(s.notify || {}) };
  const host = GHHost.parse(s.apiBase);
  $("host").value = host?.host || "";
  $("welcome").hidden = !!host;
  $("token").value = s.token || "";
  $("repos").value = Object.entries(s.repoContributors || {}).map(([r, l]) => `${r}: ${l.join(", ")}`).join("\n");
  $("avEnabled").checked = av.enabled;
  $("nReReview").checked = n.reReview;
  $("nAttention").checked = n.attention;
  $("nThreads").checked = n.threads;
  $("nReady").checked = n.ready;
}

// What the extension keeps when you switch to another GitHub: your settings. The rest (PR data, what was notified,
// what you've read) belongs to the old one.
const SETTINGS_KEYS = ["apiBase", "token", "repoContributors", "autoViewed", "notify", "threadsOpenOnly"];

$("save").onclick = async () => {
  const host = GHHost.parse($("host").value || $("host").placeholder);
  $("hostError").textContent = host ? "" : "Type github.com or an address ending in .ghe.com.";
  if (!host) return;
  // The browser must let the extension read that GitHub (in Firefox it can be switched off per site). Asked first:
  // the request needs this click, and an await before it would lose that.
  const allowed = await chrome.permissions.request({ origins: host.origins }).catch(() => false);
  if (!allowed) $("hostError").textContent = `The browser doesn't let the extension read ${host.host}: allow it in the extension's site access settings.`;
  const before = GHHost.parse((await chrome.storage.local.get("apiBase")).apiBase);
  if (before && before.host !== host.host) {
    const all = await chrome.storage.local.get(null);
    await chrome.storage.local.remove(Object.keys(all).filter((k) => !SETTINGS_KEYS.includes(k)));
  }
  $("host").value = host.host;
  $("welcome").hidden = true;
  await chrome.storage.local.set({
    apiBase: host.api,
    token: $("token").value.trim(),
    repoContributors: parseRepos($("repos").value),
    autoViewed: { ...((await chrome.storage.local.get("autoViewed")).autoViewed || {}), enabled: $("avEnabled").checked },
    notify: { reReview: $("nReReview").checked, attention: $("nAttention").checked, threads: $("nThreads").checked, ready: $("nReady").checked },
  });
  chrome.runtime.sendMessage({ type: "refresh", force: before?.host !== host.host });
  $("status").textContent = "Saved";
  setTimeout(() => ($("status").textContent = ""), 1500);
};

$("testNotify").onclick = async () => {
  const r = await chrome.runtime.sendMessage({ type: "testNotification" });
  $("testStatus").textContent = r === true ? "Sent. Nothing showed up? Check that your OS allows notifications from the browser." : `Failed: ${r}`;
};

// Where the data comes from and what was notified: the first thing to look at when something doesn't show up.
const agoText = (ms) => {
  const s = Math.round((Date.now() - ms) / 1000);
  return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.round(s / 60)} min ago` : new Date(ms).toLocaleString();
};
async function status() {
  const s = await chrome.storage.local.get(["authored", "myThreads", "notifyLog"]);
  const a = s.authored;
  const src = a?.source === "session" ? "GitHub's pages, with this browser's sign-in" : a?.me ? "the API, with the token" : null;
  $("dataStatus").replaceChildren();
  const small = document.createElement("small");
  small.textContent = !a
    ? "No data yet."
    : a.error && !a.me
      ? `Last refresh failed ${agoText(a.at)}: ${a.error}`
      : `Signed in as ${a.me}. Data from ${src}, refreshed ${agoText(a.at)}: ${a.items.length} open PR${a.items.length === 1 ? "" : "s"} of yours, ${s.myThreads?.items?.length ?? 0} PRs you take part in.` +
        (a.error ? ` Last error: ${a.error}` : "");
  $("dataStatus").append(small);
  const log = s.notifyLog || [];
  $("notifyLog").replaceChildren(
    ...(log.length ? log : [null]).map((n) => {
      const li = document.createElement("li");
      li.textContent = n ? `${new Date(n.at).toLocaleString()}: ${n.title}${n.context ? ` (${n.context})` : ""}` : "none yet";
      return li;
    })
  );
}
chrome.storage.onChanged.addListener((c) => (c.authored || c.notifyLog) && status());

load();
status();
