// The one GitHub the extension works with, picked on the options page: github.com, or a GitHub Enterprise Cloud
// tenant on <name>.ghe.com. Those are the hosts in manifest.json's host_permissions. GitHub Enterprise Server
// (self-hosted, its own domain) isn't supported yet.
// Shared by background.js (importScripts, or the background page's script list in Firefox) and the options page.
const GHHost = {
  // "github.com", "https://acme.ghe.com/pulls", "api.acme.ghe.com" → { host, web, api, origins }. Anything else → null.
  parse(input) {
    let h = String(input || "").trim().toLowerCase();
    if (!h) return null;
    try {
      h = new URL(/^[a-z][a-z0-9+.-]*:\/\//.test(h) ? h : `https://${h}`).hostname;
    } catch {
      return null;
    }
    h = h.replace(/^(api|www)\./, "");
    if (h !== "github.com" && !/^[a-z0-9]([a-z0-9-]*[a-z0-9])?\.ghe\.com$/.test(h)) return null;
    const web = `https://${h}`;
    const api = `https://api.${h}`;
    return { host: h, web, api, origins: [`${web}/*`, `${api}/*`] };
  },
};
