import path from "path";
import crypto from "crypto";
import { SEED } from "../../../lib/seed";
import { sendEmail, emailStatus } from "../../../lib/email";
import { loadDb, saveDb, putFile, getFile, delFile, remote } from "../../../lib/store";
import { check } from "../../../lib/reminders";

export const dynamic = "force-dynamic";
const load = () => loadDb(() => ({ tickets: SEED, members: [], invites: [], meetings: [] }));
const save = async (d) => {
  const activeProject = d._activeProject;
  const data = { ...d };
  if (activeProject) {
    activeProject.tickets = d.tickets; activeProject.files = d.files; activeProject.audit = d.audit;
    delete data._activeProject; delete data._activeProjectId;
    delete data.tickets; delete data.files; delete data.audit;
  }
  await saveDb(data);
};
const uid = () => crypto.randomBytes(16).toString("hex");
const J = (o, s = 200) => Response.json(o, { status: s });
const pub = (m) => ({ id: m.id, name: m.name, email: m.email, phone: m.phone || "", role: m.role, hasPw: !!m.pw, status: m.status || "active" });
const ROLES = ["Admin", "Developer", "Collaborator", "Client"];
const td = () => new Date().toISOString().slice(0, 10);
const esc = (v) => String(v).replace(/[<>&"]/g, "");
const emailHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
}[character]));
const emails = (d, ids) => d.members.filter((m) => ids.includes(m.id) && m.status !== "disabled" && d._activeProject.members.some((x) => x.memberId === m.id && x.status !== "disabled")).map((m) => m.email);
const CATS = ["Requirements & Design", "Reports & Releases", "Guides & Communication", "Other"];
const claim = (d, m) => (d.projects || [{ tickets: d.tickets || [] }]).forEach((project) => project.tickets.forEach((t) => {
  const tk = String(t.owner || "").toLowerCase().split(/[;&,\n]/).map((x) => x.replace(/\(.*?\)/g, "").trim()).filter((x) => x.length > 2);
  if (tk.some((x) => m.name.toLowerCase().startsWith(x)) && !(t.assignees || []).includes(m.id)) t.assignees = [...(t.assignees || []), m.id];
}));
async function migrate(d) {
  const sd = Object.fromEntries(SEED.map((t) => [t.id, t]));
  d.tickets.forEach((t) => {
    (t.attachments || []).forEach((a) => d.files.push({ id: a.file, name: a.name, size: a.size, cat: a.cat, by: a.by, at: a.at }));
    delete t.attachments;
    const o = sd[t.id];
    if (o) { if (o.details.length > (t.details || "").length) t.details = o.details; t.owner = o.owner; }
    t.assignees = t.assignees || (t.assignee ? [t.assignee] : []); delete t.assignee;
  });
  d.members.forEach((m) => claim(d, m));
  d.v2 = true; await save(d);
}
const np = (v) => String(v || "").replace(/[^\d+]/g, "");
const hash = (p) => { const s = crypto.randomBytes(16).toString("hex"); return s + ":" + crypto.scryptSync(p, s, 64).toString("hex"); };
const verify = (p, h) => { if (!h) return false; const [s, x] = h.split(":"); return crypto.timingSafeEqual(crypto.scryptSync(p, s, 64), Buffer.from(x, "hex")); };
const fails = new Map();
const SESSION = 30 * 864e5, CONFIGURED_SITE = process.env.APP_URL || "";
const siteUrl = (origin) => {
  if (!CONFIGURED_SITE || CONFIGURED_SITE.toLowerCase().includes("your-project.vercel.app")) return origin;
  try { return new URL(CONFIGURED_SITE).origin; } catch { return origin; }
};
const live = (x) => { const t = +String(x).split(".")[1]; return !t || Date.now() - t < SESSION; };
const pwOk = (p) => p && p.length >= 8 && /[a-z]/i.test(p) && /\d/.test(p);
const PWMSG = "Password must be 8+ characters with at least one letter and one number";
const log = (d, who, act, detail) => { d.audit.unshift({ at: new Date().toISOString(), who, act, detail: detail || "" }); d.audit.length = Math.min(d.audit.length, 1000); };
const TICKET_AUDIT_FIELDS = [
  ["title", "Title"], ["type", "Type"], ["status", "Status"], ["priority", "Priority"],
  ["by", "Raised by"], ["date", "Raised date"], ["closed", "Completed date"],
  ["version", "Version"], ["deployed", "Deployed date"], ["deadline", "Deadline"],
  ["details", "Description"], ["resolution", "Resolution"], ["assignees", "Assignees"],
  ["createdBy", "Client"], ["notes", "History"],
];
const auditValue = (field, value, members) => {
  if (value === undefined || value === null || value === "") return "—";
  if (field === "assignees") return (Array.isArray(value) ? value : []).map((id) => memberName(members, id)).join(", ") || "Unassigned";
  if (field === "createdBy") return memberName(members, value);
  if (field === "notes") return JSON.stringify(value);
  return String(value);
};
const memberName = (members, id) => members.find((member) => member.id === id)?.name || String(id);
const ticketChanges = (oldTicket, newTicket, members) => TICKET_AUDIT_FIELDS.flatMap(([field, label]) =>
  JSON.stringify(oldTicket[field]) === JSON.stringify(newTicket[field]) ? [] : [{
    field: label,
    old: auditValue(field, oldTicket[field], members),
    new: auditValue(field, newTicket[field], members),
  }]
);

async function send(to, subject, html) {
  const result = await sendEmail({ to, subject, html });
  if (!result.sent) console.error(`Email delivery failed for ${to} (${subject}): ${result.error}`);
  return result;
}
async function emailAssignedTasks(d, { tasks, previousTasks = [], title, projectName }) {
  const previousAssignments = new Map(previousTasks.map((task) => [task.id, task.assigneeId]));
  const assignedByMember = new Map();
  tasks.filter((task) => task.assigneeId && previousAssignments.get(task.id) !== task.assigneeId).forEach((task) => {
    const assigned = assignedByMember.get(task.assigneeId) || [];
    assigned.push(task);
    assignedByMember.set(task.assigneeId, assigned);
  });
  return Promise.all([...assignedByMember.entries()].map(async ([memberId, assignedTasks]) => {
    const member = d.members.find((item) => item.id === memberId && item.status !== "disabled");
    if (!member) return { sent: false, skipped: true };
    const lines = assignedTasks.map((task) => `<li>${emailHtml(task.title)}${task.dueDate ? ` — due ${emailHtml(task.dueDate)}` : ""}</li>`).join("");
    const result = await send(member.email, `Action items assigned: ${title}`, `<p>Hello ${emailHtml(member.name)},</p><p>These action items from <b>${emailHtml(title)}</b>${projectName ? ` in <b>${emailHtml(projectName)}</b>` : ""} were assigned to you:</p><ul>${lines}</ul><p>Open the project portal → Meeting Notes to manage deadlines, status, and comments.</p>`);
    return { sent: result.sent, error: result.error, skipped: false };
  }));
}
const mail = (to, link, role, projectName) => send(to, "Project invitation: " + projectName, `<p>You have been invited as <b>${emailHtml(role)}</b> to the <b>${emailHtml(projectName)}</b> project on the Solexes Ticket Managment portal.</p><p><a href="${link}">Accept invitation</a></p>`);
async function resetLink(d, m, origin) {
  const token = uid();
  d.resets = d.resets.filter((x) => x.id !== m.id).concat({ id: m.id, token, at: Date.now() });
  const link = siteUrl(origin) + "/?reset=" + token;
  const result = await send(m.email, "Reset your Support Tracker password", `<p>Hello ${emailHtml(m.name)},</p><p>Use this link to set a new password. It expires in 1 hour and works once.</p><p><a href="${link}">Reset password</a></p><p>If you did not request this, you can ignore this email.</p>`);
  log(d, m.name, "Password reset link issued");
  return { link, sent: result.sent, emailError: result.error };
}

