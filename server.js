"use strict";
const path = require("path");
const express = require("express");
const dbx = require("./db");
const { buildReport, computeTotals } = require("./report");

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static(path.join(__dirname, "public")));

// Attach live-computed minutes/seconds to each task row.
function decorate(rows) {
  const now = Date.now();
  return rows.map((t) => {
    const runningMs = t.running_since ? now - t.running_since : 0;
    const adjustMs = t.adjust_ms || 0;
    const closedMs = Math.max(0, (t.closed_ms || 0) + adjustMs); // includes manual adjust
    const totalMs = Math.max(0, closedMs + runningMs);
    return {
      id: t.id,
      day: t.day,
      title: t.title,
      description: t.description,
      priority: t.priority,
      status: t.status,
      work_state: t.work_state,
      note: t.note,
      category: t.category,
      est_minutes: t.est_minutes,
      position: t.position,
      adjust_ms: adjustMs,
      closed_seconds: Math.floor(closedMs / 1000),
      seconds: Math.floor(totalMs / 1000),
      minutes: totalMs / 60000,
      running: !!t.running_since,
      running_since: t.running_since || null,
      created_at: t.created_at || null,
      completed_at: t.completed_at || null,
    };
  });
}

/* ---------------- tasks ---------------- */
app.get("/api/tasks", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(decorate(dbx.listTasks(day)));
});

app.post("/api/tasks", (req, res) => {
  const b = req.body || {};
  if (!b.title || !b.day) return res.status(400).json({ error: "title and day required" });
  res.json(dbx.createTask(b));
});

app.put("/api/tasks/:id", (req, res) => {
  const out = dbx.updateTask(Number(req.params.id), req.body || {});
  if (!out) return res.status(404).json({ error: "not found" });
  res.json(out);
});

app.delete("/api/tasks/:id", (req, res) => {
  dbx.deleteTask(Number(req.params.id));
  res.json({ ok: true });
});

// full detail for one task: decorated row + its sessions + whole-chain breakdown
app.get("/api/tasks/:id/details", (req, res) => {
  const info = dbx.taskDetails(Number(req.params.id));
  if (!info) return res.status(404).json({ error: "not found" });
  const d = decorate([info.row])[0];
  d.sessions = info.sessions;
  d.per_day = info.per_day;
  d.total_minutes = info.total_minutes;
  d.chain_rows = info.chain_rows;
  res.json(d);
});

// manually correct recorded time: { set_minutes } or { delta_minutes }
app.put("/api/tasks/:id/time", (req, res) => {
  const out = dbx.setTaskTime(Number(req.params.id), req.body || {});
  if (!out) return res.status(404).json({ error: "not found" });
  res.json(out);
});

/* timer actions */
const action = (fn) => (req, res) => {
  const out = fn(Number(req.params.id));
  if (!out) return res.status(404).json({ error: "not found" });
  res.json(out);
};
app.post("/api/tasks/:id/start", action(dbx.startTimer));
app.post("/api/tasks/:id/continue", action(dbx.startTimer));
app.post("/api/tasks/:id/hold", action(dbx.holdTimer));
app.post("/api/tasks/:id/stop", action(dbx.stopTimer));
app.post("/api/tasks/:id/complete", action(dbx.completeTask));
app.post("/api/tasks/:id/reopen", action(dbx.reopenTask));

app.post("/api/reorder", (req, res) => {
  const items = (req.body && req.body.items) || [];
  dbx.reorder(items);
  res.json({ ok: true });
});

// carry unfinished (pending / in_progress) tasks from earlier days onto `date`.
// Called by the board when today opens so leftover work rolls forward automatically.
app.post("/api/carry-forward", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json({ moved: dbx.carryForward(day) });
});

// auto sign-out any past day left open (signed in, never out). Called on load so a
// forgotten sign-out freezes to the day's last activity instead of ticking forever.
app.post("/api/auto-signout", (req, res) => {
  res.json({ closed: dbx.autoSignOutStale(req.query.today || null) });
});

/* ---------------- history (all days, grouped by date + status) -------------
   Each row's `minutes` is scoped to ITS OWN day (which day took how much time),
   while `total_minutes` is the task's grand total across every day it spanned
   (its origin chain). `per_day` carries the full breakdown so a legacy row that
   still holds several days' sessions can show where its time went. */
