"use strict";

const pad2 = (n) => String(n).padStart(2, "0");

// Per-task style used in your report: 2Hours, 1.30Hours, .30 (H.MM where MM = minutes)
function fmtHM(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  if (h === 0) return m === 0 ? "0" : "." + pad2(m);
  if (m === 0) return String(h);
  return h + "." + pad2(m);
}

// Totals style: 08:25 (HH:MM)
function fmtColon(min) {
  min = Math.max(0, Math.round(min));
  const h = Math.floor(min / 60), m = min % 60;
  return pad2(h) + ":" + pad2(m);
}

// epoch ms -> HH:MM (server local time; app runs on the user's own machine)
function hhmm(ms) {
  const d = new Date(ms);
  return pad2(d.getHours()) + ":" + pad2(d.getMinutes());
}

// YYYY-MM-DD -> DD-MM-YYYY
function fmtDMY(iso) {
  const p = String(iso).split("-");
  return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : iso;
}

// local-midnight epoch bounds [start, end) for a YYYY-MM-DD day
function dayBounds(day) {
  const p = String(day).split("-").map(Number);
  const y = p[0], mo = (p[1] || 1) - 1, d = p[2] || 1;
  return { start: new Date(y, mo, d).getTime(), end: new Date(y, mo, d + 1).getTime() };
}

const EVENT_LABEL = {
  start: "▶ Start",
  continue: "▶ Continue",
  pause: "⏸ Hold",
  stop: "⏹ Stop",
  complete: "✅ Complete",
};

// Turn a task's raw sessions + completion stamp into an ordered event list:
// each session's start = Start (first) / Continue (later), each end = Hold — and
// the final end becomes Complete (if the task is done) or Stop (if it was stopped).
function taskEvents(task, sessions) {
  const ev = [];
  (sessions || []).forEach((s, i) => {
    ev.push({ t: s.started_at, kind: i === 0 ? "start" : "continue" });
    if (s.ended_at != null) ev.push({ t: s.ended_at, kind: "pause" });
  });
  const last = ev[ev.length - 1];
  if (task.completed_at) {
    // the timer usually closes the moment you complete, so a same-instant pause
    // IS the completion — relabel it instead of printing two events.
    if (last && last.kind === "pause" && Math.abs(last.t - task.completed_at) < 3000) last.kind = "complete";
    else ev.push({ t: task.completed_at, kind: "complete" });
  } else if (last && last.kind === "pause" && task.work_state === "stopped") {
    last.kind = "stop";
  }
  return ev;
}

// Single source of truth for a day's headline numbers (used by both the report
// and History) so the two never drift:
//   productive = Σ task-timer time (category=task)
//   total      = sign-in→sign-out span (live to now if not signed out yet;
//                falls back to productive + other + others when never signed in)
//   break      = Σ break spans
//   net        = total − break (never below zero) = actual working time
function computeTotals(tasks, meta, breaks) {
  meta = meta || {};
  breaks = breaks || { total_minutes: 0 };
  const productive = tasks.filter((t) => t.category === "task").reduce((s, t) => s + t.minutes, 0);
  const otherTasksMin = tasks.filter((t) => t.category === "other" && t.minutes > 0).reduce((s, t) => s + t.minutes, 0);
  const othersMin = meta.others_minutes || 0;
  let clockMin = null;
  if (meta.sign_in && meta.sign_out) clockMin = (meta.sign_out - meta.sign_in) / 60000;
  else if (meta.sign_in) clockMin = (Date.now() - meta.sign_in) / 60000;
  const total = clockMin != null ? clockMin : productive + otherTasksMin + othersMin;
  const breakMin = breaks.total_minutes || 0;
  const net = Math.max(0, total - breakMin);
  // "other time" = untracked working time = net working − productive (real task timer).
  // The slice of the workday spent on things no task timer captured (meetings you
  // didn't log, context switching, etc.). Never below zero.
  const other = Math.max(0, net - productive);
  return { productive, otherTasksMin, othersMin, clockMin, total, breakMin, net, other };
}

