"use strict";
const path = require("path");
const Database = require("better-sqlite3");
const { dayBounds } = require("./report");   // local-midnight epoch bounds for a day

// YYYY-MM-DD for an epoch ms in server-local time (matches dayBounds / the client)
const p2 = (n) => String(n).padStart(2, "0");
function localDayString(ms) {
  const d = new Date(ms);
  return d.getFullYear() + "-" + p2(d.getMonth() + 1) + "-" + p2(d.getDate());
}

// DB file: defaults to worklog.db beside this file; override with WORKLOG_DB
// (absolute or relative path) to run against a different database.
const db = new Database(process.env.WORKLOG_DB || path.join(__dirname, "worklog.db"));
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
CREATE TABLE IF NOT EXISTS tasks (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  title        TEXT NOT NULL,
  description  TEXT DEFAULT '',
  priority     TEXT DEFAULT 'med',          -- high | med | low
  status       TEXT DEFAULT 'in_progress',  -- in_progress | pending | hold | completed
  work_state   TEXT DEFAULT 'idle',         -- idle | running | hold | stopped
  note         TEXT DEFAULT '',             -- e.g. pending reason
  category     TEXT DEFAULT 'task',         -- task | other
  est_minutes  INTEGER DEFAULT 0,
  day          TEXT NOT NULL,               -- YYYY-MM-DD
  position     INTEGER DEFAULT 0,
  created_at   INTEGER,
  completed_at INTEGER,
  updated_at   INTEGER                       -- epoch ms of the last meaningful change (edit / status / timer)
);