app.get("/api/history", (req, res) => {
  const raw = dbx.listAllTasks(req.query.from, req.query.to);
  const now = Date.now();
  const stats = dbx.chainStats(now);
  const rows = raw.map((t) => {
    const chain = t.origin_id || t.id;
    const perDayMs = stats.perDay[chain] || {};
    const dayMs = (perDayMs[t.day] || 0) + (t.adjust_ms || 0);              // this day's slice
    const totalMs = (stats.total[chain] || 0) + (stats.adjust[chain] || 0); // whole-chain total
    const d = decorate([t])[0];
    d.minutes = dayMs / 60000;
    d.total_minutes = totalMs / 60000;
    d.chain_rows = stats.rows[chain] || 1;
    d.is_chain_latest = t.day === stats.last[chain];   // newest entry carries the full breakdown
    d.per_day = {};
    for (const k in perDayMs) d.per_day[k] = perDayMs[k] / 60000;
    return d;
  });
  const order = new Map();  // day -> group (insertion order = day DESC from query)
  for (const t of rows) {
    let g = order.get(t.day);
    if (!g) { g = { day: t.day, in_progress: [], pending: [], hold: [], completed: [] }; order.set(t.day, g); }
    (g[t.status] || (g[t.status] = [])).push(t);
  }
  const days = [...order.values()].map((g) => {
    const all = [...g.in_progress, ...g.pending, ...g.hold, ...g.completed];
    const T = computeTotals(all, dbx.getMeta(g.day), dbx.getBreakState(g.day));
    // this day's tracked task time (day-scoped) — shown in the day header.
    const taskTotal = all.reduce((s, t) => s + (t.minutes || 0), 0);
    return {
      ...g,
      counts: { in_progress: g.in_progress.length, pending: g.pending.length, hold: g.hold.length, completed: g.completed.length },
      productive_minutes: T.productive,
      task_total_minutes: taskTotal,
      total_minutes: T.total,
      break_minutes: T.breakMin,
      net_working_minutes: T.net,
      other_minutes: T.other,
    };
  });
  res.json(days);
});

/* ---------------- day meta / notes ---------------- */
app.get("/api/meta", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(dbx.getMeta(day));
});
app.put("/api/meta", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(dbx.saveMeta(day, req.body || {}));
});

/* ---------------- sign in / out (defines the day's "total time" span) ------ */
app.post("/api/signin", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(dbx.signIn(day));
});
app.post("/api/signout", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(dbx.signOut(day));
});
// manually correct the sign-in / sign-out times: { sign_in, sign_out } epoch ms
// (null clears, omitted leaves unchanged)
app.put("/api/signtime", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(dbx.setSignTimes(day, req.body || {}));
});

/* ---------------- breaks (deducted from total to give net working time) ---- */
app.get("/api/breaks", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(dbx.getBreakState(day));
});
app.post("/api/break/start", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(dbx.startBreak(day));
});
app.post("/api/break/end", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  res.json(dbx.endBreak(day));
});

/* ---------------- sticky notes (global pinboard) ---------------- */
app.get("/api/notes", (req, res) => res.json(dbx.listNotes()));
app.post("/api/notes", (req, res) => res.json(dbx.createNote(req.body || {})));
app.put("/api/notes/:id", (req, res) => {
  const out = dbx.updateNote(Number(req.params.id), req.body || {});
  if (!out) return res.status(404).json({ error: "not found" });
  res.json(out);
});
app.delete("/api/notes/:id", (req, res) => {
  dbx.deleteNote(Number(req.params.id));
  res.json({ ok: true });
});

/* ---------------- report ---------------- */
app.get("/api/report", (req, res) => {
  const day = req.query.date;
  if (!day) return res.status(400).json({ error: "date required" });
  const tasks = decorate(dbx.listTasks(day));
  const meta = dbx.getMeta(day);
  const sessions = dbx.listSessions(day);
  const breaks = dbx.getBreakState(day);
  const { text, totals } = buildReport(day, tasks, meta, sessions, breaks);
  res.json({ text, totals });
});

app.listen(PORT, () => {
  console.log(`\n  ✅ Worklog Tracker running →  http://localhost:${PORT}\n`);
});