// tasks: [{title, status, category, minutes, note}], meta: day_meta row,
// sessions: { task_id: [{started_at, ended_at}, ...] } for the timeline section,
// breaks: { total_minutes, breaks: [{started_at, ended_at}, ...] } from getBreakState
function buildReport(day, tasks, meta, sessions, breaks) {
  sessions = sessions || {};
  breaks = breaks || { total_minutes: 0, breaks: [] };

  // Day-scope every task's time to THIS day. Carried-forward tasks drag their
  // old sessions along (sessions hang off the task, not the day), so the report
  // must count only the time tracked on `day` — a session belongs to the day it
  // was started on. Manual adjust_ms stays with the task. History keeps grand
  // totals; only the daily report is sliced this way.
  const { start, end } = dayBounds(day);
  const now = Date.now();
  const daySessions = {};
  for (const id in sessions) {
    daySessions[id] = sessions[id].filter((s) => s.started_at >= start && s.started_at < end);
  }
  const dayMinutes = (t) => {
    let ms = (daySessions[t.id] || []).reduce(
      (a, s) => a + ((s.ended_at != null ? s.ended_at : now) - s.started_at), 0);
    ms += t.adjust_ms || 0;
    return Math.max(0, ms) / 60000;
  };
  tasks = tasks.map((t) => ({ ...t, minutes: dayMinutes(t) }));
  sessions = daySessions; // timeline below shows only this day's start/hold events

  const T = computeTotals(tasks, meta, breaks);
  const inprog = tasks.filter((t) => t.status === "in_progress");
  const done = tasks.filter((t) => t.status === "completed");
  const pending = tasks.filter((t) => t.status === "pending");
  const hold = tasks.filter((t) => t.status === "hold");

  const L = [];
  L.push("📅 Work Report");
  L.push("🗓 Date: " + fmtDMY(day));
  L.push("🧑‍💻 Task Summary:");
  L.push("");

  L.push("🔄 Running / In Progress");
  if (inprog.length) inprog.forEach((t, i) => L.push(`  ${i + 1}. ${t.title}.(${fmtHM(t.minutes)}Hours)`));
  else L.push("—");
  L.push("");

  L.push("✅ Completed");
  if (done.length) done.forEach((t, i) => L.push(`  ${i + 1}. ${t.title}.(${fmtHM(t.minutes)}Hours).`));
  else L.push("—");
  L.push("");

  L.push("⏳ Pending");
  if (pending.length) pending.forEach((t) => L.push(`${t.title}.(${t.note || "pending"}).`));
  else L.push("—");
  L.push("");

  // ⏸ On Hold — parked tasks with time already tracked. Only printed when some
  // exist so hold-free days keep the original report format unchanged.
  if (hold.length) {
    L.push("⏸ On Hold");
    hold.forEach((t) => L.push(`${t.title}.(${fmtHM(t.minutes)}Hours)${t.note ? " — " + t.note : ""}.`));
    L.push("");
  }

  // 🕒 Task Timeline — kon task kokhon start / hold / continue / complete hoyeche
  L.push("🕒 Task Timeline");
  const timed = tasks.filter((t) => (sessions[t.id] && sessions[t.id].length) || t.completed_at);
  if (timed.length) {
    timed.forEach((t, i) => {
      const ev = taskEvents(t, sessions[t.id]);
      L.push(`${i + 1}. ${t.title}  (${fmtHM(t.minutes)}Hours)`);
      L.push("   " + (ev.length ? ev.map((e) => `${hhmm(e.t)} ${EVENT_LABEL[e.kind]}`).join("  →  ") : "—"));
    });
  } else {
    L.push("—");
  }
  L.push("");

  // ☕ Breaks — start → end of each break, with duration. Only printed when
  // breaks exist so break-free days keep the original report format.
  const breakSpans = breaks.breaks || [];
  const breakMin = T.breakMin;
  if (breakSpans.length) {
    L.push("☕ Breaks");
    breakSpans.forEach((b, i) => {
      const end = b.ended_at != null ? hhmm(b.ended_at) : "…";
      const durMs = (b.ended_at != null ? b.ended_at : Date.now()) - b.started_at;
      L.push(`  ${i + 1}. ${hhmm(b.started_at)} → ${end}  (${fmtHM(durMs / 60000)}Hours)`);
    });
    L.push(`   Total break: ${fmtColon(breakMin)}Hours`);
    L.push("");
  }

  L.push("⏱ Estimated Work Duration:");
  L.push("Estimated Time Required: " + (meta.est_time_required || ""));
  L.push("📅 Starting Time: " + (meta.starting_time || ""));
  L.push("📅 Estimated Completion: " + (meta.est_completion || ""));
  L.push("Estimated Ending Date: " + (meta.est_ending_date || ""));
  L.push("");

  // Flat list of every real task with its time — numbered continuously across
  // real "task" rows and tracked "other" rows so the bottom list reads 1..N.
  let flatN = 0;
  const flat = tasks.filter((t) => t.category === "task");
  flat.forEach((t) => L.push(`${++flatN}. ${t.title}.(${fmtHM(t.minutes)}Hours).`));

  // "Other" tasks (meeting/guide) that have tracked time — listed but not "productive"
  const otherTasks = tasks.filter((t) => t.category === "other" && t.minutes > 0);
  otherTasks.forEach((t) => L.push(`${++flatN}. ${t.title}.(${fmtHM(t.minutes)}Hours).`));

  if (T.othersMin > 0) L.push(`${meta.others_label || "Others meeting + guide"} = ${fmtHM(T.othersMin)} +`);

  L.push("------------------------------------------------------------------------------------");

  L.push("total time: " + fmtColon(T.total) + "Hours.");
  if (breakMin > 0) {
    L.push("break time: " + fmtColon(breakMin) + "Hours.");
    L.push("net working: " + fmtColon(T.net) + "Hours.");
  }
  L.push("productive Hours: " + fmtColon(T.productive) + "Hours");
  // other (untracked) time = net working − productive. Only shown once there's a
  // real workday span (sign-in), so a bare task-only day keeps the old format.
  if (meta.sign_in && T.other > 0) L.push("other time: " + fmtColon(T.other) + "Hours.");
  L.push("");
  L.push("Sign In: " + (meta.sign_in ? hhmm(meta.sign_in) : "—"));
  L.push("Sign Out: " + (meta.sign_out ? hhmm(meta.sign_out) : "—"));

  return {
    text: L.join("\n"),
    totals: {
      productive_minutes: T.productive,
      other_tasks_minutes: T.otherTasksMin,
      others_minutes: T.othersMin,
      clock_minutes: T.clockMin,
      total_minutes: T.total,
      break_minutes: T.breakMin,
      net_working_minutes: T.net,
      other_minutes: T.other,
    },
  };
}

module.exports = { buildReport, computeTotals, fmtHM, fmtColon, fmtDMY, dayBounds };