CREATE TABLE IF NOT EXISTS sessions (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  task_id    INTEGER NOT NULL,
  started_at INTEGER NOT NULL,   -- epoch ms
  ended_at   INTEGER,            -- epoch ms, NULL while running
  FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS day_meta (
  day               TEXT PRIMARY KEY,
  est_time_required TEXT DEFAULT '',
  starting_time     TEXT DEFAULT '',
  est_completion    TEXT DEFAULT '',
  est_ending_date   TEXT DEFAULT '',
  others_label      TEXT DEFAULT 'Others meeting + guide',
  others_minutes    INTEGER DEFAULT 0,
  note              TEXT DEFAULT ''
);

CREATE TABLE IF NOT EXISTS breaks (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  day        TEXT NOT NULL,        -- YYYY-MM-DD
  started_at INTEGER NOT NULL,     -- epoch ms
  ended_at   INTEGER,              -- epoch ms, NULL while on break
  note       TEXT DEFAULT ''
);

-- Sticky notes: a free-floating pinboard, independent of any day. Each note
-- carries its own position/size on the board, a colour, and rich (HTML) body so
-- highlighted text survives. Global (not day-scoped) — it's a persistent canvas.
CREATE TABLE IF NOT EXISTS sticky_notes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  title      TEXT DEFAULT '',
  body       TEXT DEFAULT '',        -- HTML (supports <mark> highlights)
  color      TEXT DEFAULT 'yellow',
  x          INTEGER DEFAULT 40,
  y          INTEGER DEFAULT 40,
  w          INTEGER DEFAULT 250,
  h          INTEGER DEFAULT 220,
  z          INTEGER DEFAULT 1,
  created_at INTEGER,
  updated_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_tasks_day ON tasks(day);
CREATE INDEX IF NOT EXISTS idx_sessions_task ON sessions(task_id);
CREATE INDEX IF NOT EXISTS idx_breaks_day ON breaks(day);
`);

// migrate: sign-in / sign-out stamps on day_meta (epoch ms). SQLite has no
// "ADD COLUMN IF NOT EXISTS", so check PRAGMA table_info first.
{
  const cols = db.prepare("PRAGMA table_info(day_meta)").all().map((c) => c.name);
  if (!cols.includes("sign_in")) db.exec("ALTER TABLE day_meta ADD COLUMN sign_in INTEGER");
  if (!cols.includes("sign_out")) db.exec("ALTER TABLE day_meta ADD COLUMN sign_out INTEGER");
}

// migrate: manual time adjustment (epoch ms) added to each task's session time.
// Lets the user correct a mis-tracked timer without touching the raw sessions.
{
  const cols = db.prepare("PRAGMA table_info(tasks)").all().map((c) => c.name);
  if (!cols.includes("adjust_ms")) db.exec("ALTER TABLE tasks ADD COLUMN adjust_ms INTEGER DEFAULT 0");
  // origin_id links every day-copy of a task back to its first row, so History
  // can total the time a multi-day task took across all its days. NULL = this row
  // IS the origin (its chain id is its own id, via COALESCE(origin_id, id)).
  if (!cols.includes("origin_id")) db.exec("ALTER TABLE tasks ADD COLUMN origin_id INTEGER");
  // updated_at drives the board's "most-recently-touched first" ordering. Backfill
  // existing rows from completed_at (falling back to created_at) so pre-migration
  // tasks get a sensible initial timestamp instead of sorting to the bottom.
  if (!cols.includes("updated_at")) {
    db.exec("ALTER TABLE tasks ADD COLUMN updated_at INTEGER");
    db.exec("UPDATE tasks SET updated_at = COALESCE(completed_at, created_at) WHERE updated_at IS NULL");
  }
}

const now = () => Date.now();

// SQL fragment that stamps updated_at with the current epoch-ms (SQLite's UTC clock
// converted to Unix ms, matching Date.now()). Used by every mutation that counts as
// "touching" a task, so the board can order most-recently-changed first. Pure
// position changes (drag reorder) deliberately DON'T use this — see setPosStatus.
const TOUCH = `updated_at = CAST((julianday('now') - 2440587.5) * 86400000 AS INTEGER)`;

/* ---------- statements ---------- */
const S = {
  insertTask: db.prepare(`INSERT INTO tasks (title,description,priority,status,category,est_minutes,note,day,position,created_at,updated_at)
                          VALUES (@title,@description,@priority,@status,@category,@est_minutes,@note,@day,@position,@created_at,@created_at)`),
  // closed_ms / running_since are scoped to [@start,@end) — the viewed day only —
  // so a card shows just THIS day's tracked time, not the task's all-days total.
  // (A session belongs to the day it was started on.)
  listByDay: db.prepare(`
    SELECT t.*,
      (SELECT COALESCE(SUM(ended_at-started_at),0) FROM sessions s
         WHERE s.task_id=t.id AND s.ended_at IS NOT NULL
           AND s.started_at >= @start AND s.started_at < @end) AS closed_ms,
      (SELECT started_at FROM sessions s
         WHERE s.task_id=t.id AND s.ended_at IS NULL
           AND s.started_at >= @start AND s.started_at < @end LIMIT 1) AS running_since
    FROM tasks t
    WHERE t.day=@day
    ORDER BY t.updated_at DESC, t.id DESC`),
  // every task across all days (optional YYYY-MM-DD from/to range) — powers History
  listAll: db.prepare(`
    SELECT t.*,
      (SELECT COALESCE(SUM(ended_at-started_at),0) FROM sessions s WHERE s.task_id=t.id AND s.ended_at IS NOT NULL) AS closed_ms,
      (SELECT started_at FROM sessions s WHERE s.task_id=t.id AND s.ended_at IS NULL LIMIT 1) AS running_since
    FROM tasks t
    WHERE (@from IS NULL OR t.day >= @from) AND (@to IS NULL OR t.day <= @to)
    ORDER BY t.day DESC, t.updated_at DESC, t.id DESC`),
  getTask: db.prepare(`SELECT * FROM tasks WHERE id=?`),
  // one task with its time day-scoped to [@start,@end) — powers the details view.
  taskByIdScoped: db.prepare(`
    SELECT t.*,
      (SELECT COALESCE(SUM(ended_at-started_at),0) FROM sessions s
         WHERE s.task_id=t.id AND s.ended_at IS NOT NULL
           AND s.started_at >= @start AND s.started_at < @end) AS closed_ms,
      (SELECT started_at FROM sessions s
         WHERE s.task_id=t.id AND s.ended_at IS NULL
           AND s.started_at >= @start AND s.started_at < @end LIMIT 1) AS running_since
    FROM tasks t WHERE t.id=@id`),
  sessionsByTask: db.prepare(`SELECT started_at, ended_at FROM sessions WHERE task_id=? ORDER BY started_at ASC`),
  updateTask: db.prepare(`UPDATE tasks SET title=@title, description=@description, priority=@priority,
                          status=@status, category=@category, est_minutes=@est_minutes, note=@note, ${TOUCH} WHERE id=@id`),
  setStatus: db.prepare(`UPDATE tasks SET status=@status, work_state=@work_state, completed_at=@completed_at, ${TOUCH} WHERE id=@id`),
  setWorkState: db.prepare(`UPDATE tasks SET work_state=@work_state, ${TOUCH} WHERE id=@id`),
  // pure drag reorder — deliberately does NOT touch updated_at (see TOUCH note).
  setPosStatus: db.prepare(`UPDATE tasks SET position=@position, status=@status WHERE id=@id`),
  deleteTask: db.prepare(`DELETE FROM tasks WHERE id=?`),
  maxPos: db.prepare(`SELECT COALESCE(MAX(position),-1)+1 AS p FROM tasks WHERE day=? AND status=?`),

  // Unfinished work to roll onto @day: for each task chain, its LATEST row, when
  // that row still sits on an earlier day and is pending / in_progress. The
  // NOT EXISTS(newer row) guard makes this idempotent — once a copy lands on @day
  // that copy is the newer row, so the source is no longer picked. Oldest first.
  carrySelect: db.prepare(`
    SELECT t.* FROM tasks t
    WHERE t.status IN ('in_progress','pending')
      AND t.day < @day
      AND NOT EXISTS (SELECT 1 FROM tasks n
            WHERE COALESCE(n.origin_id,n.id) = COALESCE(t.origin_id,t.id) AND n.day > t.day)
    ORDER BY t.day ASC, t.position ASC, t.id ASC`),
  // snapshot copy of an unfinished task onto a new day: fresh timer (no sessions,
  // adjust reset), linked to the origin chain. The source row stays put, frozen.
  insertCopy: db.prepare(`
    INSERT INTO tasks (title,description,priority,status,work_state,note,category,est_minutes,origin_id,day,position,created_at,updated_at,completed_at,adjust_ms)
    VALUES (@title,@description,@priority,@status,@work_state,@note,@category,@est_minutes,@origin_id,@day,@position,@created_at,@created_at,NULL,0)`),

  setAdjust: db.prepare(`UPDATE tasks SET adjust_ms=@adjust_ms, ${TOUCH} WHERE id=@id`),
  // total tracked ms from sessions (closed + any still-running span, up to @now)
  taskSessionMs: db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN ended_at-started_at
                             ELSE @now-started_at END), 0) AS ms
    FROM sessions WHERE task_id=@tid`),

  openSession: db.prepare(`INSERT INTO sessions (task_id, started_at) VALUES (?, ?)`),
  // every start/continue span for a day's tasks, oldest first — powers the report timeline
  sessionsByDay: db.prepare(`
    SELECT s.task_id, s.started_at, s.ended_at
    FROM sessions s
    JOIN tasks t ON t.id = s.task_id
    WHERE t.day = ?
    ORDER BY s.task_id ASC, s.started_at ASC`),
  closeOpen: db.prepare(`UPDATE sessions SET ended_at=? WHERE task_id=? AND ended_at IS NULL`),
  closeAllOpen: db.prepare(`UPDATE sessions SET ended_at=? WHERE ended_at IS NULL`),
  runningTasks: db.prepare(`SELECT DISTINCT task_id FROM sessions WHERE ended_at IS NULL`),

  // every session tagged with its task's origin chain — powers History's per-day
  // breakdown + grand total for tasks spanning multiple days.
  allSessionsChain: db.prepare(`
    SELECT COALESCE(t.origin_id,t.id) AS chain, s.started_at, s.ended_at
    FROM sessions s JOIN tasks t ON t.id = s.task_id`),
  // per-chain manual-adjust total, day-copy count, and the newest day the chain
  // has a row on (its full per-day breakdown is surfaced on that latest entry).
  chainAgg: db.prepare(`
    SELECT COALESCE(origin_id,id) AS chain, COALESCE(SUM(adjust_ms),0) AS adj, COUNT(*) AS n, MAX(day) AS last_day
    FROM tasks GROUP BY COALESCE(origin_id,id)`),

  openBreak: db.prepare(`INSERT INTO breaks (day, started_at, note) VALUES (?, ?, ?)`),
  closeOpenBreak: db.prepare(`UPDATE breaks SET ended_at=? WHERE day=? AND ended_at IS NULL`),
  runningBreak: db.prepare(`SELECT * FROM breaks WHERE day=? AND ended_at IS NULL ORDER BY started_at DESC LIMIT 1`),
  breaksByDay: db.prepare(`SELECT id, started_at, ended_at, note FROM breaks WHERE day=? ORDER BY started_at ASC`),
  getBreak: db.prepare(`SELECT * FROM breaks WHERE id=?`),
  updateBreak: db.prepare(`UPDATE breaks SET started_at=@started_at, ended_at=@ended_at, note=@note WHERE id=@id`),
  deleteBreak: db.prepare(`DELETE FROM breaks WHERE id=?`),
  // total break ms for a day: closed spans + any still-open span capped at @now
  breakMsByDay: db.prepare(`
    SELECT COALESCE(SUM(CASE WHEN ended_at IS NOT NULL THEN ended_at-started_at
                             ELSE @now-started_at END), 0) AS ms
    FROM breaks WHERE day=@day`),

  getMeta: db.prepare(`SELECT * FROM day_meta WHERE day=?`),
  ensureMeta: db.prepare(`INSERT OR IGNORE INTO day_meta (day) VALUES (?)`),
  setSignIn: db.prepare(`UPDATE day_meta SET sign_in=@sign_in, sign_out=NULL WHERE day=@day`),
  setSignOut: db.prepare(`UPDATE day_meta SET sign_out=@sign_out WHERE day=@day`),
  setSignAt: db.prepare(`UPDATE day_meta SET sign_in=@sign_in, sign_out=@sign_out WHERE day=@day`),
  // past days the user forgot to sign out of (signed in, never out) — auto-closed.
  staleSignins: db.prepare(`SELECT day, sign_in FROM day_meta WHERE sign_in IS NOT NULL AND sign_out IS NULL AND day < @today`),

  // sticky notes
  insertNote: db.prepare(`INSERT INTO sticky_notes (title,body,color,x,y,w,h,z,created_at,updated_at)
                          VALUES (@title,@body,@color,@x,@y,@w,@h,@z,@created_at,@updated_at)`),
  listNotes: db.prepare(`SELECT * FROM sticky_notes ORDER BY z ASC, id ASC`),
  getNote: db.prepare(`SELECT * FROM sticky_notes WHERE id=?`),
  updateNote: db.prepare(`UPDATE sticky_notes SET title=@title, body=@body, color=@color,
                          x=@x, y=@y, w=@w, h=@h, z=@z, updated_at=@updated_at WHERE id=@id`),
  maxNoteZ: db.prepare(`SELECT COALESCE(MAX(z),0)+1 AS z FROM sticky_notes`),
  deleteNote: db.prepare(`DELETE FROM sticky_notes WHERE id=?`),
  upsertMeta: db.prepare(`
    INSERT INTO day_meta (day,est_time_required,starting_time,est_completion,est_ending_date,others_label,others_minutes,note)
    VALUES (@day,@est_time_required,@starting_time,@est_completion,@est_ending_date,@others_label,@others_minutes,@note)
    ON CONFLICT(day) DO UPDATE SET
      est_time_required=@est_time_required, starting_time=@starting_time, est_completion=@est_completion,
      est_ending_date=@est_ending_date, others_label=@others_label, others_minutes=@others_minutes, note=@note`),
};

