"use strict";
(function () {
  const $ = (id) => document.getElementById(id);
  const api = async (url, opts) => {
    const r = await fetch(url, Object.assign({ headers: { "Content-Type": "application/json" } }, opts));
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || r.statusText);
    return r.status === 204 ? null : r.json();
  };
  const esc = (s) => (s || "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
  const pad2 = (n) => String(n).padStart(2, "0");
  const todayStr = () => { const d = new Date(); return d.getFullYear() + "-" + pad2(d.getMonth() + 1) + "-" + pad2(d.getDate()); };
  const clock = (sec) => { sec = Math.floor(sec); return pad2(Math.floor(sec / 3600)) + ":" + pad2(Math.floor(sec / 60) % 60) + ":" + pad2(sec % 60); };
  const hm = (sec) => { const m = Math.round(sec / 60); const h = Math.floor(m / 60), mm = m % 60; return h ? `${h}h ${mm}m` : `${mm}m`; };

  let date = todayStr();
  let tasks = [];
  let signInAt = null, signOutAt = null;   // epoch ms for the day's total-time span
  let breakClosedMs = 0, breakRunningSince = null;   // day's break time (deducted from total)
  const dispSec = (t) => (t.closed_seconds || 0) + (t.running ? (Date.now() - t.running_since) / 1000 : 0);
  const breakMs = () => breakClosedMs + (breakRunningSince ? Date.now() - breakRunningSince : 0);

  /* ---------- theme ---------- */
  const savedTheme = localStorage.getItem("wl_theme") || "light";
  document.documentElement.setAttribute("data-theme", savedTheme);
  $("themeBtn").onclick = () => {
    const t = document.documentElement.getAttribute("data-theme") === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", t);
    localStorage.setItem("wl_theme", t);
  };

  /* ---------- load ---------- */
  $("datePick").value = date;
  $("datePick").onchange = () => { date = $("datePick").value; load(); };

  async function load() {
    // freeze any PAST day the user forgot to sign out of (auto sign-out at its last
    // activity). Never touches today. Non-fatal on an un-updated server.
    try { await api("/api/auto-signout?today=" + todayStr(), { method: "POST" }); } catch {}
    // opening today auto-rolls unfinished (pending / in_progress) tasks from
    // earlier days onto today. Non-fatal: an un-updated server just skips it.
    if (date === todayStr()) {
      try { await api("/api/carry-forward?date=" + date, { method: "POST" }); } catch {}
    }
    tasks = await api("/api/tasks?date=" + date);
    const meta = await api("/api/meta?date=" + date);
    $("m_est_time_required").value = meta.est_time_required || "";
    $("m_starting_time").value = meta.starting_time || "";
    $("m_est_completion").value = meta.est_completion || "";
    $("m_est_ending_date").value = meta.est_ending_date || "";
    $("m_others_label").value = meta.others_label || "";
    $("m_others_minutes").value = meta.others_minutes || "";
    $("dailyNote").value = meta.note || "";
    signInAt = meta.sign_in || null;
    signOutAt = meta.sign_out || null;
    // break state is non-fatal: if the endpoint is missing (server not restarted
    // after an update) don't let it block the task board from rendering.
    try { applyBreakState(await api("/api/breaks?date=" + date)); }
    catch { breakClosedMs = 0; breakRunningSince = null; }
    renderSign();
    renderBreak();
    render();
  }

  // pull closed-break ms out of the raw spans so the running span can tick live
  function applyBreakState(bs) {
    const spans = (bs && bs.breaks) || [];
    breakClosedMs = spans.reduce((s, b) => s + (b.ended_at != null ? b.ended_at - b.started_at : 0), 0);
    breakRunningSince = (bs && bs.running_since) || null;
  }

  /* ---------- sign in / out ---------- */
  const hhmm = (ms) => { const d = new Date(ms); return pad2(d.getHours()) + ":" + pad2(d.getMinutes()); };
  const spanClock = () => {
    if (!signInAt) return "00:00";
    const mins = Math.max(0, Math.round(((signOutAt || Date.now()) - signInAt) / 60000));
    return pad2(Math.floor(mins / 60)) + ":" + pad2(mins % 60);
  };
  function renderSign() {
    const info = $("signInfo"), inBtn = $("signInBtn"), outBtn = $("signOutBtn"), bar = $("signbar");
    outBtn.disabled = !signInAt || !!signOutAt;
    // signed in and not yet signed out → "working": animated border on the sign bar
    bar.classList.toggle("working", !!signInAt && !signOutAt);
    bar.classList.toggle("done", !!signInAt && !!signOutAt);
    if (!signInAt) { info.textContent = "Not signed in"; return; }
    info.textContent = signOutAt
      ? `In ${hhmm(signInAt)} · Out ${hhmm(signOutAt)} · total ${spanClock()}`
      : `In ${hhmm(signInAt)} · working… ${spanClock()}`;
  }
  $("signInBtn").onclick = async () => {
    if (signInAt && !signOutAt && !confirm("Already signed in. Reset the sign-in time?")) return;
    const m = await api("/api/signin?date=" + date, { method: "POST" });
    signInAt = m.sign_in || null; signOutAt = m.sign_out || null; renderSign();
  };
  $("signOutBtn").onclick = async () => {
    const m = await api("/api/signout?date=" + date, { method: "POST" });
    signInAt = m.sign_in || null; signOutAt = m.sign_out || null; renderSign();
    applyBreakState(await api("/api/breaks?date=" + date)); renderBreak();  // sign-out closes open break
  };

  // local-midnight epoch for the viewed day + "HH:MM" -> epoch ms on that day
  const dayStartMs = (dstr) => { const p = String(dstr).split("-").map(Number); return new Date(p[0], (p[1] || 1) - 1, p[2] || 1).getTime(); };
  function parseHM(s) {
    const m = String(s).trim().match(/^(\d{1,2}):([0-5]?\d)$/);   // H:MM / HH:MM
    if (!m) return null;
    const h = +m[1], mm = +m[2];
    return h > 23 ? null : h * 3600000 + mm * 60000;
  }
  $("signEditBtn").onclick = async () => {
    const inStr = prompt("Sign-in time (HH:MM).  Empty = clear.", signInAt ? hhmm(signInAt) : "");
    if (inStr === null) return;
    const outStr = prompt("Sign-out time (HH:MM).  Empty = still working (open).", signOutAt ? hhmm(signOutAt) : "");
    if (outStr === null) return;
    const start = dayStartMs(date);
    const body = {};
    if (inStr.trim() === "") body.sign_in = null;
    else { const ms = parseHM(inStr); if (ms == null) return alert("Time bujhte parlam na: " + inStr + "\n(HH:MM format e dao, jemon 09:30)"); body.sign_in = start + ms; }
    if (outStr.trim() === "") body.sign_out = null;
    else { const ms = parseHM(outStr); if (ms == null) return alert("Time bujhte parlam na: " + outStr + "\n(HH:MM format e dao, jemon 18:00)"); body.sign_out = start + ms; }
    if (body.sign_in != null && body.sign_out != null && body.sign_out < body.sign_in)
      return alert("Sign-out time sign-in time-er age hote pare na.");
    try {
      const m = await api("/api/signtime?date=" + date, { method: "PUT", body: JSON.stringify(body) });
      signInAt = m.sign_in || null; signOutAt = m.sign_out || null;
      renderSign(); renderStats();
    } catch (err) {
      alert("Save hoyni: " + (err && err.message ? err.message : err) +
        "\n\nServer ta restart korte hobe (npm start) — notun /api/signtime route lagbe.");
    }
  };

  /* ---------- breaks ---------- */
  const breakClock = () => { const m = Math.round(breakMs() / 60000); return pad2(Math.floor(m / 60)) + ":" + pad2(m % 60); };
  function renderBreak() {
    const bar = $("breakbar"), info = $("breakInfo"), startBtn = $("breakStartBtn"), endBtn = $("breakEndBtn");
    const onBreak = !!breakRunningSince;
    bar.classList.toggle("on-break", onBreak);
    startBtn.disabled = onBreak;
    endBtn.disabled = !onBreak;
    if (onBreak) info.textContent = `on break… ${breakClock()}  ·  today ${hm(breakMs() / 1000)}`;
    else if (breakClosedMs > 0) info.textContent = `today’s breaks: ${breakClock()}`;
    else info.textContent = "No breaks yet";
  }
  $("breakStartBtn").onclick = async () => {
    applyBreakState(await api("/api/break/start?date=" + date, { method: "POST" }));
    renderBreak();
    load();   // a running task was auto-held → refresh cards
  };
  $("breakEndBtn").onclick = async () => {
    applyBreakState(await api("/api/break/end?date=" + date, { method: "POST" }));
    renderBreak();
  };

  /* ---------- render ---------- */
  const groups = ["in_progress", "pending", "hold", "completed"];
  function render() {
    groups.forEach((g) => { $("col-" + g).innerHTML = ""; });
    const counts = { in_progress: 0, pending: 0, hold: 0, completed: 0 };
    tasks.forEach((t) => { counts[t.status]++; $("col-" + t.status).appendChild(card(t)); });
    groups.forEach((g) => {
      $("cnt-" + g).textContent = counts[g];
      if (counts[g] === 0) $("col-" + g).innerHTML = '<div class="empty">Ekhane drop koro</div>';
    });
    renderStats();
    tick();
  }

  function card(t) {
    const d = document.createElement("div");
    d.className = "card p-" + t.priority + (t.running ? " running" : "") + (t.status === "completed" ? " done" : "");
    d.draggable = true;
    d.dataset.id = t.id;
    const badgeP = `<span class="badge ${t.priority}">${t.priority === "high" ? "High" : t.priority === "med" ? "Medium" : "Low"}</span>`;
    const badgeC = t.category === "other" ? '<span class="badge cat">other</span>' : "";
    const estTag = t.est_minutes ? `<span class="est-tag">est ${hm(t.est_minutes * 60)}</span>` : "";
    let controls = "";
    if (t.status === "completed") {
      controls = `<button class="mini" data-act="reopen">↩ Reopen</button>`;
    } else if (t.running) {
      controls = `<button class="mini" data-act="hold">⏸ Hold</button>
                  <button class="mini" data-act="stop">⏹ Stop</button>
                  <button class="mini ok" data-act="complete">✓ Complete</button>`;
    } else {
      const label = t.work_state === "hold" || t.work_state === "stopped" ? "▶ Continue" : "▶ Start";
      controls = `<button class="mini go" data-act="start">${label}</button>
                  <button class="mini ok" data-act="complete">✓ Complete</button>`;
    }
    d.innerHTML =
      `<div class="c-tools">
         <button class="c-edit" data-act="edit" title="Edit everything">✏</button>
         <button class="c-x" data-act="del" title="Delete">✕</button>
       </div>
       <div class="c-title" data-act="details" title="Details view">${esc(t.title)}</div>
       ${t.description ? `<div class="c-desc">${esc(t.description)}</div>` : ""}
       ${t.status === "pending" && t.note ? `<div class="c-desc">⛔ ${esc(t.note)}</div>` : ""}
       <div class="c-meta">${badgeP}${badgeC}${estTag}
         <span class="time edit-time ${t.running ? "live" : ""}" data-time="${t.id}" data-act="time" title="Click kore time edit koro">${clock(dispSec(t))}</span>
       </div>
       <div class="c-controls">${controls}</div>`;

    d.querySelectorAll("[data-act]").forEach((b) => {
      b.onclick = (e) => { e.stopPropagation(); handle(t, b.dataset.act); };
    });
    // drag
    d.addEventListener("dragstart", () => d.classList.add("dragging"));
    d.addEventListener("dragend", () => { d.classList.remove("dragging"); commitOrder(); });
    return d;
  }

  async function handle(t, act) {
    if (act === "del") { if (!confirm("Delete this task?")) return; await api("/api/tasks/" + t.id, { method: "DELETE" }); return load(); }
    if (act === "edit") return openEdit(t);
    if (act === "details") return openDetails(t);
    if (act === "time") return editTime(t);
    await api(`/api/tasks/${t.id}/${act}`, { method: "POST" });
    load();
  }

  // "2h 30m" | "2:30" | "90m" | "1.30" (H.MM) | "90"  ->  minutes (or null)
  function parseDur(str) {
    str = String(str).trim().toLowerCase();
    if (!str) return null;
    let m = str.match(/^(\d+):([0-5]?\d)$/);              // H:MM
    if (m) return (+m[1]) * 60 + (+m[2]);
    if (/[hm]/.test(str)) {                               // 2h 30m / 2h / 30m
      let total = 0, ok = false;
      const h = str.match(/(\d+(?:\.\d+)?)\s*h/); if (h) { total += parseFloat(h[1]) * 60; ok = true; }
      const mm = str.match(/(\d+)\s*m/);           if (mm) { total += parseInt(mm[1], 10); ok = true; }
      return ok ? Math.round(total) : null;
    }
    m = str.match(/^(\d+)\.(\d{1,2})$/);                  // 1.30 -> report H.MM
    if (m) return (+m[1]) * 60 + (+m[2].padEnd(2, "0"));
    m = str.match(/^\d+$/);                               // plain minutes
    if (m) return +str;
    return null;
  }

  async function editTime(t) {
    const cur = Math.round(dispSec(t) / 60);             // current total, minutes
    const input = prompt(
      "Recorded time set koro:\n" +
      "  •  2h 30m   |   2:30   |   90m   |   1.30\n" +
      "  •  Relative:  +15m   ba   -10m",
      hm(cur * 60)
    );
    if (input === null) return;
    const s = input.trim();
    if (!s) return;
    let body;
    if (s[0] === "+" || s[0] === "-") {
      const mins = parseDur(s.slice(1));
      if (mins == null) return alert("Bujhte parlam na: " + s);
      body = { delta_minutes: (s[0] === "-" ? -mins : mins) };
    } else {
      const mins = parseDur(s);
      if (mins == null) return alert("Bujhte parlam na: " + s);
      body = { set_minutes: mins };
    }
    await api("/api/tasks/" + t.id + "/time", { method: "PUT", body: JSON.stringify(body) });
    load();
  }

  /* ---------- full edit modal (edit everything) ---------- */
  const STLABEL_FULL = { in_progress: "🔄 In Progress", pending: "⏳ Pending", hold: "⏸ Hold", completed: "✅ Completed" };
  const PRLABEL = { high: "High", med: "Medium", low: "Low" };
  let editingId = null;
  function openEdit(t) {
    editingId = t.id;
    $("e_title").value = t.title || "";
    $("e_description").value = t.description || "";
    $("e_priority").value = t.priority || "med";
    $("e_status").value = t.status || "in_progress";
    $("e_category").value = t.category || "task";
    $("e_est_minutes").value = t.est_minutes || "";
    $("e_note").value = t.note || "";
    $("editOverlay").classList.add("open");
    setTimeout(() => $("e_title").focus(), 30);
  }
  function closeEdit() { $("editOverlay").classList.remove("open"); editingId = null; }
  async function saveEdit() {
    if (editingId == null) return;
    const payload = {
      title: $("e_title").value.trim() || "Untitled",
      description: $("e_description").value,
      priority: $("e_priority").value,
      status: $("e_status").value,
      category: $("e_category").value,
      est_minutes: Number($("e_est_minutes").value) || 0,
      note: $("e_note").value,
    };
    await api("/api/tasks/" + editingId, { method: "PUT", body: JSON.stringify(payload) });
    closeEdit();
    load();
  }
  $("edSave").onclick = saveEdit;
  $("edClose").onclick = closeEdit;
  $("editOverlay").onclick = (e) => { if (e.target === $("editOverlay")) closeEdit(); };
  $("edDelete").onclick = async () => {
    if (editingId == null) return;
    if (!confirm("Delete this task?")) return;
    await api("/api/tasks/" + editingId, { method: "DELETE" });
    closeEdit();
    load();
  };
  $("e_title").addEventListener("keydown", (e) => { if (e.key === "Enter") saveEdit(); });

  /* ---------- task details view (with export + copy) ---------- */
  let detailText = "";   // plain-text form for copy / export
  async function openDetails(t) {
    $("detailBody").innerHTML = '<div class="muted" style="padding:8px">Loading…</div>';
    $("detailDate").textContent = "";
    $("detailOverlay").classList.add("open");
    let d;
    try { d = await api("/api/tasks/" + t.id + "/details"); }
    catch { $("detailBody").innerHTML = '<div class="muted" style="padding:8px">Could not load details.</div>'; return; }
    renderDetails(d);
    $("dEdit").onclick = () => { $("detailOverlay").classList.remove("open"); openEdit(d); };
  }
  function renderDetails(d) {
    $("detailDate").textContent = dmy(d.day);
    const rows = [
      ["Title", d.title],
      ["Status", STLABEL_FULL[d.status] || d.status],
      ["Priority", PRLABEL[d.priority] || d.priority],
      ["Category", d.category === "other" ? "Other (meeting/guide)" : "Task"],
      ["Date", dmy(d.day)],
      ["Time (this day)", hm(d.seconds)],
      ["Estimated", d.est_minutes ? hm(d.est_minutes * 60) : "—"],
    ];
    if ((d.total_minutes || 0) > d.minutes + 0.5) rows.push(["Total (all days)", hm(Math.round(d.total_minutes) * 60)]);
    if (d.description) rows.push(["Description", d.description]);
    if (d.note) rows.push(["Note / reason", d.note]);
    if (d.created_at) rows.push(["Created", new Date(d.created_at).toLocaleString()]);
    if (d.completed_at) rows.push(["Completed", new Date(d.completed_at).toLocaleString()]);

    // per-day breakdown (multi-day chains)
    const days = d.per_day ? Object.keys(d.per_day).sort() : [];
    const perDayHtml = (days.length > 1 || (days.length === 1 && days[0] !== d.day))
      ? `<div class="d-sec"><div class="d-h">Per-day breakdown</div>` +
        days.map((k) => `<div class="d-line"><span>${dmy(k)}</span><span>${hm(Math.round(d.per_day[k]) * 60)}</span></div>`).join("") + `</div>`
      : "";

    // session timeline
    const sess = d.sessions || [];
    const sessHtml = sess.length
      ? `<div class="d-sec"><div class="d-h">Timeline (${sess.length} session${sess.length > 1 ? "s" : ""})</div>` +
        sess.map((s, i) => {
          const st = hhmm(s.started_at), en = s.ended_at != null ? hhmm(s.ended_at) : "…";
          const dur = ((s.ended_at != null ? s.ended_at : Date.now()) - s.started_at) / 1000;
          return `<div class="d-line"><span>${i + 1}. ${st} → ${en}</span><span>${hm(dur)}</span></div>`;
        }).join("") + `</div>`
      : "";

    $("detailBody").innerHTML =
      `<div class="d-grid">` +
      rows.map(([k, v]) => `<div class="d-k">${esc(k)}</div><div class="d-v">${esc(String(v))}</div>`).join("") +
      `</div>${perDayHtml}${sessHtml}`;

    // plain-text version for copy / export
    const L = [];
    L.push("🔍 Task Details");
    rows.forEach(([k, v]) => L.push(`${k}: ${v}`));
    if (days.length && (days.length > 1 || days[0] !== d.day)) {
      L.push("");
      L.push("Per-day breakdown:");
      days.forEach((k) => L.push(`  ${dmy(k)}: ${hm(Math.round(d.per_day[k]) * 60)}`));
    }
    if (sess.length) {
      L.push("");
      L.push(`Timeline (${sess.length} session${sess.length > 1 ? "s" : ""}):`);
      sess.forEach((s, i) => {
        const st = hhmm(s.started_at), en = s.ended_at != null ? hhmm(s.ended_at) : "…";
        const dur = ((s.ended_at != null ? s.ended_at : Date.now()) - s.started_at) / 1000;
        L.push(`  ${i + 1}. ${st} → ${en}  (${hm(dur)})`);
      });
    }
    detailText = L.join("\n");
  }
  $("dClose").onclick = () => $("detailOverlay").classList.remove("open");
  $("detailOverlay").onclick = (e) => { if (e.target === $("detailOverlay")) $("detailOverlay").classList.remove("open"); };
  $("dCopy").onclick = async () => {
    try { await navigator.clipboard.writeText(detailText); $("dCopy").textContent = "✓ Copied"; }
    catch {}
    setTimeout(() => ($("dCopy").textContent = "📋 Copy"), 1400);
  };
  $("dExport").onclick = () => {
    const blob = new Blob([detailText], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob);
    a.download = "task-detail-" + date + ".txt"; a.click();
  };

  /* ---------- stats ---------- */
  // "Other (untracked)" seconds = net working − productive, i.e. workday span
  // (sign-in→now/out) minus breaks minus real task-timer time. 0 until signed in.
  function otherSec() {
    if (!signInAt) return 0;
    const spanSec = Math.max(0, ((signOutAt || Date.now()) - signInAt) / 1000);
    const netSec = Math.max(0, spanSec - breakMs() / 1000);
    const prodSec = tasks.filter((t) => t.category === "task").reduce((s, t) => s + dispSec(t), 0);
    return Math.max(0, netSec - prodSec);
  }
  function renderStats() {
    const prod = tasks.filter((t) => t.category === "task").reduce((s, t) => s + dispSec(t), 0);
    const done = tasks.filter((t) => t.status === "completed").length;
    const running = tasks.some((t) => t.running);
    $("stats").innerHTML =
      stat(tasks.length, "Tasks") +
      stat(done, "Completed") +
      stat(tasks.filter((t) => t.status === "in_progress").length, "In progress") +
      stat(tasks.filter((t) => t.status === "pending").length, "Pending") +
      `<div class="stat"><div class="n" id="prodStat">${hm(prod)}</div><div class="l">Productive</div></div>` +
      `<div class="stat"><div class="n" id="breakStat">${hm(breakMs() / 1000)}</div><div class="l">Break</div></div>` +
      (signInAt ? `<div class="stat"><div class="n" id="otherStat">${hm(otherSec())}</div><div class="l">Other (untracked)</div></div>` : "");
    // focus banner
    const r = tasks.find((t) => t.running);
    const fb = $("focus");
    if (r) { fb.classList.remove("idle"); $("focusTitle").textContent = r.title; }
    else { fb.classList.add("idle"); $("focusTitle").textContent = "Kono task chalu nei"; $("focusClock").textContent = "00:00:00"; }
  }
  const stat = (n, l) => `<div class="stat"><div class="n">${n}</div><div class="l">${l}</div></div>`;

  /* ---------- live tick ---------- */
  function tick() {
    const r = tasks.find((t) => t.running);
    if (r) $("focusClock").textContent = clock(dispSec(r));
    tasks.forEach((t) => {
      const el = document.querySelector(`[data-time="${t.id}"]`);
      if (el && t.running) el.textContent = clock(dispSec(t));
    });
    const ps = $("prodStat");
    if (ps) ps.textContent = hm(tasks.filter((t) => t.category === "task").reduce((s, t) => s + dispSec(t), 0));
    const os = $("otherStat");
    if (os) os.textContent = hm(otherSec());
    if (signInAt && !signOutAt) renderSign();   // live workday span
    if (breakRunningSince) {                     // live break clock
      const bstat = $("breakStat");
      if (bstat) bstat.textContent = hm(breakMs() / 1000);
      renderBreak();
    }
  }
  setInterval(tick, 1000);

  /* ---------- add ---------- */
  async function add() {
    const title = $("newTitle").value.trim();
    if (!title) return;
    await api("/api/tasks", {
      method: "POST",
      body: JSON.stringify({
        title, day: date,
        priority: $("newPrio").value,
        status: $("newStatus").value,
        category: $("newCat").value,
        est_minutes: Number($("newEst").value) || 0,
      }),
    });
    $("newTitle").value = ""; $("newEst").value = "";
    load();
  }
  $("addBtn").onclick = add;
  $("newTitle").addEventListener("keydown", (e) => { if (e.key === "Enter") add(); });

  /* ---------- drag & drop commit ---------- */
  groups.forEach((g) => {
    const body = $("col-" + g);
    const grp = body.closest(".group");
    body.addEventListener("dragover", (e) => {
      e.preventDefault();
      grp.classList.add("drop");
      const dragging = document.querySelector(".card.dragging");
      if (!dragging) return;
      const empty = body.querySelector(".empty"); if (empty) empty.remove();
      const after = getAfter(body, e.clientY);
      if (after == null) body.appendChild(dragging); else body.insertBefore(dragging, after);
    });
    body.addEventListener("dragleave", (e) => { if (!grp.contains(e.relatedTarget)) grp.classList.remove("drop"); });
    body.addEventListener("drop", (e) => { e.preventDefault(); grp.classList.remove("drop"); commitOrder(); });
  });
  function getAfter(container, y) {
    const els = [...container.querySelectorAll(".card:not(.dragging)")];
    let closest = { offset: -Infinity, el: null };
    els.forEach((c) => { const b = c.getBoundingClientRect(); const o = y - b.top - b.height / 2; if (o < 0 && o > closest.offset) closest = { offset: o, el: c }; });
    return closest.el;
  }
  let committing = false;
  async function commitOrder() {
    if (committing) return; committing = true;
    const items = [];
    groups.forEach((g) => {
      [...$("col-" + g).querySelectorAll(".card")].forEach((c, i) => items.push({ id: Number(c.dataset.id), status: g, position: i }));
    });
    await api("/api/reorder", { method: "POST", body: JSON.stringify({ items }) });
    committing = false;
    load();
  }

  /* ---------- meta + note autosave ---------- */
  let metaTimer;
  function saveMeta() {
    clearTimeout(metaTimer);
    metaTimer = setTimeout(async () => {
      await api("/api/meta?date=" + date, {
        method: "PUT",
        body: JSON.stringify({
          est_time_required: $("m_est_time_required").value,
          starting_time: $("m_starting_time").value,
          est_completion: $("m_est_completion").value,
          est_ending_date: $("m_est_ending_date").value,
          others_label: $("m_others_label").value,
          others_minutes: Number($("m_others_minutes").value) || 0,
        }),
      });
      flash("metaSaved");
    }, 400);
  }
  ["m_est_time_required", "m_starting_time", "m_est_completion", "m_est_ending_date", "m_others_label", "m_others_minutes"]
    .forEach((id) => $(id).addEventListener("input", saveMeta));

  let noteTimer;
  $("dailyNote").addEventListener("input", () => {
    clearTimeout(noteTimer);
    noteTimer = setTimeout(async () => {
      await api("/api/meta?date=" + date, { method: "PUT", body: JSON.stringify({ note: $("dailyNote").value }) });
      flash("noteSaved");
    }, 400);
  });
  function flash(id) { const e = $(id); e.textContent = "saved ✓"; setTimeout(() => (e.textContent = ""), 1200); }

  /* ---------- report ---------- */
  $("reportBtn").onclick = async () => {
    const { text } = await api("/api/report?date=" + date);
    $("reportText").textContent = text;
    $("reportDate").textContent = date;
    $("overlay").classList.add("open");
  };
  $("rClose").onclick = () => $("overlay").classList.remove("open");
  $("overlay").onclick = (e) => { if (e.target === $("overlay")) $("overlay").classList.remove("open"); };
  $("rCopy").onclick = async () => {
    try { await navigator.clipboard.writeText($("reportText").textContent); $("rCopy").textContent = "✓ Copied"; }
    catch { const r = document.createRange(); r.selectNode($("reportText")); getSelection().removeAllRanges(); getSelection().addRange(r); document.execCommand("copy"); $("rCopy").textContent = "✓ Copied"; }
    setTimeout(() => ($("rCopy").textContent = "📋 Copy"), 1400);
  };
  $("rDownload").onclick = () => {
    const blob = new Blob([$("reportText").textContent], { type: "text/plain" });
    const a = document.createElement("a"); a.href = URL.createObjectURL(blob); a.download = "work-report-" + date + ".txt"; a.click();
  };

  /* ---------- history (all days · grouped by date + status) ---------- */
  const dmy = (iso) => { const p = String(iso).split("-"); return p.length === 3 ? `${p[2]}-${p[1]}-${p[0]}` : iso; };
  const STLABEL = { in_progress: "🔄 In Progress", pending: "⏳ Pending", hold: "⏸ Hold", completed: "✅ Completed" };
  const HSTATUSES = ["in_progress", "pending", "hold", "completed"];
  let histFilter = "all";                   // "all" or a single status (dropdown)
  let histData = [];                        // last fetched history (filtered client-side)

  async function loadHistory() {
    const from = $("histFrom").value, to = $("histTo").value;
    const qs = [];
    if (from) qs.push("from=" + from);
    if (to) qs.push("to=" + to);
    const days = await api("/api/history" + (qs.length ? "?" + qs.join("&") : ""));
    renderHistory(days);
  }

  function histItem(t) {
    const reason = t.status === "pending" && t.note ? ` <span class="reason">⛔ ${esc(t.note)}</span>` : "";
    const mins = Math.round(t.minutes || 0);          // time tracked on THIS day
    const tot = Math.round(t.total_minutes || 0);     // grand total across all days
    const time = mins >= 1 ? `<span class="v">${hm(mins * 60)}</span>` : "";
    // sub-line: the whole-task total when it spans more than this day, plus —
    // for a legacy single row still holding several days' sessions — the split.
    const bits = [];
    if (tot > mins) bits.push(`total ${hm(tot * 60)}`);
    const days = t.per_day ? Object.keys(t.per_day).sort() : [];
    // full per-day split, shown once on the task's newest entry, whenever its time
    // lands on days other than this row's day (multi-day task, or a legacy row
    // holding an earlier day's sessions).
    const spread = t.is_chain_latest && days.length && (days.length > 1 || days[0] !== t.day);
    if (spread) bits.push(days.map((d) => `${dmy(d)} ${hm(Math.round(t.per_day[d]) * 60)}`).join(" · "));
    const sub = bits.length ? `<div class="hs-sub">${bits.join("  ·  ")}</div>` : "";
    return `<div class="hs-item"><div class="hs-line"><span class="t">${esc(t.title)}${reason}</span>${time}</div>${sub}</div>`;
  }

  function renderHistory(days) { histData = days; paintHistory(); }

  // paint from histData applying the active status filter (no refetch needed)
  function paintHistory() {
    const body = $("histBody"), sum = $("histSummary");
    if (!histData.length) { body.innerHTML = '<div class="hist-empty">Ei range-e kono task nei.</div>'; sum.textContent = ""; return; }
    const shown = histFilter === "all" ? HSTATUSES.slice() : [histFilter];
    const showDone = histFilter === "all" || histFilter === "completed";
    const days = histData.filter((g) => shown.some((s) => (g[s] || []).length));
    if (!days.length) { body.innerHTML = '<div class="hist-empty">Ei status filter-e kono task nei.</div>'; sum.textContent = ""; return; }
    let totTasks = 0, totDone = 0;
    body.innerHTML = days.map((g) => {
      const n = shown.reduce((s, st) => s + (g[st] || []).length, 0);
      totTasks += n;
      if (showDone) totDone += g.counts.completed;
      const col = (st) => {
        const items = g[st] || [];
        return `<div class="hs-col"><div class="hs-head">${STLABEL[st]} (${items.length})</div>` +
          (items.length ? items.map(histItem).join("") : '<div class="hs-empty">—</div>') + "</div>";
      };
      const net = g.net_working_minutes != null ? ` · net ${hm((g.net_working_minutes || 0) * 60)}` : "";
      const total = g.task_total_minutes != null ? ` · total ${hm((g.task_total_minutes || 0) * 60)}` : "";
      return `<div class="hist-day">
        <div class="hist-date" data-day="${g.day}">📅 ${dmy(g.day)}
          <span class="jump">${n} task${total} · productive ${hm((g.productive_minutes || 0) * 60)}${net} · click to open</span></div>
        <div class="hist-cols c${shown.length}">${shown.map(col).join("")}</div>
      </div>`;
    }).join("");
    sum.textContent = `${days.length} days · ${totTasks} tasks` + (showDone ? ` · ${totDone} completed` : "");
    body.querySelectorAll(".hist-date").forEach((el) => {
      el.onclick = () => { date = el.dataset.day; $("datePick").value = date; $("histOverlay").classList.remove("open"); load(); };
    });
  }

  $("historyBtn").onclick = () => { $("histOverlay").classList.add("open"); loadHistory(); };
  $("histStatusSel").onchange = () => { histFilter = $("histStatusSel").value; paintHistory(); };   // client-side, no refetch
  $("histApply").onclick = loadHistory;
  $("histClear").onclick = () => { $("histFrom").value = ""; $("histTo").value = ""; loadHistory(); };
  $("hClose").onclick = () => $("histOverlay").classList.remove("open");
  $("histOverlay").onclick = (e) => { if (e.target === $("histOverlay")) $("histOverlay").classList.remove("open"); };

  /* ---------- sticky notes board (edge tab → full-screen pinboard) ---------- */
  (function stickyNotes() {
    const board = $("stickyBoard"), canvas = $("sbCanvas"), tab = $("stickyTab");
    const COLORS = ["yellow", "pink", "green", "blue", "purple", "orange"];
    let notes = [];
    let zTop = 1;          // highest stacking order — clicking a note raises it above the rest
    let loaded = false;
    const saveTimers = {};

    // restore a previously dragged panel width (persisted locally)
    try { const w = localStorage.getItem("wl_notes_w"); if (w) document.documentElement.style.setProperty("--notes-w", w + "px"); } catch {}

    // debounced save (typing) — coalesces rapid edits into one PUT
    function queueSave(id, patch) {
      clearTimeout(saveTimers[id]);
      saveTimers[id] = setTimeout(() => { api("/api/notes/" + id, { method: "PUT", body: JSON.stringify(patch) }).catch(() => {}); }, 350);
    }
    // immediate save (drag/resize end, colour, z) — cancels any pending debounce
    function saveNow(id, patch) {
      clearTimeout(saveTimers[id]);
      api("/api/notes/" + id, { method: "PUT", body: JSON.stringify(patch) }).catch(() => {});
    }
    function updateCount() { $("sbCount").textContent = notes.length ? notes.length + " note" + (notes.length > 1 ? "s" : "") : ""; }

    /* board window controls: chevron open/close · collapse · full-screen */
    function setChevron() { tab.textContent = board.classList.contains("open") ? "❮" : "❯"; }
    async function openBoard() {
      board.classList.add("open");
      board.classList.remove("collapsed");
      document.body.classList.add("notes-open");
      setChevron();
      if (!loaded) { await reload(); loaded = true; }
    }
    function closeBoard() {
      board.classList.remove("open", "full");
      document.body.classList.remove("notes-open", "notes-full");
      $("sbFull").textContent = "⤢";
      setChevron();
    }
    tab.onclick = () => (board.classList.contains("open") ? closeBoard() : openBoard());
    $("sbClose").onclick = closeBoard;
    $("sbCollapse").onclick = () => board.classList.toggle("collapsed");
    // full-screen = the panel grows from a right sidebar to cover the whole viewport
    $("sbFull").onclick = () => {
      board.classList.remove("collapsed");
      const full = board.classList.toggle("full");
      document.body.classList.toggle("notes-full", full);
      $("sbFull").textContent = full ? "⤡" : "⤢";
    };
    // clicking a collapsed board's bar re-expands it
    $("sbBar").addEventListener("click", (e) => { if (board.classList.contains("collapsed") && !e.target.closest(".sb-tools")) board.classList.remove("collapsed"); });
    setChevron();

    // resize the whole panel by dragging its left edge (disabled in full-screen)
    $("sbGrip").addEventListener("mousedown", (e) => {
      if (board.classList.contains("full")) return;
      e.preventDefault();
      const startX = e.clientX, startW = board.getBoundingClientRect().width;
      document.body.classList.add("sb-resizing");
      const move = (ev) => {
        const w = Math.max(280, Math.min(window.innerWidth, startW + (startX - ev.clientX)));
        document.documentElement.style.setProperty("--notes-w", w + "px");
      };
      const up = () => {
        document.body.classList.remove("sb-resizing");
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        try { localStorage.setItem("wl_notes_w", Math.round(board.getBoundingClientRect().width)); } catch {}
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    });

    async function reload() {
      try { notes = await api("/api/notes"); } catch { notes = []; }
      zTop = notes.reduce((m, n) => Math.max(m, n.z || 1), 1);
      canvas.innerHTML = "";
      notes.forEach((n) => canvas.appendChild(noteEl(n)));
      updateCount();
    }

    $("sbAdd").onclick = async () => {
      // drop the new note near the current view with a slight cascade so it doesn't
      // land exactly on the previous one
      const off = (notes.length % 10) * 26;
      const x = 30 + off + (canvas.scrollLeft || 0);
      const y = 30 + off + (canvas.scrollTop || 0);
      let n;
      try { n = await api("/api/notes", { method: "POST", body: JSON.stringify({ x, y, color: "yellow" }) }); }
      catch { return; }
      notes.push(n); updateCount();
      const el = noteEl(n); canvas.appendChild(el); bringFront(n, el);
      setTimeout(() => el.querySelector(".s-title").focus(), 30);
    };

    // Tidy: pack every note into aligned rows filling the panel width (one-click grid).
    async function tidy() {
      const pad = 16, gap = 16, W = Math.max(200, canvas.clientWidth - pad);
      let x = pad, y = pad, rowH = 0;
      for (const n of notes) {
        const w = n.w || 250, h = n.h || 220;
        if (x > pad && x + w > W) { x = pad; y += rowH + gap; rowH = 0; }   // wrap to next row
        n.x = x; n.y = y;
        const el = canvas.querySelector(`.sticky[data-id="${n.id}"]`);
        if (el) { el.style.left = x + "px"; el.style.top = y + "px"; }
        x += w + gap; rowH = Math.max(rowH, h);
      }
      notes.forEach((n) => saveNow(n.id, { x: n.x, y: n.y }));
    }
    $("sbTidy").onclick = tidy;

    // Notes flow in a wrap-grid (parallel, filling the width). Each note carries its
    // own width/height and is resized with the browser's native corner grip; a
    // ResizeObserver persists the new size (border-box, so it matches what we set).
    const ro = new ResizeObserver((entries) => {
      for (const en of entries) {
        const el = en.target, id = Number(el.dataset.id);
        const n = notes.find((x) => x.id === id);
        if (!n) continue;
        const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
        if (w === n.w && h === n.h) continue;   // no change (or first observe) → skip
        n.w = w; n.h = h; queueSave(id, { w, h });
      }
    });

    function noteEl(n) {
      const el = document.createElement("div");
      el.className = "sticky c-" + (n.color || "yellow");
      el.dataset.id = n.id;
      el.style.left = (n.x || 0) + "px";
      el.style.top = (n.y || 0) + "px";
      el.style.width = (n.w || 250) + "px";
      el.style.height = (n.h || 220) + "px";
      el.style.zIndex = n.z || 1;
      el.style.setProperty("--rot", ((((n.id || 0) * 37) % 5) - 2) * 0.7 + "deg");   // subtle paper tilt
      el.innerHTML =
        `<div class="s-head">
           <div class="s-colors">${COLORS.map((c) => `<button class="sw c-${c}" data-color="${c}" title="${c}"></button>`).join("")}</div>
           <div class="s-actions">
             <button class="s-mark" title="Highlight selected text">🖊</button>
             <button class="s-del" title="Delete note">✕</button>
           </div>
         </div>
         <div class="s-title" contenteditable="true" data-ph="Title…">${esc(n.title || "")}</div>
         <div class="s-body" contenteditable="true" data-ph="Write a note…">${n.body || ""}</div>`;
      wireNote(el, n);
      ro.observe(el);
      return el;
    }

    function wireNote(el, n) {
      const titleEl = el.querySelector(".s-title");
      const bodyEl = el.querySelector(".s-body");
      const head = el.querySelector(".s-head");

      el.addEventListener("mousedown", () => bringFront(n, el));   // click raises the note to the top
      head.addEventListener("mousedown", (e) => { if (!e.target.closest("button")) startDrag(e, el, n); });

      titleEl.addEventListener("input", () => { n.title = titleEl.textContent; queueSave(n.id, { title: n.title }); });
      bodyEl.addEventListener("input", () => { n.body = bodyEl.innerHTML; queueSave(n.id, { body: n.body }); });

      el.querySelectorAll(".s-colors .sw").forEach((b) => {
        b.addEventListener("click", (e) => {
          e.stopPropagation();
          const c = b.dataset.color; n.color = c;
          COLORS.forEach((cc) => el.classList.remove("c-" + cc));
          el.classList.add("c-" + c);
          saveNow(n.id, { color: c });
        });
      });

      el.querySelector(".s-mark").addEventListener("click", (e) => {
        e.stopPropagation();
        highlightSelection(bodyEl);
        n.body = bodyEl.innerHTML;
        saveNow(n.id, { body: n.body });
      });

      el.querySelector(".s-del").addEventListener("click", async (e) => {
        e.stopPropagation();
        if (!confirm("Delete this sticky note?")) return;
        try { await api("/api/notes/" + n.id, { method: "DELETE" }); } catch {}
        notes = notes.filter((x) => x.id !== n.id);
        ro.unobserve(el); el.remove(); updateCount();
      });
    }

    // raise a note above all others (stacking) and remember the new order
    function bringFront(n, el) {
      if (n.z === zTop) return;
      zTop += 1; n.z = zTop; el.style.zIndex = zTop; queueSave(n.id, { z: zTop });
    }

    // relocate a note anywhere on the board by dragging its header (overlap allowed)
    function startDrag(e, el, n) {
      e.preventDefault();
      bringFront(n, el);
      const startX = e.clientX, startY = e.clientY;
      const origX = parseFloat(el.style.left) || 0, origY = parseFloat(el.style.top) || 0;
      el.classList.add("dragging");
      const move = (ev) => {
        const nx = Math.max(0, origX + (ev.clientX - startX));
        const ny = Math.max(0, origY + (ev.clientY - startY));
        el.style.left = nx + "px"; el.style.top = ny + "px"; n.x = nx; n.y = ny;
      };
      const up = () => {
        el.classList.remove("dragging");
        document.removeEventListener("mousemove", move); document.removeEventListener("mouseup", up);
        saveNow(n.id, { x: n.x, y: n.y });
      };
      document.addEventListener("mousemove", move); document.addEventListener("mouseup", up);
    }

    // wrap the current selection (inside the note body) in <mark> — the highlighter
    function highlightSelection(bodyEl) {
      const sel = window.getSelection();
      if (!sel || !sel.rangeCount || sel.isCollapsed) return;
      const range = sel.getRangeAt(0);
      if (!bodyEl.contains(range.commonAncestorContainer)) return;
      const mark = document.createElement("mark");
      try { range.surroundContents(mark); }
      catch { const frag = range.extractContents(); mark.appendChild(frag); range.insertNode(mark); }
      sel.removeAllRanges();
    }
  })();

  load();
})();