async function h(req, p, m) {
  const u = new URL(req.url), r = p[0];
  if (r === "cron") {
    if (!process.env.CRON_SECRET || req.headers.get("authorization") !== "Bearer " + process.env.CRON_SECRET) return J({ error: "denied" }, 401);
    await check(); return J({ ok: true });
  }
  const d = await load();
  d.audit = d.audit || []; d.resets = d.resets || []; d.files = d.files || []; d.meetings = d.meetings || []; d.meetingNotes = d.meetingNotes || [];
  d.meetings.forEach((meeting) => { if (!meeting.projectId) meeting.projectId = "rewaldo"; });
  if (!d.v2) await migrate(d);
  if (!d.v3) {
    const cm = { "Version Chain Management Docs": "Release & Version Docs", "Issue Report Docs": "Bug & Issue Reports" };
    d.tickets.forEach((t) => { if (t.status === "Done") t.status = "Completed"; });
    d.files.forEach((x) => { x.cat = cm[x.cat] || x.cat; });
    d.v3 = true; await save(d);
  }
  if (!d.v4) {
    const cm = {
      "Requirements & Specifications": "Requirements & Design",
      "Architecture & Design": "Requirements & Design",
      "Bug & Issue Reports": "Reports & Releases",
      "Test Cases & QA Reports": "Reports & Releases",
      "Release & Version Docs": "Reports & Releases",
      "Deployment & Runbooks": "Reports & Releases",
      "User Manuals & Guides": "Guides & Communication",
      "Client Communication": "Guides & Communication",
      "Other Docs": "Other",
    };
    d.files.forEach((x) => { x.cat = cm[x.cat] || (CATS.includes(x.cat) ? x.cat : "Other"); });
    d.v4 = true; await save(d);
  }
  if (!Array.isArray(d.projects)) {
    const legacy = {
      id: "rewaldo",
      name: "Rewaldo",
      tickets: d.tickets || SEED,
      files: d.files || [],
      audit: d.audit || [],
      members: d.members.map((member) => ({ memberId: member.id, role: member.role || "Developer", status: "active" })),
    };
    d.projects = [legacy];
    delete d.tickets; delete d.files; delete d.audit;
    d.projects.push({ id: "docutect", name: "DocuTect", tickets: [], files: [], audit: [], members: d.members.filter((member) => member.role === "Admin").map((member) => ({ memberId: member.id, role: "Admin", status: "active" })) });
    await save(d);
  }
  d.projects.forEach((x) => {
    x.tickets = x.tickets || []; x.files = x.files || []; x.audit = x.audit || [];
    if (!Array.isArray(x.members)) {
      const existingTeam = x.id === "rewaldo" ? d.members : d.members.filter((member) => member.role === "Admin");
      x.members = existingTeam.map((member) => ({ memberId: member.id, role: member.role || "Admin", status: "active" }));
    }
  });
  d.invites = d.invites || [];
  d.invites.forEach((invite) => { invite.projectId = invite.projectId || "rewaldo"; });
  if (!d.v5) { d.v5 = true; await save(d); }
  const requestedProject = u.searchParams.get("project");
  let project = d.projects.find((x) => x.id === requestedProject) || d.projects[0];
  if (requestedProject && !d.projects.some((x) => x.id === requestedProject)) return J({ error: "Project not found" }, 404);
  d.resets = d.resets || [];
  if (!d.members.length && process.env.ADMIN_EMAIL && pwOk(process.env.ADMIN_PASSWORD)) {
    const m = { id: uid().slice(0, 8), name: process.env.ADMIN_NAME || "Admin", email: process.env.ADMIN_EMAIL.trim().toLowerCase(), phone: "", pw: hash(process.env.ADMIN_PASSWORD), role: "Admin", sessions: [] };
    d.members.push(m);
    d.projects.forEach((x) => { x.members.push({ memberId: m.id, role: "Admin", status: "active" }); });
    claim(d, m); await save(d);
  }
  const key = req.headers.get("x-key") || u.searchParams.get("key");
  const account = key && d.members.find((x) => x.status !== "disabled" && (x.key === key || (x.sessions || []).some((v) => v === key && live(v))));
  if (!requestedProject && account) project = d.projects.find((x) => x.members.some((entry) => entry.memberId === account.id && entry.status !== "disabled")) || project;
  d._activeProject = project; d._activeProjectId = project.id;
  d.tickets = project.tickets; d.files = project.files; d.audit = project.audit;
  const membership = account && project.members.find((x) => x.memberId === account.id && x.status !== "disabled");
  const me = membership ? { ...account, role: membership.role } : null;
  const meetingMemberships = account && project.members
    .filter((entry) => entry.memberId === account.id && entry.status !== "disabled");
  const canUseMeetings = !!meetingMemberships?.some((entry) => entry.role !== "Client");
  const canManageMeetings = !!meetingMemberships?.some((entry) => entry.role === "Admin");
  try {
    if (m === "GET" && r === "db") {
      if (!d.members.length) return J({ setup: true });
      if (!me) return J({ error: account ? "You are not a member of this project" : "denied" }, account ? 403 : 401);
      const projects = d.projects.filter((x) => x.members.some((entry) => entry.memberId === account.id && entry.status !== "disabled")).map(({ id, name }) => ({ id, name }));
      if (me.role === "Client") {
        const mine = d.tickets.filter((t) => t.createdBy === me.id);
        return J({ me: pub(me), projects, projectId: project.id, canUseMeetings, canManageMeetings, tickets: mine.map((t) => ({ id: t.id, type: t.type, date: t.date, by: t.by, title: t.title, details: t.details, resolution: t.resolution, notes: t.notes, closed: t.closed, createdBy: t.createdBy, status: ["Completed", "Reopened"].includes(t.status) ? t.status : "In Progress" })), members: [], invites: [], audit: [], files: d.files.filter((x) => mine.some((t) => t.id === x.ticket)) });
      }
      const members = project.members.map((entry) => {
        const member = d.members.find((x) => x.id === entry.memberId);
        return member ? { ...pub(member), role: entry.role, status: entry.status === "disabled" || member.status === "disabled" ? "disabled" : "active" } : null;
      }).filter(Boolean);
      return J({ me: pub(me), projects, projectId: project.id, canUseMeetings, canManageMeetings, tickets: d.tickets, members, invites: me.role === "Admin" ? d.invites.filter((x) => x.projectId === project.id) : [], audit: me.role === "Admin" ? d.audit.slice(0, 300) : [], files: d.files });
    }
    if (m === "GET" && r === "invite") {
      const i = d.invites.find((x) => x.token === u.searchParams.get("t"));
      const inviteProject = i && d.projects.find((x) => x.id === i.projectId);
      return i && inviteProject ? J({ email: i.email, role: i.role, projectId: inviteProject.id, projectName: inviteProject.name, existing: d.members.some((x) => x.email === i.email) }) : J({ error: "Invalid or expired invite" }, 404);
    }
    if (m === "GET" && r === "file") {
      if (!me) return J({ error: account ? "You are not a member of this project" : "denied" }, account ? 403 : 401);
      const f = path.basename(u.searchParams.get("f") || "");
      if (!d.files.some((x) => x.id === f)) return J({ error: "missing" }, 404);
      if (me.role === "Client" && !d.files.some((x) => x.id === f && d.tickets.some((t) => t.id === x.ticket && t.createdBy === me.id))) return J({ error: "denied" }, 403);
      const buf = await getFile(f);
      if (!buf) return J({ error: "missing" }, 404);
      return new Response(buf, { headers: { "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(u.searchParams.get("n") || f)}` } });
    }
    if (r === "meetings" && m === "GET") {
      if (!canUseMeetings) return J({ error: "Team access required" }, account ? 403 : 401);
      const month = u.searchParams.get("month") || "";
      if (!/^\d{4}-\d{2}$/.test(month)) return J({ error: "Invalid calendar month" }, 400);
      const [year, monthNumber] = month.split("-").map(Number);
      if (monthNumber < 1 || monthNumber > 12) return J({ error: "Invalid calendar month" }, 400);
      const from = `${month}-01`, lastDay = new Date(Date.UTC(year, monthNumber, 0)).getUTCDate();
      const to = `${month}-${String(lastDay).padStart(2, "0")}`;
      const results = [];
      d.meetings.filter((meeting) => meeting.projectId === project.id).forEach((meeting) => {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(meeting.date) || !Number.isFinite(new Date(`${meeting.date}T00:00:00Z`).getTime())) return;
        const { occurrences = {}, ...base } = meeting;
        if (meeting.date >= from && meeting.date <= to) {
          const saved = occurrences[meeting.date] || {};
          results.push({ ...base, weekly: false, occurrenceDate: meeting.date, notes: saved.notes || "", participantSummaries: saved.participantSummaries || [], notesUpdatedAt: saved.updatedAt || "" });
        }
      });
      return J({ meetings: results.sort((a, b) => a.date.localeCompare(b.date) || a.time.localeCompare(b.time)) });
    }
    if (r === "meeting-notes" && m === "GET") {
      if (!canUseMeetings || me.role === "Client") return J({ error: "Team access required" }, 403);
      const month = u.searchParams.get("month") || "";
      if (!/^\d{4}-\d{2}$/.test(month) || Number(month.slice(5)) < 1 || Number(month.slice(5)) > 12) return J({ error: "Invalid notes month" }, 400);
      return J({ notes: d.meetingNotes.filter((note) => note.projectId === project.id && note.date.startsWith(month)).sort((a, b) => b.createdAt.localeCompare(a.createdAt)) });
    }
    if (r === "meeting-recording" && m === "GET") {
      if (!canUseMeetings || me.role === "Client") return J({ error: "Team access required" }, 403);
      const note = d.meetingNotes.find((item) => item.id === u.searchParams.get("id") && item.projectId === project.id);
      if (!note?.audioFile) return J({ error: "Recording not found" }, 404);
      const audio = await getFile(note.audioFile.id);
      if (!audio) return J({ error: "Recording file is missing" }, 404);
      return new Response(audio, { headers: { "Content-Type": note.audioFile.type || "audio/webm", "Content-Disposition": `inline; filename="${note.audioFile.name}"`, "Cache-Control": "private, no-store" } });
    }
    if (m !== "POST") return J({ error: "not found" }, 404);
    const chk = (b) => {
      if (!b.name) return "Name is required";
      if (!pwOk(b.password)) return PWMSG;
      if (d.members.some((x) => np(x.phone) && np(x.phone) === np(b.phone))) return "Phone number already in use";
      return "";
    };
    if (r === "accept") {
      const b = await req.json(), i = d.invites.find((x) => x.token === b.token);
      if (!i) return J({ error: "Invalid invite" }, 404);
      const inviteProject = d.projects.find((x) => x.id === i.projectId);
      if (!inviteProject) return J({ error: "The invited project no longer exists" }, 404);
      if (inviteProject.members.some((x) => d.members.find((member) => member.id === x.memberId)?.email === i.email)) return J({ error: "This account is already a member of the project" }, 400);
      let member = d.members.find((x) => x.email === i.email);
      if (member) {
        if (member.status === "disabled") return J({ error: "This account is disabled. Contact an administrator." }, 403);
        if (!verify(String(b.password || ""), member.pw)) return J({ error: "Incorrect account password" }, 403);
      } else {
        const e = chk(b); if (e) return J({ error: e }, 400);
        member = { id: uid().slice(0, 8), name: String(b.name).trim(), email: i.email.toLowerCase(), phone: np(b.phone), pw: hash(b.password), role: i.role, sessions: [] };
        d.members.push(member);
      }
      inviteProject.members.push({ memberId: member.id, role: i.role, status: "active" });
      const k = uid() + "." + Date.now(); member.sessions = [...(member.sessions || []), k].slice(-5);
      if (inviteProject === project) claim(d, member);
      d.invites = d.invites.filter((x) => x !== i); await save(d);
      return J({ key: k, projectId: inviteProject.id });
    }
    if (r === "forgot") {
      const b = await req.json(), id = String(b.id || "").trim().toLowerCase(), f = fails.get("f" + id) || { n: 0, t: 0 };
      if (f.n >= 3 && Date.now() - f.t < 900000) return J({ ok: true });
      fails.set("f" + id, { n: f.n + 1, t: Date.now() });
      const m = d.members.find((x) => x.email === id || (!id.includes("@") && np(x.phone) && np(x.phone) === np(id)));
      if (m && m.status !== "disabled") { await resetLink(d, m, u.origin); await save(d); }
      return J({ ok: true });
    }
    if (r === "reset") {
      const b = await req.json(), i = d.resets.find((x) => x.token === b.token && Date.now() - x.at < 3600000);
      if (!i) return J({ error: "This reset link is invalid or has expired." }, 400);
      if (!pwOk(b.password)) return J({ error: PWMSG }, 400);
      const m = d.members.find((x) => x.id === i.id);
      m.pw = hash(b.password); m.sessions = []; delete m.key;
      d.resets = d.resets.filter((x) => x.id !== i.id); log(d, m.name, "Password reset completed"); await save(d);
      return J({ ok: true });
    }
    if (r === "login") {
      const b = await req.json(), id = String(b.id || "").trim().toLowerCase(), f = fails.get(id) || { n: 0, t: 0 };
      if (f.n >= 5 && Date.now() - f.t < 300000) return J({ error: "Too many attempts. Try again in 5 minutes." }, 429);
      const m = d.members.find((x) => x.email === id || (!id.includes("@") && np(x.phone) && np(x.phone) === np(id)));
      if (!m || !verify(String(b.password || ""), m.pw)) { fails.set(id, { n: f.n + 1, t: Date.now() }); log(d, id, "Failed sign-in"); await save(d); return J({ error: "Invalid email/phone or password" }, 401); }
      if (m.status === "disabled") return J({ error: "This account is disabled. Please contact an admin." }, 403);
      fails.delete(id); log(d, m.name, "Signed in");
      const k = uid() + "." + Date.now(); m.sessions = [...(m.sessions || []), k].slice(-5); await save(d);
      return J({ key: k });
    }
    if (!me) return J({ error: "denied" }, 401);
    if (r === "meetings") {
      if (!canUseMeetings) return J({ error: "Team access required" }, 403);
      const b = await req.json();
      if (b.action === "create") {
        const title = String(b.title || "").trim().slice(0, 120), agenda = String(b.agenda || "").trim().slice(0, 3000);
        const date = String(b.date || ""), time = String(b.time || ""), duration = Number(b.duration || 60);
        const attendeeIds = Array.isArray(b.attendeeIds) ? [...new Set(b.attendeeIds.map(String))] : [];
        const parsedDate = new Date(`${date}T00:00:00Z`);
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date ||
          !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(time) || !Number.isInteger(duration) || duration < 15 || duration > 480) {
          return J({ error: "Enter a title, valid date and time, and a duration between 15 and 480 minutes" }, 400);
        }
        if (attendeeIds.length > 100) return J({ error: "A meeting can have at most 100 invitees" }, 400);
        const eligibleMembers = project.members
          .filter((entry) => entry.status !== "disabled" && entry.role !== "Client")
          .map((entry) => d.members.find((member) => member.id === entry.memberId && member.status !== "disabled"))
          .filter(Boolean);
        const attendees = attendeeIds.map((id) => eligibleMembers.find((member) => member.id === id));
        if (attendees.some((member) => !member)) return J({ error: "One or more selected invitees are not active team members in this project" }, 400);
        const online = b.online === true;
        const roomProvider = online ? String(b.roomProvider || "jitsi") : "";
        let roomName = "", roomUrl = "";
        if (online && roomProvider === "jitsi") {
          roomName = `solexes-${project.id.toLowerCase().replace(/[^a-z0-9]+/g, "-")}-${uid().slice(0, 16)}`;
          roomUrl = "https://meet.jit.si/" + roomName;
        } else if (online) {
          if (!["google-meet", "microsoft-teams", "zoom"].includes(roomProvider)) return J({ error: "Select a supported online meeting service" }, 400);
          if (b.roomUrl) {
            try {
              const parsedRoomUrl = new URL(String(b.roomUrl));
              const validHost = roomProvider === "google-meet" ? parsedRoomUrl.hostname === "meet.google.com"
                : roomProvider === "microsoft-teams" ? ["teams.microsoft.com", "teams.live.com"].includes(parsedRoomUrl.hostname)
                  : parsedRoomUrl.hostname === "zoom.us" || parsedRoomUrl.hostname.endsWith(".zoom.us");
              if (parsedRoomUrl.protocol !== "https:" || parsedRoomUrl.username || parsedRoomUrl.password || !validHost) return J({ error: "Paste a valid HTTPS meeting link from the selected conference service" }, 400);
              roomUrl = parsedRoomUrl.toString();
            } catch {
              return J({ error: "Paste a valid HTTPS meeting link from the selected conference service" }, 400);
            }
          }
        }
        const meeting = { id: uid().slice(0, 12), projectId: project.id, title, date, time, duration, agenda, weekly: false, online, roomProvider, roomName, roomUrl, attendees: attendees.map((member) => ({ id: member.id, name: member.name, email: member.email })), roster: eligibleMembers.map((member) => ({ id: member.id, name: member.name, email: member.email })), createdBy: account.id, createdByName: me.name, occurrences: {} };
        d.meetings.push(meeting); await save(d);
        const invitationResults = await Promise.all(attendees.map((member) => send(
          member.email,
          `Meeting invitation: ${title}`,
          `<p>Hello ${emailHtml(member.name)},</p><p>${emailHtml(me.name)} invited you to the <b>${emailHtml(project.name)}</b> meeting <b>${emailHtml(title)}</b>.</p><p><b>Date:</b> ${emailHtml(date)}<br><b>Time:</b> ${emailHtml(time)}<br><b>Duration:</b> ${duration} minutes</p>${roomUrl ? `<p><b>Join the online meeting:</b> <a href="${emailHtml(roomUrl)}">${emailHtml(roomUrl)}</a></p>` : online ? "<p>The organizer has not added the online meeting link yet. Please contact them for the join link.</p>" : "<p>This meeting is in person.</p>"}${agenda ? `<p><b>Agenda:</b><br>${emailHtml(agenda).replace(/\n/g, "<br>")}</p>` : ""}`
        )));
        const sent = invitationResults.filter((result) => result.sent).length;
        const emailErrors = [...new Set(invitationResults.filter((result) => !result.sent).map((result) => result.error))];
        return J({ ok: true, meeting: { ...meeting, occurrenceDate: date, notes: "", participantSummaries: [] }, inviteEmailsSent: sent, inviteEmailsTotal: attendees.length, emailErrors });
      }
      if (b.action === "notes") {
        const meeting = d.meetings.find((item) => item.id === b.id && item.projectId === project.id), occurrenceDate = String(b.occurrenceDate || "");
        const occurrence = new Date(`${occurrenceDate}T00:00:00Z`);
        if (!meeting || !/^\d{4}-\d{2}-\d{2}$/.test(occurrenceDate) || !Number.isFinite(occurrence.getTime()) || occurrence.toISOString().slice(0, 10) !== occurrenceDate) return J({ error: "Meeting not found" }, 404);
        if (occurrenceDate !== meeting.date) return J({ error: "Invalid meeting occurrence" }, 400);
        const notes = String(b.notes || "").trim();
        if (notes.length > 20000) return J({ error: "Meeting notes must be 20,000 characters or fewer" }, 400);
        meeting.occurrences = meeting.occurrences || {};
        const submitted = Array.isArray(b.participantSummaries) ? b.participantSummaries : [];
        if (submitted.length > 100) return J({ error: "Too many participant summaries" }, 400);
        const attendees = meeting.roster || meeting.attendees || [];
        const participantSummaries = submitted.map((summary) => {
          const attendee = attendees.find((member) => member.id === String(summary.memberId));
          if (!attendee) return null;
          const cleanLines = (value, maximum) => Array.isArray(value)
            ? value.slice(0, maximum).map((line) => String(line).trim().slice(0, 500)).filter(Boolean)
            : [];
          return { memberId: attendee.id, name: attendee.name, points: cleanLines(summary.points, 5), tasks: cleanLines(summary.tasks, 10) };
        });
        if (participantSummaries.some((summary) => !summary)) return J({ error: "A participant summary does not belong to this meeting's invitees" }, 400);
        const summaryLength = participantSummaries.reduce((total, summary) => total + summary.points.concat(summary.tasks).reduce((length, line) => length + line.length, 0), 0);
        if (summaryLength > 50000) return J({ error: "Participant summaries must contain 50,000 characters or fewer" }, 400);
        const previous = meeting.occurrences[occurrenceDate] || {};
        const sentSummaries = previous.sentSummaries || {};
        const mailResults = await Promise.all(participantSummaries.map(async (summary) => {
          const lines = [...summary.points.map((line) => `<li>${emailHtml(line)}</li>`), ...summary.tasks.map((line) => `<li><b>Action:</b> ${emailHtml(line)}</li>`)];
          if (!lines.length) return { id: summary.memberId, sent: false, skipped: true };
          const content = JSON.stringify({ points: summary.points, tasks: summary.tasks });
          if (sentSummaries[summary.memberId] === content) return { id: summary.memberId, sent: false, skipped: true };
          const attendee = attendees.find((member) => member.id === summary.memberId);
          const result = await send(attendee.email, `Meeting notes: ${meeting.title}`, `<p>Hello ${emailHtml(attendee.name)},</p><p>Here are your key points and action items from <b>${emailHtml(meeting.title)}</b> on ${emailHtml(occurrenceDate)}:</p><ul>${lines.join("")}</ul><p>Please reply to the meeting organizer if anything needs correcting.</p>`);
          if (result.sent) sentSummaries[summary.memberId] = content;
          return { id: summary.memberId, sent: result.sent, error: result.error, skipped: false };
        }));
        meeting.occurrences[occurrenceDate] = {
          ...previous,
          notes,
          participantSummaries,
          sentSummaries,
          updatedAt: new Date().toISOString(),
          updatedBy: me.name,
        };
        const managedNote = d.meetingNotes.find((item) => item.projectId === project.id && item.meetingId === meeting.id && item.date === occurrenceDate && item.entryType === "meeting");
        const generatedTasks = participantSummaries.flatMap((summary) => summary.tasks.map((title) => {
          const existing = (managedNote?.tasks || []).find((task) => task.title.toLowerCase() === title.toLowerCase() && task.assigneeId === summary.memberId);
          return existing || { id: uid().slice(0, 12), title, assigneeId: summary.memberId, dueDate: "", status: "Open", comments: [] };
        }));
        const taskMap = new Map((managedNote?.tasks || []).map((task) => [task.id, task]));
        generatedTasks.forEach((task) => taskMap.set(task.id, task));
        const nextTasks = [...taskMap.values()].slice(0, 200);
        const savedNote = managedNote || {
          id: uid().slice(0, 12), projectId: project.id, meetingId: meeting.id, entryType: "meeting",
          date: occurrenceDate, createdBy: account.id, createdByName: me.name, createdAt: new Date().toISOString(),
        };
        savedNote.entryType = "meeting";
        savedNote.title = meeting.title;
        savedNote.summary = notes;
        savedNote.transcript = savedNote.transcript || "";
        savedNote.participantSummaries = participantSummaries;
        savedNote.tasks = nextTasks;
        savedNote.updatedAt = new Date().toISOString();
        if (!managedNote) d.meetingNotes.push(savedNote);
        await save(d);
        const taskEmailResults = await emailAssignedTasks(d, { tasks: generatedTasks, previousTasks: managedNote?.tasks || [], title: meeting.title, projectName: project.name });
        return J({
          ok: true,
          note: savedNote,
          summaryEmailsSent: mailResults.filter((result) => result.sent).length,
          summaryEmailsFailed: mailResults.filter((result) => !result.sent && !result.skipped).length,
          taskEmailsSent: taskEmailResults.filter((result) => result.sent).length,
          taskEmailsFailed: taskEmailResults.filter((result) => !result.sent && !result.skipped).length,
          emailErrors: [...new Set([...mailResults, ...taskEmailResults].filter((result) => result.error).map((result) => result.error))],
        });
      }
      if (b.action === "delete") {
        const index = d.meetings.findIndex((item) => item.id === b.id && item.projectId === project.id), meeting = d.meetings[index];
        const isAdmin = meetingMemberships.some((entry) => entry.role === "Admin");
        if (!meeting) return J({ error: "Meeting not found" }, 404);
        if (meeting.createdBy !== account.id && !isAdmin) return J({ error: "Only the meeting creator or a team admin can delete it" }, 403);
        d.meetings.splice(index, 1); await save(d);
        return J({ ok: true });
      }
      return J({ error: "Invalid meeting action" }, 400);
    }
    if (r === "meeting-recording") {
      if (!canUseMeetings || me.role === "Client") return J({ error: "Team access required" }, 403);
      const formData = await req.formData();
      const noteId = String(formData.get("noteId") || "");
      const file = formData.get("file");
      const note = d.meetingNotes.find((item) => item.id === noteId && item.projectId === project.id);
      if (!note || !file || typeof file.arrayBuffer !== "function") return J({ error: "Meeting note or recording file is missing" }, 400);
      if (!String(file.type || "").startsWith("audio/")) return J({ error: "The uploaded recording must be an audio file" }, 400);
      const maxBytes = remote ? 4e6 : 25e6;
      if (file.size < 1 || file.size > maxBytes) return J({ error: `Recording must be smaller than ${maxBytes / 1e6} MB` }, 413);
      const extension = file.type.includes("ogg") ? ".ogg" : file.type.includes("mp4") ? ".mp4" : ".webm";
      const name = uid() + extension;
      await putFile(name, Buffer.from(await file.arrayBuffer()), file.type || "audio/webm");
      if (note.audioFile?.id) await delFile(note.audioFile.id);
      note.audioFile = { id: name, name: `${note.title.replace(/[^a-z0-9]+/gi, "-").slice(0, 60)}${extension}`, type: file.type || "audio/webm", size: file.size };
      note.updatedAt = new Date().toISOString();
      await save(d);
      return J({ ok: true, note });
    }
    if (r === "meeting-notes") {
      if (!canUseMeetings || me.role === "Client") return J({ error: "Team access required" }, 403);
      const b = await req.json();
      const activeMembers = project.members
        .filter((entry) => entry.status !== "disabled")
        .map((entry) => d.members.find((member) => member.id === entry.memberId && member.status !== "disabled"))
        .filter(Boolean);
      const cleanLines = (value, limit, lineLimit) => Array.isArray(value)
        ? value.slice(0, limit).map((line) => String(line).trim().slice(0, lineLimit)).filter(Boolean)
        : [];
      const cleanCards = (value) => {
        if (!Array.isArray(value) || value.length > 100) return null;
        const cards = value.map((card) => {
          const member = activeMembers.find((item) => item.id === String(card.memberId));
          if (!member) return null;
          return { memberId: member.id, name: member.name, points: cleanLines(card.points, 10, 500), tasks: cleanLines(card.tasks, 20, 500) };
        });
        return cards.some((card) => !card) ? null : cards;
      };
      const cleanTasks = (value, previousTasks = []) => {
        if (!Array.isArray(value) || value.length > 200) return null;
        const ids = new Set();
        const tasks = value.map((task) => {
          const id = String(task.id || uid().slice(0, 12));
          if (ids.has(id)) return null;
          ids.add(id);
          const assigneeId = String(task.assigneeId || "");
          if (assigneeId && !activeMembers.some((member) => member.id === assigneeId && member.role !== "Client")) return null;
          const dueDate = String(task.dueDate || "");
          const parsedDueDate = dueDate ? new Date(`${dueDate}T00:00:00Z`) : null;
          if (dueDate && (!/^\d{4}-\d{2}-\d{2}$/.test(dueDate) || !Number.isFinite(parsedDueDate.getTime()) || parsedDueDate.toISOString().slice(0, 10) !== dueDate)) return null;
          const comments = previousTasks.find((previous) => previous.id === id)?.comments || [];
          const status = ["Open", "In Progress", "Completed"].includes(task.status) ? task.status : "Open";
          const title = String(task.title || "").trim().slice(0, 300);
          if (!title) return null;
          return { id, title, assigneeId, dueDate, status, comments };
        });
        return tasks.some((task) => !task) ? null : tasks;
      };
      if (b.action === "create") {
        const title = String(b.title || "").trim().slice(0, 160), date = String(b.date || ""), summary = String(b.summary || ""), transcript = String(b.transcript || "");
        const meeting = b.meetingId ? d.meetings.find((item) => item.id === b.meetingId && item.projectId === project.id) : null;
        if (b.meetingId && !meeting) return J({ error: "Meeting not found in this project" }, 404);
        const parsedDate = new Date(`${date}T00:00:00Z`);
        if (!title || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(parsedDate.getTime()) || parsedDate.toISOString().slice(0, 10) !== date || (meeting && meeting.date !== date) || summary.length > 20000 || transcript.length > 50000) {
          return J({ error: "Enter a title, valid date, and notes within the allowed length" }, 400);
        }
        const participantSummaries = cleanCards(b.participantSummaries || []);
        const tasks = cleanTasks(b.tasks || []);
        if (!participantSummaries || !tasks) return J({ error: "Invalid member-specific notes or action items" }, 400);
        const note = {
          id: uid().slice(0, 12), projectId: project.id, meetingId: meeting?.id || "",
          date, title, summary, transcript, participantSummaries, tasks,
          createdBy: account.id, createdByName: me.name, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
        };
        d.meetingNotes.push(note); await save(d);
        const summaryResults = await Promise.all(participantSummaries.map(async (card) => {
          const member = activeMembers.find((item) => item.id === card.memberId);
          const lines = [
            ...card.points.map((line) => `<li>${emailHtml(line)}</li>`),
            ...card.tasks.map((line) => `<li><b>Action:</b> ${emailHtml(line)}</li>`),
          ];
          if (!member || !lines.length) return { sent: false, skipped: true };
          const result = await send(member.email, `Meeting notes for you: ${title}`, `<p>Hello ${emailHtml(member.name)},</p><p>Here are the notes assigned to you from <b>${emailHtml(project.name)}</b> on ${emailHtml(date)}.</p><p><b>Shared key points:</b><br>${emailHtml(summary).replace(/\n/g, "<br>")}</p><ul>${lines.join("")}</ul><p>Open the project portal and select Meeting Notes to review or comment on action items.</p>`);
          return { sent: result.sent, error: result.error, skipped: false };
        }));
        const taskEmailResults = await emailAssignedTasks(d, { tasks, title, projectName: project.name });
        return J({
          ok: true, note,
          summaryEmailsSent: summaryResults.filter((result) => result.sent).length,
          summaryEmailsFailed: summaryResults.filter((result) => !result.sent && !result.skipped).length,
          taskEmailsSent: taskEmailResults.filter((result) => result.sent).length,
          taskEmailsFailed: taskEmailResults.filter((result) => !result.sent && !result.skipped).length,
          emailErrors: [...new Set([...summaryResults, ...taskEmailResults].filter((result) => result.error).map((result) => result.error))],
        });
      }
      const note = d.meetingNotes.find((item) => item.id === String(b.noteId || "") && item.projectId === project.id);
      if (!note) return J({ error: "Meeting note not found" }, 404);
      if (b.action === "update") {
        const title = String(b.title || "").trim().slice(0, 160), summary = String(b.summary || ""), transcript = String(b.transcript || "");
        const participantSummaries = cleanCards(b.participantSummaries || []);
        const tasks = cleanTasks(b.tasks || [], note.tasks || []);
        if (!title || summary.length > 20000 || transcript.length > 50000 || !participantSummaries || !tasks) return J({ error: "Invalid note or action item data" }, 400);
        const previousTasks = note.tasks || [];
        note.title = title; note.summary = summary; note.transcript = transcript;
        note.participantSummaries = participantSummaries; note.tasks = tasks; note.updatedAt = new Date().toISOString();
        await save(d);
        const taskEmailResults = await emailAssignedTasks(d, { tasks, previousTasks, title, projectName: project.name });
        return J({
          ok: true, note,
          taskEmailsSent: taskEmailResults.filter((result) => result.sent).length,
          taskEmailsFailed: taskEmailResults.filter((result) => !result.sent && !result.skipped).length,
          emailErrors: [...new Set(taskEmailResults.filter((result) => result.error).map((result) => result.error))],
        });
      }
      if (b.action === "comment") {
        const task = note.tasks.find((item) => item.id === String(b.taskId || ""));
        const text = String(b.text || "").trim().slice(0, 2000);
        if (!task || !text) return J({ error: "Task or comment is missing" }, 400);
        task.comments.push({ id: uid().slice(0, 12), by: me.name, text, createdAt: new Date().toISOString() });
        task.comments = task.comments.slice(-100);
        note.updatedAt = new Date().toISOString();
        await save(d);
        return J({ ok: true, note });
      }
      if (b.action === "delete") {
        if (me.role !== "Admin") return J({ error: "Only an admin can delete meeting notes" }, 403);
        if (note.audioFile?.id) await delFile(note.audioFile.id);
        d.meetingNotes = d.meetingNotes.filter((item) => item.id !== note.id); await save(d);
        return J({ ok: true });
      }
      return J({ error: "Invalid meeting note action" }, 400);
    }
    if (r === "logoutall") { account.sessions = []; delete account.key; log(d, me.name, "Signed out of all devices"); await save(d); return J({ ok: true }); }
    if (r === "logout") { account.sessions = (account.sessions || []).filter((x) => x !== key); await save(d); return J({ ok: true }); }
    if (r === "account") {
      const b = await req.json();
      if (b.password && me.pw && !verify(String(b.current || ""), me.pw)) return J({ error: "Current password is incorrect" }, 403);
      if (b.phone) {
        if (d.members.some((x) => x !== account && np(x.phone) === np(b.phone))) return J({ error: "Phone number already in use" }, 400);
        account.phone = np(b.phone);
      }
      if (b.name) account.name = String(b.name).trim().slice(0, 80);
      if (b.password) {
        if (!pwOk(b.password)) return J({ error: PWMSG }, 400);
        account.pw = hash(b.password); account.sessions = [key]; delete account.key;
      }
      account.email = account.email.toLowerCase(); log(d, account.name, b.password ? "Changed password" : "Updated account"); await save(d);
      return J({ ok: true });
    }
    if (r === "project") {
      if (me.role !== "Admin") return J({ error: "Admin only" }, 403);
      const name = String((await req.json()).name || "").trim().slice(0, 60);
      if (!name) return J({ error: "Project name is required" }, 400);
      if (d.projects.some((x) => x.name.toLowerCase() === name.toLowerCase())) return J({ error: "A project with this name already exists" }, 400);
      const created = { id: uid().slice(0, 12), name, tickets: [], files: [], audit: [], members: [{ memberId: account.id, role: "Admin", status: "active" }] };
      created.audit.unshift({ at: new Date().toISOString(), who: me.name, act: "Created project", detail: name });
      d.projects.push(created); await save(d);
      return J({ ok: true, project: { id: created.id, name: created.name } });
    }
    if (r === "tickets") {
      if (me.role === "Client") return J({ error: "Not allowed" }, 403);
      const b = await req.json();
      const gone = d.tickets.filter((t) => !b.tickets.some((x) => x.id === t.id));
      if (gone.some((t) => me.role !== "Admin" || (t.assignees || []).includes(me.id))) return J({ error: "Not allowed to delete" }, 403);
      const old = Object.fromEntries(d.tickets.map((t) => [t.id, t]));
      if (me.role === "Collaborator" && b.tickets.some((t) => old[t.id] && JSON.stringify({ ...old[t.id], attachments: 0 }) !== JSON.stringify({ ...t, attachments: 0 }))) return J({ error: "Not allowed" }, 403);
      const jobs = [];
      b.tickets.forEach((t) => {
        const o = old[t.id];
        if (o) t.rem = o.deadline !== t.deadline ? [] : (o.rem || []);
        if (!o) log(d, me.name, "Created " + t.id, t.title);
        else if (JSON.stringify(o) !== JSON.stringify(t)) {
          const changes = ticketChanges(o, t, d.members);
          log(d, me.name, "Updated " + t.id, changes.length ? changes : t.title);
          const c = d.members.find((m) => m.id === t.createdBy);
          if (c && o.status !== "Completed" && t.status === "Completed") jobs.push(send(c.email, "Your ticket " + t.id + " has been resolved",
            `<p>Hello ${esc(c.name)},</p><p>Your ticket <b>${t.id}</b> - ${esc(t.title)} has been marked as resolved.</p><p>Please <a href="${SITE || u.origin}">sign in to the portal</a> to review the solution and check the fix in your product. If you are not satisfied, you can reopen the ticket from the portal.</p>`));
        }
      });
      gone.forEach((t) => log(d, me.name, "Deleted " + t.id, t.title));
      d.tickets = b.tickets; await save(d); await Promise.all(jobs);
      return J({ ok: true });
    }
    if (r === "client") {
      if (me.role !== "Client") return J({ error: "Not allowed" }, 403);
      const b = await req.json();
      if (b.action === "reopen") {
        const t = d.tickets.find((x) => x.id === b.id && x.createdBy === me.id), why = String(b.reason || "").trim().slice(0, 500);
        if (!t || t.status !== "Completed" || !why) return J({ error: "This ticket cannot be reopened" }, 400);
        const previousStatus = t.status;
        t.status = "Reopened"; t.closed = ""; t.notes = [...(t.notes || []), { at: td(), by: me.name, text: "Reopened: " + why }];
        log(d, me.name, "Reopened " + t.id, [
          { field: "Status", old: previousStatus, new: t.status },
          { field: "Reopen reason", old: "—", new: why },
        ]); await save(d);
        await Promise.all(emails(d, t.assignees || []).map((e) => send(e, "Ticket reopened: " + t.id, `<p>${esc(me.name)} reopened <b>${t.id}</b> - ${esc(t.title)}.</p><p>Reason: ${esc(why)}</p>`)));
        return J({ ok: true });
      }
      const x = b.ticket || {}, title = String(x.title || "").trim().slice(0, 150), details = String(x.details || "").trim().slice(0, 3000);
      if (!title) return J({ error: "Title is required" }, 400);
      if (x.id) {
        const t = d.tickets.find((y) => y.id === x.id && y.createdBy === me.id);
        if (!t || t.status === "Completed") return J({ error: "This ticket cannot be edited" }, 400);
        const previous = { ...t };
        t.title = title; t.details = details;
        const changes = ticketChanges(previous, t, d.members);
        if (changes.length) log(d, me.name, "Updated " + t.id, changes);
        await save(d);
        return J({ id: t.id });
      }
      const type = x.type === "feature" ? "feature" : "issue";
      const n = Math.max(0, ...d.tickets.filter((y) => y.type === type).map((y) => parseInt(y.id.split("-").pop()) || 0)) + 1;
      const t = { id: (type === "issue" ? "ISS-" : "FTR-") + String(n).padStart(2, "0"), type, date: td(), by: "Client", title, priority: "", assignees: [], details, version: "", deployed: "", status: "Open", closed: "", createdBy: me.id };
      d.tickets.push(t); log(d, me.name, "Created " + t.id, title); await save(d);
      await Promise.all(d.members.filter((m) => m.role === "Admin").map((m) => send(m.email, "New client ticket " + t.id, `<p>${esc(me.name)} raised <b>${t.id}</b>: ${esc(title)}</p>`)));
      return J({ id: t.id });
    }
    if (r === "addlink") {
      const b = await req.json(), tk = String(b.ticket || "");
      if (!/^https?:\/\//i.test(b.url || "") || !CATS.includes(b.cat)) return J({ error: "Enter a valid http(s) link" }, 400);
      if (me.role === "Client" && !d.tickets.some((t) => t.id === tk && t.createdBy === me.id)) return J({ error: "Not allowed" }, 403);
      d.files.unshift({ id: uid().slice(0, 12), name: String(b.name || b.url).slice(0, 120), url: b.url, cat: b.cat, by: me.name, at: td(), ticket: tk });
      log(d, me.name, "Added document link", String(b.name || b.url)); await save(d);
      return J({ ok: true });
    }
    if (r === "upload") {
      const fd = await req.formData(), f = fd.get("file"), cat = String(fd.get("cat") || ""), tk = String(fd.get("ticket") || "");
      if (me.role === "Client" && !d.tickets.some((t) => t.id === tk && t.createdBy === me.id)) return J({ error: "Not allowed" }, 403);
      if (!CATS.includes(cat)) return J({ error: "Invalid category" }, 400);
      const MAX = remote ? 4e6 : 25e6;
      if (!f || f.size > MAX) return J({ error: "File missing or larger than " + MAX / 1e6 + " MB. For bigger files use Add link." }, 400);
      const n = uid() + path.extname(f.name || "").slice(0, 10);
      await putFile(n, Buffer.from(await f.arrayBuffer()), f.type);
      d.files.unshift({ id: n, name: f.name, size: f.size, cat, by: me.name, at: td(), ticket: tk });
      log(d, me.name, "Uploaded file", f.name + " (" + cat + ")"); await save(d);
      return J({ ok: true });
    }
    if (r === "filedel") {
      const b = await req.json(), x = d.files.find((y) => y.id === b.id);
      if (me.role === "Collaborator" || me.role === "Client") return J({ error: "Not allowed" }, 403);
      if (x) { if (!x.url) await delFile(path.basename(x.id)); d.files = d.files.filter((y) => y !== x); log(d, me.name, "Deleted file", x.name); await save(d); }
      return J({ ok: true });
    }
    if (me.role !== "Admin") return J({ error: "Admin only" }, 403);
    const b = await req.json();
    if (r === "invite") {
      b.email = String(b.email || "").trim().toLowerCase();
      if (!ROLES.includes(b.role) || !b.email) return J({ error: "Invalid input" }, 400);
      const existing = d.members.find((x) => x.email === b.email);
      if (existing && project.members.some((x) => x.memberId === existing.id)) return J({ error: "Already a member of " + project.name }, 400);
      if (d.invites.some((x) => x.projectId === project.id && x.email === b.email)) return J({ error: "An invitation is already pending for this project" }, 400);
      const token = uid(), link = siteUrl(u.origin) + "/?invite=" + token;
      d.invites.push({ token, email: b.email, role: b.role, projectId: project.id }); await save(d);
      log(d, me.name, "Invited member", b.email + " to " + project.name + " as " + b.role); await save(d);
      const result = await mail(b.email, link, b.role, project.name);
      return J({ link, sent: result.sent, emailError: result.error });
    }
    if (r === "testmail") {
      const st = emailStatus();
      const result = await sendEmail({ to: account.email, subject: "Test email from Support Tracker", html: "<p>Your email setup works. This message was sent from the portal.</p>" });
      return J({ ...result, to: account.email, from: st.from, replyTo: st.replyTo });
    }
    if (r === "adminreset") {
      const x = d.members.find((y) => y.id === b.id);
      if (!x) return J({ error: "Not found" }, 404);
      const o = await resetLink(d, x, u.origin); log(d, me.name, "Sent password reset to", x.name); await save(d);
      return J(o);
    }
    if (r === "status") {
      const x = d.members.find((y) => y.id === b.id), entry = project.members.find((y) => y.memberId === b.id);
      if (x && entry && x.id !== account.id) {
        if (b.disabled && entry.role === "Admin" && entry.status !== "disabled" && project.members.filter((y) => y.role === "Admin" && y.status !== "disabled").length < 2) return J({ error: "A project must have at least one active admin" }, 400);
        entry.status = b.disabled ? "disabled" : "active"; log(d, me.name, b.disabled ? "Disabled project member" : "Enabled project member", x.name + " in " + project.name); await save(d);
      }
      return J({ ok: true });
    }
    if (r === "role") {
      const x = d.members.find((x) => x.id === b.id), entry = project.members.find((y) => y.memberId === b.id);
      if (!ROLES.includes(b.role)) return J({ error: "Invalid role" }, 400);
      if (x && entry && x.id !== account.id) {
        if (entry.role === "Admin" && b.role !== "Admin" && entry.status !== "disabled" && project.members.filter((y) => y.role === "Admin" && y.status !== "disabled").length < 2) return J({ error: "A project must have at least one active admin" }, 400);
        entry.role = b.role; log(d, me.name, "Changed project role", x.name + " to " + b.role + " in " + project.name); await save(d);
      }
      return J({ ok: true });
    }
    if (r === "remove") {
      if (b.token) d.invites = d.invites.filter((x) => x.token !== b.token || x.projectId !== project.id);
      else if (b.id !== account.id) {
        const removed = d.members.find((x) => x.id === b.id);
        const entry = project.members.find((x) => x.memberId === b.id);
        if (entry && entry.role === "Admin" && entry.status !== "disabled" && project.members.filter((x) => x.role === "Admin" && x.status !== "disabled").length < 2) return J({ error: "A project must have at least one active admin" }, 400);
        project.members = project.members.filter((x) => x.memberId !== b.id);
        project.tickets.forEach((t) => { t.assignees = (t.assignees || []).filter((id) => id !== b.id); });
        log(d, me.name, "Removed project member", (removed || {}).name + " from " + project.name);
      }
      await save(d);
      return J({ ok: true });
    }
  } catch (e) { return J({ error: String(e) }, 500); }
  return J({ error: "not found" }, 404);
}
const handle = async (req, { params }, method) => {
  try {
    return await h(req, params.p, method);
  } catch (error) {
    console.error("API request failed:", error);
    return J({ error: `API request failed: ${error.message}` }, 500);
  }
};
export const GET = (req, context) => handle(req, context, "GET");
export const POST = (req, context) => handle(req, context, "POST");