/* ---------- helpers ---------- */
function listTasks(day) {
  const { start, end } = dayBounds(day);   // scope each task's time to this day
  return S.listByDay.all({ day, start, end });
}

// all tasks, newest day first (optional YYYY-MM-DD from/to bounds) — for History
function listAllTasks(from, to) {
  return S.listAll.all({ from: from || null, to: to || null });
}

// { task_id: [ {started_at, ended_at}, ... ] } for one day — used to build the
// per-task start / hold / continue / complete timeline in the report.
function listSessions(day) {
  const map = {};
  for (const r of S.sessionsByDay.all(day)) {
    (map[r.task_id] || (map[r.task_id] = [])).push({ started_at: r.started_at, ended_at: r.ended_at });
  }
  return map;
}

// Per-chain time stats for History (a "chain" = a task + all its day-copies,
// keyed by COALESCE(origin_id, id)):
//   perDay[chain][YYYY-MM-DD] = ms tracked that day
//   total[chain]              = ms tracked across all days (sessions only)
//   adjust[chain]             = manual-adjust ms summed over the chain's rows
//   rows[chain]               = how many day-copies the chain has
//   last[chain]               = newest day the chain has a row on
// A session counts toward the day it was STARTED on (open ones counted up to now).
function chainStats(nowMs) {
  const perDay = {}, total = {}, adjust = {}, rows = {}, last = {};
  for (const r of S.allSessionsChain.all()) {
    const end = r.ended_at != null ? r.ended_at : nowMs;
    const ms = Math.max(0, end - r.started_at);
    const d = localDayString(r.started_at);
    (perDay[r.chain] || (perDay[r.chain] = {}));
    perDay[r.chain][d] = (perDay[r.chain][d] || 0) + ms;
    total[r.chain] = (total[r.chain] || 0) + ms;
  }
  for (const a of S.chainAgg.all()) { adjust[a.chain] = a.adj || 0; rows[a.chain] = a.n; last[a.chain] = a.last_day; }
  return { perDay, total, adjust, rows, last };
}

