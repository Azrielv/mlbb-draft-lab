// Draft board: sequence handling, rendering and wiring to the recommendation engine.
import { kb, ROLE_NAMES } from "./kb.js";
import { LANES, LANE_NAMES, heroWR, presence, pct, matchup, synergy } from "./stats.js";

// B = ban, P = pick; digit = side (0 blue, 1 red)
const SEQUENCES = {
  mpl: "B0 B1 B0 B1 B0 B1 P0 P1 P1 P0 P0 P1 B1 B0 B1 B0 P1 P0 P0 P1",
  mythic: "B0 B1 B0 B1 B0 B1 B0 B1 B0 B1 P0 P1 P1 P0 P0 P1 P1 P0 P0 P1",
  legend: "B0 B1 B0 B1 B0 B1 P0 P1 P1 P0 P0 P1 P1 P0 P0 P1",
};
const SIDE = ["Blue", "Red"];
const TURN_SECONDS = { B: 30, P: 30 };

export class Draft {
  constructor(app) {
    this.app = app;
    this.mode = "mpl";
    this.actions = [];
    this.teams = ["", ""];
    this.lane = "all";
    this.search = "";
    this.sort = "name";
    this.hover = null;
    this.ai = { on: false, side: 1 };
    this.$ = (id) => document.getElementById(id);
    this.bindControls();
    this.buildSteps();
  }

  buildSteps() {
    this.steps = SEQUENCES[this.mode].split(" ").map((s) => ({ type: s[0], side: +s[1] }));
    // label phases: consecutive runs of the same action type
    let phase = { B: 0, P: 0 }, prev = null;
    for (const s of this.steps) {
      if (s.type !== prev) phase[s.type]++;
      s.phase = `${s.type === "B" ? "BAN" : "PICK"} PHASE ${phase[s.type]}`;
      prev = s.type;
    }
  }

  get cur() { return this.steps[this.actions.length] || null; }
  state() {
    const st = { bans: [[], []], picks: [[], []] };
    this.actions.forEach((h, i) => {
      const s = this.steps[i];
      (s.type === "B" ? st.bans : st.picks)[s.side].push(h);
    });
    return st;
  }
  unavailable() { return new Set(this.actions.filter(Boolean)); }

