// Run once from the folder that contains your local "data" folder:
//   node --env-file=.env.local scripts/migrate-to-supabase.js
const fs = require("fs"), path = require("path");
const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
if (!U || !K) { console.error("Set SUPABASE_URL and SUPABASE_SERVICE_KEY in .env.local first."); process.exit(1); }
const H = (x = {}) => ({ apikey: K, ...(K.startsWith("sb_") ? {} : { Authorization: "Bearer " + K }), ...x });
(async () => {
  const d = JSON.parse(fs.readFileSync(path.join(process.cwd(), "data", "db.json"), "utf8"));
  let r = await fetch(U + "/rest/v1/kv", { method: "POST", headers: H({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }), body: JSON.stringify({ key: "db", value: d }) });
  console.log("Database:", r.ok ? "uploaded" : "FAILED " + (await r.text()));
  const dir = path.join(process.cwd(), "data", "uploads");
  for (const f of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    r = await fetch(U + "/storage/v1/object/uploads/" + f, { method: "POST", headers: H({ "Content-Type": "application/octet-stream", "x-upsert": "true" }), body: fs.readFileSync(path.join(dir, f)) });
    console.log("File", f, r.ok ? "uploaded" : "FAILED " + (await r.text()));
  }
})();