// [{started_at, ended_at}, ...] for one day, oldest first — powers the break bar + report
function listBreaks(day) {
  return S.breaksByDay.all(day);
}

// whole break state for a day: total minutes, the open break's start + its title
// (or null), raw spans (each carries its own title in `note`).
function getBreakState(day) {
  const running = S.runningBreak.get(day);
  const ms = S.breakMsByDay.get({ day, now: now() }).ms;
  return {
    day,
    total_minutes: ms / 60000,
    running_since: running ? running.started_at : null,
    running_note: running ? (running.note || "") : "",
    breaks: listBreaks(day),
  };
}

// Start a break with an optional title (e.g. "Lunch", "Tea", "Breakfast").
// Focus mode: any running task auto-holds so productive time doesn't accrue while
// you're away. A second Start Break while already on break is a no-op (keeps the
// original span and its title).
const startBreak = db.transaction((day, note) => {
  const already = S.runningBreak.get(day);
  if (!already) {
    for (const r of S.runningTasks.all()) {
      S.closeOpen.run(now(), r.task_id);
      S.setWorkState.run({ id: r.task_id, work_state: "hold" });
    }
    S.openBreak.run(day, now(), (note || "").trim());
  }
  return getBreakState(day);
});

// End the day's open break (if any).
function endBreak(day) {
  S.closeOpenBreak.run(now(), day);
  return getBreakState(day);
}

