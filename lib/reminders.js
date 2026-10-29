import { loadDb, saveDb } from "./store";
import { sendEmail } from "./email";

const esc = (s) => String(s).replace(/[<>&"]/g, "");
export async function check() {
  let d; try { d = await loadDb(() => null); } catch (e) { console.error("Reminder DB read failed:", e.message); return; }
  if (!d) return;
  const jobs = [], n = new Date(), today = new Date(n.getFullYear(), n.getMonth(), n.getDate());
  [...(d.projects || []).flatMap((p) => p.tickets || []), ...(d.tickets || [])].forEach((t) => {
    if (!t.deadline || t.status === "Completed" || !(t.assignees || []).length) return;
    const left = Math.round((new Date(t.deadline + "T00:00:00") - today) / 864e5);
    const ms = left < 0 ? "overdue" : [0, 1, 3].includes(left) ? String(left) : null;
    if (!ms || (t.rem || []).includes(ms)) return;
    const when = left < 0 ? "is overdue by " + -left + " day(s)" : left === 0 ? "is due today" : "has " + left + " day(s) left";
    (d.members || []).filter((m) => t.assignees.includes(m.id) && m.status !== "disabled").forEach((m) =>
      jobs.push({ ticket: t, reminder: ms, to: m.email, subject: "Deadline reminder: " + t.id,
        html: `<p>Hello ${esc(m.name)},</p><p>Your ticket <b>${t.id}</b> - ${esc(t.title)} ${when} (deadline: ${t.deadline}).</p><p>Please update its status in the portal${process.env.APP_URL ? ": " + process.env.APP_URL : ""}.</p>` }));
  });
  if (!jobs.length) return;
  const good = new Map(), bad = new Map();
  for (const j of jobs) {
    const r = await sendEmail(j);
    if (!r.sent) console.error(`Deadline reminder failed for ${j.to} (${j.subject}): ${r.error}`);
    const m = r.sent ? good : bad;
    if (!m.has(j.ticket)) m.set(j.ticket, new Set());
    m.get(j.ticket).add(j.reminder);
  }
  let changed = false;
  good.forEach((set, t) => set.forEach((rem) => {
    if (!(bad.get(t) || new Set()).has(rem) && !(t.rem || []).includes(rem)) { t.rem = [...(t.rem || []), rem]; changed = true; }
  }));
  if (changed) await saveDb(d);
}
export function startReminders() {
  const run = () => check().catch((e) => console.error("Deadline reminder check failed:", e.message));
  setTimeout(run, 30000); setInterval(run, 36e5);
}
