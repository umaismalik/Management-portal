"use client";

import { useCallback, useEffect, useState } from "react";

const currentMonth = () => {
  const date = new Date();
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
};
const dateLabel = (value) => value ? new Date(value + "T00:00:00").toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" }) : "-";

export default function MeetingNotes({ projectId, keyValue, members, canDelete }) {
  const [month, setMonth] = useState(currentMonth);
  const [notes, setNotes] = useState([]);
  const [selected, setSelected] = useState(null);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [busy, setBusy] = useState(false);
  const [taskTitle, setTaskTitle] = useState("");
  const [taskAssignee, setTaskAssignee] = useState("");
  const [taskDeadline, setTaskDeadline] = useState("");
  const [commentDrafts, setCommentDrafts] = useState({});
  const [recordingUrl, setRecordingUrl] = useState("");

  const request = useCallback(async (body) => {
    try {
      const response = await fetch("/api/meeting-notes?month=" + encodeURIComponent(month) + "&project=" + encodeURIComponent(projectId), {
        method: body ? "POST" : "GET",
        headers: { "x-key": keyValue, ...(body && !(body instanceof FormData) ? { "Content-Type": "application/json" } : {}) },
        body: body ? (body instanceof FormData ? body : JSON.stringify(body)) : undefined,
      });
      const result = await response.json();
      return { ...result, ok: response.ok };
    } catch (requestError) {
      return { ok: false, error: requestError instanceof Error ? requestError.message : "Unable to reach the server" };
    }
  }, [projectId, keyValue, month]);

  useEffect(() => {
    let active = true;
    setError("");
    request().then((result) => {
      if (!active) return;
      if (!result.ok) { setError(result.error || "Could not load notes"); return; }
      setNotes(result.notes || []);
      setSelected((previous) => previous ? (result.notes || []).find((note) => note.id === previous.id) || null : null);
    });
    return () => { active = false; };
  }, [request]);
  useEffect(() => {
    let active = true;
    let url = "";
    setRecordingUrl("");
    if (selected?.audioFile) {
      fetch("/api/meeting-recording?id=" + encodeURIComponent(selected.id) + "&project=" + encodeURIComponent(projectId), { headers: { "x-key": keyValue } })
        .then(async (response) => {
          if (!response.ok) throw new Error("Could not load saved recording");
          return response.blob();
        })
        .then((blob) => {
          if (!active) return;
          url = URL.createObjectURL(blob);
          setRecordingUrl(url);
        })
        .catch((loadError) => { if (active) setError(loadError.message || "Could not load saved recording"); });
    }
    return () => { active = false; if (url) URL.revokeObjectURL(url); };
  }, [selected?.id, selected?.audioFile?.id, projectId, keyValue]);

  const save = async () => {
    if (!selected) return;
    setBusy(true); setError(""); setNotice("");
    const result = await request({ action: "update", noteId: selected.id, title: selected.title, summary: selected.summary, transcript: selected.transcript, participantSummaries: selected.participantSummaries, tasks: selected.tasks });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not save note"); return; }
    setSelected(result.note);
    setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    setNotice(result.taskEmailsFailed ? `Saved, but ${result.taskEmailsFailed} task assignment email(s) failed: ${result.emailErrors?.[0] || "check email settings"}` : `Note and tasks saved.${result.taskEmailsSent ? ` Assignment notification sent to ${result.taskEmailsSent} team member(s).` : ""}`);
  };

  const addTask = async (event) => {
    event.preventDefault();
    if (!selected || !taskTitle.trim()) return;
    const task = { id: crypto.randomUUID(), title: taskTitle.trim(), assigneeId: taskAssignee, dueDate: taskDeadline, status: "Open", comments: [] };
    const updated = { ...selected, tasks: [...(selected.tasks || []), task] };
    setSelected(updated); setTaskTitle(""); setTaskAssignee(""); setTaskDeadline("");
    setBusy(true); setError("");
    const result = await request({ action: "update", noteId: updated.id, title: updated.title, summary: updated.summary, transcript: updated.transcript, participantSummaries: updated.participantSummaries, tasks: updated.tasks });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not add task"); return; }
    setSelected(result.note); setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    if (result.taskEmailsFailed) setError(`Task saved, but assignment email failed: ${result.emailErrors?.[0] || "check email settings"}`);
    else if (result.taskEmailsSent) setNotice(`Task saved and emailed to ${result.taskEmailsSent} assigned team member(s).`);
  };

  const addComment = async (task) => {
    const text = (commentDrafts[task.id] || "").trim();
    if (!text || !selected) return;
    setBusy(true); setError("");
    const result = await request({ action: "comment", noteId: selected.id, taskId: task.id, text });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not add comment"); return; }
    setSelected(result.note); setNotes((items) => items.map((item) => item.id === result.note.id ? result.note : item));
    setCommentDrafts((drafts) => ({ ...drafts, [task.id]: "" }));
  };
  const deleteNote = async () => {
    if (!selected || !canDelete || !window.confirm("Delete this meeting note and its saved recording?")) return;
    setBusy(true); setError("");
    const result = await request({ action: "delete", noteId: selected.id });
    setBusy(false);
    if (!result.ok) { setError(result.error || "Could not delete note"); return; }
    setNotes((items) => items.filter((item) => item.id !== selected.id));
    setSelected(null); setRecordingUrl(""); setNotice("Meeting note deleted.");
  };

  return <section className="panel managed-notes">
    <div className="managed-notes-toolbar">
      <div><h2>Meeting notes & action items</h2><p>Saved notes are organized by project and month.</p></div>
      <label>Month<input type="month" value={month} onChange={(event) => { setMonth(event.target.value); setSelected(null); }} /></label>
    </div>
    {error && <div className="meeting-alert" role="alert">{error}</div>}
    {notice && <div className="meeting-success" role="status">{notice}</div>}
    <div className="managed-notes-layout">
      <div className="managed-notes-list">
        {!notes.length && <p className="meeting-empty">No saved meeting notes for this month in this project.</p>}
        {notes.map((note) => <button type="button" className={"managed-note-item" + (selected?.id === note.id ? " selected" : "")} key={note.id} onClick={() => { setSelected(note); setNotice(""); }}>
          <b>{note.title}</b><span>{dateLabel(note.date)}</span><small>{note.tasks?.length || 0} action items · {note.createdByName}</small>
        </button>)}
      </div>
      {selected && <div className="managed-note-detail">
        <div className="managed-note-meta">{dateLabel(selected.date)} · Meeting notes by {selected.createdByName}{canDelete && <button type="button" className="ic dl" disabled={busy} onClick={deleteNote}>Delete note</button>}</div>
        {recordingUrl && <div className="managed-saved-recording"><b>Saved conference recording</b><audio controls preload="metadata" src={recordingUrl}>Recording playback is unavailable in this browser.</audio></div>}
        <label>Note title<input maxLength="160" value={selected.title} onChange={(event) => setSelected({ ...selected, title: event.target.value })} /></label>
        <label>Generic key points / shared notes<textarea rows="6" maxLength="20000" value={selected.summary} onChange={(event) => setSelected({ ...selected, summary: event.target.value })} /></label>
        {!!selected.participantSummaries?.length && <section className="managed-participant-notes"><h3>Member-specific notes</h3>
          {selected.participantSummaries.map((card) => <article key={card.memberId}><b>{card.name}</b>
            <label>Key points<textarea rows="3" value={(card.points || []).join("\n")} onChange={(event) => setSelected({ ...selected, participantSummaries: selected.participantSummaries.map((item) => item.memberId === card.memberId ? { ...item, points: event.target.value.split("\n") } : item) })} /></label>
            <label>Actions<textarea rows="2" value={(card.tasks || []).join("\n")} onChange={(event) => setSelected({ ...selected, participantSummaries: selected.participantSummaries.map((item) => item.memberId === card.memberId ? { ...item, tasks: event.target.value.split("\n") } : item) })} /></label>
          </article>)}
        </section>}
        <details className="managed-transcript"><summary>Transcript</summary><textarea rows="8" maxLength="50000" value={selected.transcript} onChange={(event) => setSelected({ ...selected, transcript: event.target.value })} /></details>
        <section className="managed-tasks"><h3>Action items</h3>
          <form className="managed-task-create" onSubmit={addTask}>
            <input required maxLength="300" placeholder="Action item" value={taskTitle} onChange={(event) => setTaskTitle(event.target.value)} />
            <select value={taskAssignee} onChange={(event) => setTaskAssignee(event.target.value)}><option value="">Unassigned</option>{members.filter((member) => member.role !== "Client" && member.status === "active").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
            <input aria-label="Deadline" type="date" value={taskDeadline} onChange={(event) => setTaskDeadline(event.target.value)} />
            <button className="btn" disabled={busy}>Add task</button>
          </form>
          {(selected.tasks || []).map((task) => <article className="managed-task" key={task.id}>
            <div className="managed-task-fields"><input aria-label="Task title" maxLength="300" value={task.title} onChange={(event) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, title: event.target.value } : item) })} />
              <select aria-label="Task status" value={task.status} onChange={(event) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, status: event.target.value } : item) })}><option>Open</option><option>In Progress</option><option>Completed</option></select>
              <select aria-label="Task assignee" value={task.assigneeId || ""} onChange={(event) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, assigneeId: event.target.value } : item) })}><option value="">Unassigned</option>{members.filter((member) => member.role !== "Client" && member.status === "active").map((member) => <option key={member.id} value={member.id}>{member.name}</option>)}</select>
              <input aria-label="Task deadline" type="date" value={task.dueDate || ""} onChange={(event) => setSelected({ ...selected, tasks: selected.tasks.map((item) => item.id === task.id ? { ...item, dueDate: event.target.value } : item) })} />
              <button type="button" className="ic dl" onClick={() => setSelected({ ...selected, tasks: selected.tasks.filter((item) => item.id !== task.id) })}>Remove</button>
            </div>
            <div className="managed-comments">{(task.comments || []).map((comment) => <p key={comment.id}><b>{comment.by}</b> · {dateLabel(comment.createdAt.slice(0, 10))}<br />{comment.text}</p>)}
              <div><input maxLength="2000" placeholder="Add a comment…" value={commentDrafts[task.id] || ""} onChange={(event) => setCommentDrafts({ ...commentDrafts, [task.id]: event.target.value })} /><button type="button" className="btn alt" disabled={busy} onClick={() => addComment(task)}>Comment</button></div>
            </div>
          </article>)}
        </section>
        <div className="acts end"><button className="btn" disabled={busy} onClick={save}>{busy ? "Saving…" : "Save changes"}</button></div>
      </div>}
    </div>
  </section>;
}