// Edit one break: any of title (note), start, or end. Omitted fields keep their
// current value; pass ended_at:null to reopen a break (mark it still running).
// end is clamped to never fall before start. Returns the day's whole break state.
function updateBreak(id, opts) {
  const cur = S.getBreak.get(id);
  if (!cur) return null;
  const note = opts.note != null ? String(opts.note).trim() : cur.note;
  const started_at = opts.started_at != null ? Math.round(opts.started_at) : cur.started_at;
  let ended_at = opts.ended_at !== undefined
    ? (opts.ended_at != null ? Math.round(opts.ended_at) : null)
    : cur.ended_at;
  if (ended_at != null && ended_at < started_at) ended_at = started_at;
  S.updateBreak.run({ id, started_at, ended_at, note });
  return getBreakState(cur.day);
}

// Delete one break. Returns the day's whole break state (or null if not found).
function deleteBreak(id) {
  const cur = S.getBreak.get(id);
  if (!cur) return null;
  S.deleteBreak.run(id);
  return getBreakState(cur.day);
}

function createTask(t) {
  const day = t.day;
  const status = t.status || "in_progress";
  const pos = S.maxPos.get(day, status).p;
  const info = S.insertTask.run({
    title: t.title,
    description: t.description || "",
    priority: t.priority || "med",
    status,
    category: t.category || "task",
    est_minutes: t.est_minutes || 0,
    note: t.note || "",
    day,
    position: pos,
    created_at: now(),
  });
  return S.getTask.get(info.lastInsertRowid);
}

