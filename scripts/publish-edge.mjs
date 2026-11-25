// Submits a zip to Microsoft Edge Add-ons (Add-ons API v1.1): upload it as the draft package, then submit the draft
// for certification. Used by .github/workflows/release.yml.
//
//   EDGE_PRODUCT_ID=… EDGE_CLIENT_ID=… EDGE_API_KEY=… node scripts/publish-edge.mjs dist/chrome-1.2.3.zip "v1.2.3"
import fs from "node:fs";

const [zip, notes = ""] = process.argv.slice(2);
const { EDGE_PRODUCT_ID: product, EDGE_CLIENT_ID: clientId, EDGE_API_KEY: apiKey } = process.env;
if (!zip || !product || !clientId || !apiKey) {
  console.error("Usage: EDGE_PRODUCT_ID, EDGE_CLIENT_ID, EDGE_API_KEY set; node scripts/publish-edge.mjs <zip> [notes]");
  process.exit(2);
}
const BASE = `https://api.addons.microsoftedge.microsoft.com/v1/products/${product}`;
const auth = { Authorization: `ApiKey ${apiKey}`, "X-ClientID": clientId };

// Both calls answer 202 with the operation in the Location header; poll it until it's done.
async function start(path, init) {
  const res = await fetch(BASE + path, { method: "POST", ...init, headers: { ...auth, ...init.headers } });
  if (res.status !== 202) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return res.headers.get("location").split("/").pop();
}
async function wait(path) {
  for (let i = 0; i < 60; i++) {
    const res = await fetch(BASE + path, { headers: auth });
    const body = await res.json().catch(() => ({}));
    if (body.status === "Succeeded") return body;
    if (body.status === "Failed") throw new Error(`${path}: ${JSON.stringify(body)}`);
    await new Promise((r) => setTimeout(r, 5000));
  }
  throw new Error(`${path}: still in progress after 5 minutes`);
}

const upload = await start("/submissions/draft/package", { body: fs.readFileSync(zip), headers: { "Content-Type": "application/zip" } });
await wait(`/submissions/draft/package/operations/${upload}`);
console.log(`Uploaded ${zip}`);
const submit = await start("/submissions", { body: JSON.stringify({ notes }), headers: { "Content-Type": "application/json" } });
await wait(`/submissions/operations/${submit}`);
console.log("Submitted for certification");
