import fs from "fs";
import path from "path";

const U = process.env.SUPABASE_URL, K = process.env.SUPABASE_SERVICE_KEY;
const supabasePlaceholder = U?.toLowerCase().includes("your-project.supabase.co");
export const remote = !!(U && K && !supabasePlaceholder);
if (supabasePlaceholder) console.warn("Supabase URL is still a placeholder; using local file storage.");
const DIR = path.join(process.cwd(), "data"), DB = path.join(DIR, "db.json"), UP = path.join(DIR, "uploads");
const H = (x = {}) => ({ apikey: K, ...(String(K).startsWith("sb_") ? {} : { Authorization: "Bearer " + K }), ...x });
const fail = async (what, r) => { throw new Error(what + " failed: " + r.status + " " + (await r.text())); };

export async function loadDb(seed) {
  if (remote) {
    const r = await fetch(U + "/rest/v1/kv?key=eq.db&select=value", { headers: H(), cache: "no-store" });
    if (!r.ok) await fail("Database read", r);
    const j = await r.json();
    if (j.length) return j[0].value;
    const d = seed(); if (d) await saveDb(d);
    return d;
  }
  fs.mkdirSync(UP, { recursive: true });
  if (!fs.existsSync(DB)) { const d = seed(); if (!d) return null; fs.writeFileSync(DB, JSON.stringify(d, null, 1)); }
  return JSON.parse(fs.readFileSync(DB, "utf8"));
}
export async function saveDb(d) {
  if (remote) {
    const r = await fetch(U + "/rest/v1/kv", { method: "POST", headers: H({ "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }), body: JSON.stringify({ key: "db", value: d }), cache: "no-store" });
    if (!r.ok) await fail("Database write", r);
    return;
  }
  fs.writeFileSync(DB + ".tmp", JSON.stringify(d, null, 1)); fs.renameSync(DB + ".tmp", DB);
}
export async function putFile(name, buf, type) {
  if (remote) {
    const r = await fetch(U + "/storage/v1/object/uploads/" + name, { method: "POST", headers: H({ "Content-Type": type || "application/octet-stream" }), body: buf });
    if (!r.ok) await fail("File upload", r);
    return;
  }
  fs.mkdirSync(UP, { recursive: true }); fs.writeFileSync(path.join(UP, name), buf);
}
export async function getFile(name) {
  if (remote) {
    const r = await fetch(U + "/storage/v1/object/uploads/" + name, { headers: H(), cache: "no-store" });
    return r.ok ? Buffer.from(await r.arrayBuffer()) : null;
  }
  const fp = path.join(UP, name);
  return fs.existsSync(fp) ? fs.readFileSync(fp) : null;
}
export async function delFile(name) {
  if (remote) { await fetch(U + "/storage/v1/object/uploads/" + name, { method: "DELETE", headers: H() }); return; }
  try { fs.unlinkSync(path.join(UP, name)); } catch (e) {}
}