function updateTask(id, t) {
  const cur = S.getTask.get(id);
  if (!cur) return null;
  S.updateTask.run({
    id,
    title: t.title != null ? t.title : cur.title,
    description: t.description != null ? t.description : cur.description,
    priority: t.priority != null ? t.priority : cur.priority,
    status: t.status != null ? t.status : cur.status,
    category: t.category != null ? t.category : cur.category,
    est_minutes: t.est_minutes != null ? t.est_minutes : cur.est_minutes,
    note: t.note != null ? t.note : cur.note,
  });
  return S.getTask.get(id);
}

// Start / Continue a task's timer. Auto-holds any other running task (focus mode).
const startTimer = db.transaction((id) => {
  const t = S.getTask.get(id);
  if (!t) return null;
  // back to work → end any open break for this task's day
  S.closeOpenBreak.run(now(), t.day);
  // hold every other running task
  for (const r of S.runningTasks.all()) {
    if (r.task_id !== id) {
      S.closeOpen.run(now(), r.task_id);
      S.setWorkState.run({ id: r.task_id, work_state: "hold" });
    }
  }
  // if this one already running, no-op
  const already = S.runningTasks.all().some((r) => r.task_id === id);
  if (!already) S.openSession.run(id, now());
  S.setStatus.run({ id, status: "in_progress", work_state: "running", completed_at: null });
  return S.getTask.get(id);
});

function holdTimer(id) {
  S.closeOpen.run(now(), id);
  S.setWorkState.run({ id, work_state: "hold" });
  return S.getTask.get(id);
}
function stopTimer(id) {
  S.closeOpen.run(now(), id);
  S.setWorkState.run({ id, work_state: "stopped" });
  return S.getTask.get(id);
}
function completeTask(id) {
  S.closeOpen.run(now(), id);
  S.setStatus.run({ id, status: "completed", work_state: "idle", completed_at: now() });
  return S.getTask.get(id);
}
function reopenTask(id) {
  S.setStatus.run({ id, status: "in_progress", work_state: "stopped", completed_at: null });
  return S.getTask.get(id);
}
function deleteTask(id) {
  S.closeOpen.run(now(), id);
  return S.deleteTask.run(id);
}

// Manually correct a task's recorded time. `set_minutes` fixes the total
// (adjust = target − raw sessions); `delta_minutes` nudges it by +/- minutes.
// The stored adjust_ms is an offset added on top of the live session time, so
// a running timer keeps counting up from whatever total you set.
function setTaskTime(id, opts) {
  const t = S.getTask.get(id);
  if (!t) return null;
  const baseMs = S.taskSessionMs.get({ now: now(), tid: id }).ms; // closed + running-to-now
  let adjust = t.adjust_ms || 0;
  if (opts.set_minutes != null && opts.set_minutes !== "") {
    const target = Math.max(0, Number(opts.set_minutes) || 0) * 60000;
    adjust = target - baseMs;
  } else if (opts.delta_minutes != null && opts.delta_minutes !== "") {
    adjust += (Number(opts.delta_minutes) || 0) * 60000;
  }
  if (baseMs + adjust < 0) adjust = -baseMs; // don't let recorded time go negative
  S.setAdjust.run({ id, adjust_ms: Math.round(adjust) });
  return S.getTask.get(id);
}

// Reorder + reassign (drag & drop commit)
const reorder = db.transaction((items) => {
  for (const it of items) {
    const cur = S.getTask.get(it.id);
    if (!cur) continue;
    const newStatus = it.status || cur.status;
    if (newStatus === "completed" && cur.status !== "completed") {
      S.closeOpen.run(now(), it.id);
      S.setStatus.run({ id: it.id, status: "completed", work_state: "idle", completed_at: now() });
    } else if (newStatus !== "completed" && cur.status === "completed") {
      S.setStatus.run({ id: it.id, status: newStatus, work_state: "stopped", completed_at: null });
    } else if (newStatus === "hold" && cur.status !== "hold") {
      // parking a task on Hold pauses its timer so productive time stops accruing
      S.closeOpen.run(now(), it.id);
      S.setWorkState.run({ id: it.id, work_state: "hold" });
    }
    S.setPosStatus.run({ id: it.id, position: it.position, status: newStatus });
  }
});