  bindControls() {
    const $ = this.$;
    $("modeSel").onchange = (e) => { this.mode = e.target.value; this.reset(); };
    $("undoBtn").onclick = () => this.undo();
    $("resetBtn").onclick = () => this.reset();
    $("swapBtn").onclick = () => {
      this.teams.reverse();
      $("teamSel0").value = this.teams[0];
      $("teamSel1").value = this.teams[1];
      this.render();
    };
    $("aiToggle").onchange = (e) => { this.ai.on = e.target.checked; this.render(); };
    $("aiSideSel").onchange = (e) => { this.ai.side = +e.target.value; this.render(); };
    [0, 1].forEach((i) => ($(`teamSel${i}`).onchange = (e) => { this.teams[i] = e.target.value; this.render(); }));
    $("search").oninput = (e) => { this.search = e.target.value.toLowerCase(); this.renderGrid(); };
    $("sortSel").onchange = (e) => { this.sort = e.target.value; this.renderGrid(); };
    const lf = $("laneFilter");
    lf.innerHTML = ["all", ...LANES].map((l) => `<button data-l="${l}" class="${l === "all" ? "on" : ""}">${l === "all" ? "All" : LANE_NAMES[l]}</button>`).join("");
    lf.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this.lane = b.dataset.l;
      lf.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      this.renderGrid();
    };
    document.addEventListener("keydown", (e) => {
      if (!document.getElementById("page-draft").classList.contains("active")) return;
      if (e.key === "z" && (e.ctrlKey || e.metaKey)) { e.preventDefault(); this.undo(); }
      if (e.key === "Enter" && document.activeElement === $("search")) {
        const first = this.$("heroGrid").querySelector(".hero:not(.taken)");
        if (first) this.choose(first.dataset.id);
      }
    });
  }

  setTeams(names) {
    for (const i of [0, 1]) {
      const sel = this.$(`teamSel${i}`);
      const v = sel.value;
      sel.innerHTML = `<option value="">${SIDE[i]} side — any team</option>` + names.map((n) => `<option>${esc(n)}</option>`).join("");
      sel.value = names.includes(v) ? v : "";
      this.teams[i] = sel.value;
    }
  }

  reset() { this.actions = []; this.buildSteps(); this.render(); }
  undo() {
    if (!this.actions.length) return;
    this.actions.pop();
    // when undoing against the AI, also roll back the AI's own move
    while (this.ai.on && this.cur && this.cur.side === this.ai.side && this.actions.length) this.actions.pop();
    this.render();
  }
  choose(id) {
    if (!this.cur || this.unavailable().has(id)) return;
    this.actions.push(id);
    this.hover = null;
    this.$("search").value = ""; this.search = "";
    this.render();
  }
  skipBan() { if (this.cur?.type === "B") { this.actions.push(null); this.render(); } }

  // ---------- engine ----------
  ctxFor(side) {
    const st = this.state();
    return {
      ours: st.picks[side], theirs: st.picks[1 - side], unavailable: this.unavailable(),
      ourTeam: this.teams[side], theirTeam: this.teams[1 - side],
    };
  }
  suggestions() {
    const c = this.cur, E = this.app.engine;
    if (!c || !E) return [];
    const ctx = this.ctxFor(c.side);
    return c.type === "P" ? E.suggestPicks(ctx) : E.suggestBans(ctx);
  }

  // ---------- render ----------
  // share/restore the board through the URL: #mode=mpl&a=freya,atlas,-,…&t0=ONIC&t1=RRQ%20Hoshi
  saveHash() {
    const p = new URLSearchParams({ mode: this.mode, a: this.actions.map((x) => x || "-").join(",") });
    this.teams.forEach((t, i) => t && p.set("t" + i, t));
    history.replaceState(null, "", "#" + p.toString());
  }
  loadHash() {
    const p = new URLSearchParams(location.hash.slice(1));
    if (!p.has("a")) return;
    if (SEQUENCES[p.get("mode")]) { this.mode = p.get("mode"); this.$("modeSel").value = this.mode; this.buildSteps(); }
    const ok = new Set(this.app.heroes.map((h) => h.id));
    this.actions = p.get("a").split(",").filter(Boolean).slice(0, this.steps.length).map((x) => (ok.has(x) ? x : null));
    [0, 1].forEach((i) => {
      const t = p.get("t" + i);
      if (t && this.app.teamList.includes(t)) { this.teams[i] = t; this.$(`teamSel${i}`).value = t; }
    });
  }

  render() {
    if (!this.app.engine) return;
    this.saveHash();
    this.sugs = this.suggestions();
    this.sugRank = new Map(this.sugs.map((s, i) => [s.id, i]));
    this.renderHead();
    this.renderSlots();
    this.renderGrid();
    this.renderSuggestions();
    this.renderOutlook();
    this.renderComp(0); this.renderComp(1);
    this.runTimer();
    this.maybeAI();
  }

  renderHead() {
    const c = this.cur, $ = this.$;
    $("phaseLbl").textContent = c ? c.phase : "DRAFT COMPLETE";
    const t = $("turnLbl");
    t.className = "turn " + (c ? (c.side ? "red" : "blue") : "");
    t.innerHTML = c ? `${SIDE[c.side]} ${c.type === "B" ? "bans" : "picks"}${this.teams[c.side] ? ` · <span class="muted">${esc(this.teams[c.side])}</span>` : ""}`
      : "Good luck, have fun";
    const st = this.state();
    const w = this.app.engine.winEstimate(st.picks[0], st.picks[1]);
    $("winFill").style.width = pct(w.p, 1);
    $("winTxt").textContent = `${Math.round(w.p * 100)} : ${100 - Math.round(w.p * 100)}`;
  }

  renderSlots() {
    const st = this.state(), app = this.app;
    for (const side of [0, 1]) {
      let banHtml = "";
      this.steps.forEach((s, i) => {
        if (s.type !== "B" || s.side !== side) return;
        const h = this.actions[i];
        const active = i === this.actions.length;
        banHtml += `<div class="ban-slot ${h ? "filled" : ""} ${active ? "active" : ""}" ${h ? `data-tip="${h}"` : ""}>${h ? `<img src="${app.icon(h)}" alt="">` : ""}</div>`;
      });
      this.$(`bans${side}`).innerHTML = banHtml || `<span class="muted">no bans</span>`;

      const lanes = app.engine.assign(st.picks[side]).lanes;
      let html = "", pi = 0, slot = 0;
      this.steps.forEach((s, i) => {
        if (s.type !== "P" || s.side !== side) return;
        const h = this.actions[i];
        const active = i === this.actions.length;
        const prev = active && this.hover && !h ? this.hover : null;
        const show = h || prev;
        html += `<div class="pick-slot ${active ? "active" : ""} ${prev ? "preview" : ""}" ${h ? `data-tip="${h}"` : ""}>
          <span class="pnum">${side ? "R" : "B"}${++slot}</span>
          ${show ? `<img class="portrait" src="${app.icon(show)}" alt="">` : ""}
          <div class="info">${h ? `<div class="pname">${esc(app.name(h))}</div><div class="plane">${LANE_NAMES[LANES[lanes[pi]]] || ""}</div>` : ""}</div>
        </div>`;
        if (h) pi++;
      });
      this.$(`picks${side}`).innerHTML = html;
    }
  }

  renderGrid() {
    const app = this.app, taken = this.unavailable();
    let list = app.heroes.filter((h) =>
      (!this.search || h.name.toLowerCase().includes(this.search)) &&
      (this.lane === "all" || (app.engine.lp[h.id][LANES.indexOf(this.lane)] > 0.15)));
    const S = app.stats;
    if (this.sort === "presence") list.sort((a, b) => presence(S, b.id) - presence(S, a.id));
    else if (this.sort === "wr") list.sort((a, b) => heroWR(S, b.id) - heroWR(S, a.id));
    else if (this.sort === "suggest") list.sort((a, b) => (this.sugRank.get(a.id) ?? 999) - (this.sugRank.get(b.id) ?? 999));
    const grid = this.$("heroGrid");
    grid.innerHTML = list.map((h) => {
      const r = this.sugRank?.get(h.id);
      return `<div class="hero ${taken.has(h.id) ? "taken" : ""} ${r !== undefined && r < 5 ? "top" : ""}" data-id="${h.id}" data-tip="${h.id}">
        <img src="${h.icon}" alt="" loading="lazy">${r !== undefined && r < 5 ? `<span class="badge">#${r + 1}</span>` : ""}
        <div class="hn">${esc(h.name)}</div></div>`;
    }).join("");
    grid.onclick = (e) => { const el = e.target.closest(".hero"); if (el) this.choose(el.dataset.id); };
    grid.onmouseover = (e) => {
      const el = e.target.closest(".hero");
      const id = el && !el.classList.contains("taken") ? el.dataset.id : null;
      if (id !== this.hover && this.cur?.type === "P") { this.hover = id; this.renderSlots(); }
    };
    grid.onmouseleave = () => { if (this.hover) { this.hover = null; this.renderSlots(); } };
  }

  renderSuggestions() {
    const c = this.cur, app = this.app;
    const strip = this.$("suggestStrip");
    if (!c) {
      strip.innerHTML = "";
      this.$("sugTitle").textContent = "Draft complete";
      this.$("sugSub").textContent = "";
      this.$("sugList").innerHTML = this.finalSummary();
      return;
    }
    const top = this.sugs.slice(0, 12);
    const max = Math.max(1, ...top.map((s) => s.score));
    const label = c.type === "P" ? "PICK" : "BAN";
    strip.innerHTML = `<span class="sg-label">${label}</span>` + top.slice(0, 8).map((s) =>
      `<div class="sg" data-id="${s.id}" data-tip="${s.id}"><img src="${app.icon(s.id)}" alt=""><span class="sgs">${Math.round((s.score / max) * 100)}</span><span class="sgn">${esc(app.name(s.id))}</span></div>`).join("");
    strip.onclick = (e) => { const el = e.target.closest(".sg"); if (el) this.choose(el.dataset.id); };

    this.$("sugTitle").innerHTML = `${c.type === "P" ? "Best picks" : "Best bans"} for <span class="${c.side ? "red-t" : "blue-t"}">${SIDE[c.side]}</span>`;
    this.$("sugSub").innerHTML = c.type === "B" ? `<button class="btn" id="skipBan">Skip ban</button>` : "click to lock in";
    const sb = document.getElementById("skipBan"); if (sb) sb.onclick = () => this.skipBan();
    this.$("sugList").innerHTML = top.map((s) => `
      <div class="sug" data-id="${s.id}">
        <img src="${app.icon(s.id)}" alt="">
        <div><span class="nm">${esc(app.name(s.id))}</span>${s.lane ? `<span class="ln">${LANE_NAMES[s.lane]}</span>` : ""}
          <ul>${(s.reasons.length ? s.reasons : [{ t: "", txt: "Solid general option" }]).slice(0, 4).map((r) => `<li class="${r.t}">${esc(r.txt)}</li>`).join("")}</ul></div>
        <div class="sc">${Math.round((s.score / max) * 100)}</div>
      </div>`).join("");
    this.$("sugList").onclick = (e) => { const el = e.target.closest(".sug"); if (el) this.choose(el.dataset.id); };
  }

  renderOutlook() {
    const c = this.cur, app = this.app, E = app.engine;
    const box = this.$("predList");
    if (!c) { box.innerHTML = `<div class="empty">Draft complete.</div>`; this.$("predSub").textContent = ""; return; }
    // look at the side that is NOT acting now (or the AI side) — what will they do next?
    const enemy = this.ai.on ? this.ai.side : 1 - c.side;
    const nextEnemy = this.steps.slice(this.actions.length).find((s) => s.side === enemy);
    if (!nextEnemy) { box.innerHTML = `<div class="empty">${SIDE[enemy]} has no actions left.</div>`; return; }
    const ctx = this.ctxFor(enemy);
    const list = (nextEnemy.type === "P" ? E.suggestPicks(ctx) : E.suggestBans(ctx)).slice(0, 6);
    const ex = list.map((s) => Math.exp(s.score / 8)), tot = ex.reduce((a, b) => a + b, 0);
    this.$("predSub").innerHTML = `${SIDE[enemy]}'s next ${nextEnemy.type === "P" ? "pick" : "ban"}${this.teams[enemy] ? " · " + esc(this.teams[enemy]) : ""}`;
    box.innerHTML = list.map((s, i) => `
      <div class="pred" data-tip="${s.id}"><img src="${app.icon(s.id)}" alt="">
        <div><div>${esc(app.name(s.id))}</div><div class="why">${esc(s.reasons[0]?.txt || "")}</div></div>
        <span class="pp">${Math.round((ex[i] / tot) * 100)}%</span></div>`).join("") +
      `<div class="muted" style="margin-top:6px">Consider banning or picking these away first.</div>`;
  }

  renderComp(side) {
    const app = this.app, E = app.engine, st = this.state();
    const picks = st.picks[side], enemy = st.picks[1 - side];
    const box = this.$(`comp${side}`);
    if (!picks.length) { box.innerHTML = `<div class="empty">No picks yet.</div>`; return; }
    const c = E.composition(picks);
    const notes = [];
    const missing = LANES.filter((l) => !c.lanes.includes(l)).map((l) => LANE_NAMES[l]);
    if (picks.length >= 3 && c.front === 0) notes.push(["bad", "No real frontline — consider a tank/fighter"]);
    if (picks.length >= 3 && (c.phys === 0 || c.mag === 0)) notes.push(["bad", `All ${c.phys ? "physical" : "magic"} damage — easy to itemise against`]);
    if (picks.length >= 4 && c.cc < 5) notes.push(["bad", "Low crowd control"]);
    if (c.curve.L >= 3) notes.push(["", "Late-game draft: play safe early, scale"]);
    if (c.curve.E >= 3) notes.push(["", "Early-game draft: snowball & take objectives early"]);
    for (let i = 0; i < picks.length; i++) for (let j = i + 1; j < picks.length; j++) {
      const s = synergy(app.stats, picks[i], picks[j]);
      if (s.n >= 4 && s.d > 0.03) notes.push(["good", `${app.name(picks[i])} + ${app.name(picks[j])}: ${pct(s.wr)} WR together (${s.n})`]);
    }
    for (const a of picks) for (const b of enemy) {
      const m = matchup(app.stats, a, b);
      if (m.n >= 4 && m.d < -0.04) notes.push(["bad", `${app.name(a)} vs ${app.name(b)}: ${pct(m.wr)} WR (${m.n})`]);
      if (m.n >= 4 && m.d > 0.04) notes.push(["good", `${app.name(a)} beats ${app.name(b)}: ${pct(m.wr)} WR (${m.n})`]);
    }
    const tot = c.phys + c.mag;
    box.innerHTML = `
      <div class="comp-row"><span>Damage</span><b>${c.phys} physical · ${c.mag} magic</b></div>
      <div class="dmgbar"><div class="p" style="width:${(c.phys / tot) * 100}%"></div><div class="m" style="width:${(c.mag / tot) * 100}%"></div></div>
      ${meter("Crowd control", c.cc, 12)}${meter("Frontline", c.front, 2)}${meter("Burst", c.burst, 12)}${meter("Mobility", c.mob, 12)}
      <div class="comp-row"><span>Power curve</span><b>${c.curve.E} early · ${c.curve.M} mid · ${c.curve.L} late</b></div>
      ${missing.length && picks.length < 5 ? `<div class="comp-row"><span>Open lanes</span><b>${missing.join(", ")}</b></div>` : ""}
      <ul class="notes">${notes.slice(0, 7).map(([k, t]) => `<li class="${k}">${esc(t)}</li>`).join("")}</ul>`;
  }

  finalSummary() {
    const st = this.state(), E = this.app.engine;
    const w = E.winEstimate(st.picks[0], st.picks[1]);
    const f = (x) => (x >= 0 ? "+" : "") + (x * 100).toFixed(1);
    return `<div style="grid-column:1/-1">
      <p>Estimated draft edge: <b class="${w.p >= 0.5 ? "good" : "bad"}">Blue ${pct(w.p)}</b> vs Red ${pct(1 - w.p)}</p>
      <div class="comp-row"><span>Hero strength (pro WR)</span><b>${f(w.parts.strength)}</b></div>
      <div class="comp-row"><span>Synergy</span><b>${f(w.parts.synergy)}</b></div>
      <div class="comp-row"><span>Matchups</span><b>${f(w.parts.matchups)}</b></div>
      <p class="muted">Positive favours Blue. Built from pro win rates only — execution, patch and player form matter more.</p></div>`;
  }

  runTimer() {
    clearInterval(this.timerId);
    const el = this.$("timer"), c = this.cur;
    if (!c) { el.textContent = "—"; el.classList.remove("low"); return; }
    let t = TURN_SECONDS[c.type];
    el.textContent = t; el.classList.remove("low");
    this.timerId = setInterval(() => {
      t = Math.max(0, t - 1);
      el.textContent = t;
      el.classList.toggle("low", t <= 10);
      if (!t) clearInterval(this.timerId);
    }, 1000);
  }

  maybeAI() {
    clearTimeout(this.aiId);
    const c = this.cur;
    if (!this.ai.on || !c || c.side !== this.ai.side) return;
    this.aiId = setTimeout(() => {
      // weighted random among the top 3 so the AI isn't fully predictable
      const top = this.sugs.slice(0, 3);
      const w = top.map((s, i) => [3, 2, 1][i]);
      let r = Math.random() * w.reduce((a, b) => a + b, 0);
      const pick = top.find((_, i) => (r -= w[i]) < 0) || top[0];
      if (pick) this.choose(pick.id);
    }, 900);
  }

  loadGame(g) {
    // Liquipedia doesn't record pick order, so fill the board in sequence order with the final draft.
    this.mode = "mpl"; this.$("modeSel").value = "mpl"; this.buildSteps();
    const blue = g.sides[0] === "red" ? 1 : 0;
    const teamOf = [blue, 1 - blue];
    this.teams = [g.teams[teamOf[0]], g.teams[teamOf[1]]];
    [0, 1].forEach((i) => (this.$(`teamSel${i}`).value = this.teams[i]));
    const q = { B: [g.bans[teamOf[0]].slice(), g.bans[teamOf[1]].slice()], P: [g.picks[teamOf[0]].slice(), g.picks[teamOf[1]].slice()] };
    this.actions = this.steps.map((s) => q[s.type][s.side].shift() || null);
    this.ai.on = false; this.$("aiToggle").checked = false;
    this.render();
  }
}

function meter(label, v, max) {
  return `<div class="comp-row" style="display:block"><div style="display:flex;justify-content:space-between"><span>${label}</span><b>${v}</b></div>
    <div class="meter"><i style="width:${Math.min(100, (v / max) * 100)}%"></i></div></div>`;
}

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

export function heroTooltip(app, id) {
  const h = app.byId[id]; if (!h) return "";
  const S = app.stats, s = S.hero[id], k = kb(id);
  const lp = app.engine.lp[id].map((p, i) => [LANES[i], p]).filter(([, p]) => p > 0.1).map(([l, p]) => `${LANE_NAMES[l]} ${pct(p)}`).join(" · ");
  return `<h4>${esc(h.name)}</h4>
    <div class="muted">${k.roles.map((r) => ROLE_NAMES[r]).join(" / ")} · ${k.dmg === "M" ? "Magic" : "Physical"}</div>
    <div class="muted">${lp}</div>
    <div class="tt-row"><span>Pro games</span><b>${s?.n || 0}</b></div>
    <div class="tt-row"><span>Win rate</span><b>${s?.n ? pct(s.nw / s.n, 1) : "—"}</b></div>
    <div class="tt-row"><span>Bans</span><b>${s?.nb || 0}</b></div>
    <div class="tt-row"><span>Presence</span><b>${pct(presence(S, id))}</b></div>`;
}