// Roll unfinished work forward by COPYING, not moving: every pending / in_progress
// task whose latest row sits on an earlier day gets a fresh snapshot copy on `day`
// (new timer starting at zero, linked to the origin chain). The source row stays
// on its own day, frozen with that day's status and tracked time — so History and
// the previous date still show it. Re-runs are harmless: once a copy exists on
// `day` it's the newer row, so the source is no longer carried. Returns how many
// copies were made. Called when today's board opens.
const carryForward = db.transaction((day) => {
  const rows = S.carrySelect.all({ day });
  for (const r of rows) {
    // a task left running overnight: close its open session so the previous day's
    // time is finalized on its own (frozen) row before we snapshot today's copy.
    if (r.work_state === "running") {
      S.closeOpen.run(now(), r.id);
      S.setWorkState.run({ id: r.id, work_state: "hold" });
    }
    const pos = S.maxPos.get(day, r.status).p;   // append to the end of its column
    S.insertCopy.run({
      title: r.title, description: r.description, priority: r.priority,
      status: r.status,                                   // carried in the same column
      work_state: r.status === "in_progress" ? "hold" : "idle",  // paused → "▶ Continue"
      note: r.note, category: r.category, est_minutes: r.est_minutes,
      origin_id: r.origin_id || r.id,                     // link to the chain's origin
      day, position: pos, created_at: now(),
    });
  }
  return rows.length;
});

function getMeta(day) {
  const m = S.getMeta.get(day);
  return m || {
    day, est_time_required: "", starting_time: "", est_completion: "",
    est_ending_date: "", others_label: "Others meeting + guide", others_minutes: 0, note: "",
    sign_in: null, sign_out: null,
  };
}

// Stamp sign-in for the day (starts a fresh span, clears any prior sign-out).
function signIn(day) {
  S.ensureMeta.run(day);
  S.setSignIn.run({ day, sign_in: now() });
  return getMeta(day);
}

// Stamp sign-out for the day. total time = sign_out - sign_in.
// Also closes any break still open so the day's break total is final.
function signOut(day) {
  S.ensureMeta.run(day);
  S.closeOpenBreak.run(now(), day);
  S.setSignOut.run({ day, sign_out: now() });
  return getMeta(day);
}

// The last moment anything happened on `day`: the newest session end or break end
// (open spans capped at the day's own midnight, since work can't spill past it).
// Returns 0 when the day has no tracked activity at all.
function dayLastActivity(day) {
  const { start, end } = dayBounds(day);
  let last = 0;
  const bump = (v) => { if (v > last) last = v; };
  for (const s of S.sessionsByDay.all(day)) {
    if (s.started_at < start || s.started_at >= end) continue;
    bump(s.started_at);
    bump(s.ended_at != null ? Math.min(s.ended_at, end - 1) : end - 1);
  }
  for (const b of S.breaksByDay.all(day)) {
    bump(b.started_at);
    bump(b.ended_at != null ? Math.min(b.ended_at, end - 1) : end - 1);
  }
  return last;
}

// Auto sign-out days the user left open. Any PAST day (day < today) that was
// signed in but never signed out gets closed at its last tracked activity — or,
// if nothing was tracked, at the day's end — so its "total time" stops growing
// live and freezes to a sane value. Idempotent (a day with sign_out is skipped).
// `today` defaults to the server's local day; the client passes its own to match
// its timezone. Returns how many days were closed.
const autoSignOutStale = db.transaction((today) => {
  today = today || localDayString(now());
  let n = 0;
  for (const r of S.staleSignins.all({ today })) {
    const { end } = dayBounds(r.day);
    let out = dayLastActivity(r.day) || (end - 1);   // fall back to day's end
    if (out < r.sign_in) out = r.sign_in;            // never before sign-in
    if (out > end - 1) out = end - 1;                // never past midnight
    S.closeOpenBreak.run(out, r.day);                // finalize any open break too
    S.setSignOut.run({ day: r.day, sign_out: out });
    n++;
  }
  return n;
});

// Full detail for one task: its day-scoped decorated-ready row, every session it
// ever had (across days), plus its whole-chain per-day breakdown and grand total.
function taskDetails(id) {
  const base = S.getTask.get(id);
  if (!base) return null;
  const { start, end } = dayBounds(base.day);
  const row = S.taskByIdScoped.get({ id, start, end });
  const sessions = S.sessionsByTask.all(id);
  const stats = chainStats(now());
  const chain = base.origin_id || base.id;
  const perDayMs = stats.perDay[chain] || {};
  const per_day = {};
  for (const k in perDayMs) per_day[k] = perDayMs[k] / 60000;
  const total_minutes = ((stats.total[chain] || 0) + (stats.adjust[chain] || 0)) / 60000;
  return { row, sessions, per_day, total_minutes, chain_rows: stats.rows[chain] || 1 };
}

/* ---------- sticky notes ---------- */
function listNotes() { return S.listNotes.all(); }
function createNote(n) {
  n = n || {};
  const z = S.maxNoteZ.get().z;
  const info = S.insertNote.run({
    title: n.title || "", body: n.body || "", color: n.color || "yellow",
    x: n.x != null ? Math.round(n.x) : 40, y: n.y != null ? Math.round(n.y) : 40,
    w: n.w != null ? Math.round(n.w) : 250, h: n.h != null ? Math.round(n.h) : 220,
    z, created_at: now(), updated_at: now(),
  });
  return S.getNote.get(info.lastInsertRowid);
}
// Partial update: any omitted field keeps its current value (drag sends x/y,
// edit sends title/body/color, focus sends z, resize sends w/h).
function updateNote(id, n) {
  const cur = S.getNote.get(id);
  if (!cur) return null;
  const num = (v, d) => (v != null && v !== "" ? Math.round(Number(v)) : d);
  S.updateNote.run({
    id,
    title: n.title != null ? n.title : cur.title,
    body: n.body != null ? n.body : cur.body,
    color: n.color != null ? n.color : cur.color,
    x: num(n.x, cur.x), y: num(n.y, cur.y), w: num(n.w, cur.w), h: num(n.h, cur.h),
    z: num(n.z, cur.z),
    updated_at: now(),
  });
  return S.getNote.get(id);
}
function deleteNote(id) { return S.deleteNote.run(id); }
// Manually set the sign-in / sign-out stamps to specific epoch-ms times (used to
// correct a forgotten or wrong sign-in). Pass a field as null to clear it; omit a
// field (undefined) to leave it untouched.
function setSignTimes(day, m) {
  S.ensureMeta.run(day);
  const cur = getMeta(day);
  const sin = m.sign_in !== undefined ? (m.sign_in != null ? Math.round(m.sign_in) : null) : cur.sign_in;
  const sout = m.sign_out !== undefined ? (m.sign_out != null ? Math.round(m.sign_out) : null) : cur.sign_out;
  S.setSignAt.run({ day, sign_in: sin, sign_out: sout });
  return getMeta(day);
}

function saveMeta(day, m) {
  const cur = getMeta(day);
  S.upsertMeta.run({
    day,
    est_time_required: m.est_time_required != null ? m.est_time_required : cur.est_time_required,
    starting_time: m.starting_time != null ? m.starting_time : cur.starting_time,
    est_completion: m.est_completion != null ? m.est_completion : cur.est_completion,
    est_ending_date: m.est_ending_date != null ? m.est_ending_date : cur.est_ending_date,
    others_label: m.others_label != null ? m.others_label : cur.others_label,
    others_minutes: m.others_minutes != null ? m.others_minutes : cur.others_minutes,
    note: m.note != null ? m.note : cur.note,
  });
  return getMeta(day);
}

module.exports = {
  listTasks, listAllTasks, listSessions, chainStats, createTask, updateTask, deleteTask, setTaskTime,
  taskDetails, startTimer, holdTimer, stopTimer, completeTask, reopenTask,
  reorder, carryForward, getMeta, saveMeta, signIn, signOut, setSignTimes, autoSignOutStale,
  listBreaks, getBreakState, startBreak, endBreak, updateBreak, deleteBreak,
  listNotes, createNote, updateNote, deleteNote,
};
