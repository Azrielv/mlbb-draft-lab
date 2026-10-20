import { buildStats, filterGames, heroWR, presence, pickRate, banRate, synergy, matchup, teamPickRate, LANES, LANE_NAMES, pct } from "./stats.js";
import { Engine } from "./engine.js";
import { Draft, esc, heroTooltip } from "./draft.js";
import { kb, ROLE_NAMES, COMBOS, COUNTERS } from "./kb.js";

const $ = (id) => document.getElementById(id);
const store = {
  get(k, d) { try { const v = localStorage.getItem("mlbb." + k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k, v) { try { localStorage.setItem("mlbb." + k, JSON.stringify(v)); } catch { /* storage unavailable */ } },
};

class App {
  async init() {
    const [h, m, t] = await Promise.all(["heroes", "matches", "teams"].map((f) => fetch(`data/${f}.json`).then((r) => r.json())));
    this.heroes = h.heroes;
    this.byId = Object.fromEntries(this.heroes.map((x) => [x.id, x]));
    this.allGames = m.games;
    this.updated = m.updated;
    this.teamInfo = Object.fromEntries(t.map((x) => [x.name, x]));
    this.regions = [...new Set(this.allGames.map((g) => g.region))];
    this.filter = {
      regions: new Set(store.get("regions", this.regions).filter((r) => this.regions.includes(r))),
      days: store.get("days", 365),
    };
    if (!this.filter.regions.size) this.filter.regions = new Set(this.regions);

    this.draft = new Draft(this);
    this.bindGlobal();
    this.recompute();
  }

  icon(id) { return this.byId[id]?.icon || ""; }
  name(id) { return this.byId[id]?.name || id; }
  logo(team) { return this.teamInfo[team]?.logo; }

  bindGlobal() {
    const chips = $("regionChips");
    chips.innerHTML = this.regions.map((r) => `<span class="chip ${this.filter.regions.has(r) ? "on" : ""}" data-r="${r}">${r}</span>`).join("");
    chips.onclick = (e) => {
      const c = e.target.closest(".chip"); if (!c) return;
      const r = c.dataset.r;
      if (e.shiftKey) this.filter.regions = new Set([r]);           // shift-click: only this region
      else if (this.filter.regions.has(r) && this.filter.regions.size > 1) this.filter.regions.delete(r);
      else this.filter.regions.add(r);
      chips.querySelectorAll(".chip").forEach((x) => x.classList.toggle("on", this.filter.regions.has(x.dataset.r)));
      store.set("regions", [...this.filter.regions]);
      this.recompute();
    };
    $("periodSel").value = String(this.filter.days);
    $("periodSel").onchange = (e) => { this.filter.days = +e.target.value; store.set("days", this.filter.days); this.recompute(); };

    $("nav").onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this.show(b.dataset.page);
    };

    // tooltips on anything with data-tip=heroId
    const tip = $("tooltip");
    document.addEventListener("mouseover", (e) => {
      const el = e.target.closest("[data-tip]");
      if (!el || !this.stats) { tip.style.display = "none"; return; }
      tip.innerHTML = heroTooltip(this, el.dataset.tip);
      tip.style.display = "block";
    });
    document.addEventListener("mousemove", (e) => {
      if (tip.style.display !== "block") return;
      const x = Math.min(e.clientX + 16, innerWidth - tip.offsetWidth - 8);
      const y = Math.min(e.clientY + 16, innerHeight - tip.offsetHeight - 8);
      tip.style.left = x + "px"; tip.style.top = y + "px";
    });

    $("metaSearch").oninput = () => this.renderMeta();
    $("teamPageSel").onchange = () => this.renderTeam();
    $("heroPageSearch").oninput = () => this.renderHero();
    $("matchSearch").oninput = () => this.renderMatches();
    $("heroDatalist").innerHTML = this.heroes.map((h) => `<option value="${esc(h.name)}">`).join("");
    const ml = $("metaLane");
    this.metaLane = "all";
    ml.innerHTML = ["all", ...LANES].map((l) => `<button data-l="${l}" class="${l === "all" ? "on" : ""}">${l === "all" ? "All" : LANE_NAMES[l]}</button>`).join("");
    ml.onclick = (e) => {
      const b = e.target.closest("button"); if (!b) return;
      this.metaLane = b.dataset.l;
      ml.querySelectorAll("button").forEach((x) => x.classList.toggle("on", x === b));
      this.renderMeta();
    };
  }

  show(page) {
    document.querySelectorAll("#nav button").forEach((x) => x.classList.toggle("active", x.dataset.page === page));
    document.querySelectorAll(".page").forEach((p) => p.classList.toggle("active", p.id === "page-" + page));
    this.page = page;
    this.renderPage();
  }

  recompute() {
    this.games = filterGames(this.allGames, this.filter);
    this.stats = buildStats(this.games, { halfLife: 120 });
    this.engine = new Engine(this.stats, this.heroes);
    const teams = Object.values(this.stats.team).filter((t) => t.n >= 5).sort((a, b) => b.last.localeCompare(a.last) || b.n - a.n).map((t) => t.name);
    this.teamList = teams;
    this.draft.setTeams(teams);
    if (!this.hashLoaded) { this.hashLoaded = true; this.draft.loadHash(); }
    const tsel = $("teamPageSel"), cur = tsel.value;
    tsel.innerHTML = teams.map((t) => `<option>${esc(t)}</option>`).join("");
    if (teams.includes(cur)) tsel.value = cur;
    $("dataInfo").textContent = `${this.games.length} games · ${this.stats.earliest || "—"} → ${this.stats.latest || "—"} · scraped ${this.updated}`;
    this.draft.render();
    this.renderPage();
  }

  renderPage() {
    if (this.page === "meta") this.renderMeta();
    if (this.page === "teams") this.renderTeam();
    if (this.page === "heroes") this.renderHero();
    if (this.page === "matches") this.renderMatches();
  }

  // ---------------- META ----------------
  renderMeta() {
    const S = this.stats, q = $("metaSearch").value.toLowerCase();
    const rows = this.heroes.filter((h) => h.name.toLowerCase().includes(q) &&
      (this.metaLane === "all" || this.engine.lp[h.id][LANES.indexOf(this.metaLane)] > 0.15)).map((h) => {
      const s = S.hero[h.id] || { n: 0, nw: 0, nb: 0 };
      const pr = presence(S, h.id), wr = heroWR(S, h.id);
      const power = pr * 0.7 + (wr - 0.5) * 2.5;
      const lanes = this.engine.lp[h.id].map((p, i) => [LANES[i], p]).filter(([, p]) => p > 0.12).sort((a, b) => b[1] - a[1]).map(([l]) => LANE_NAMES[l]).join(", ");
      return { h, s, pr, wr, power, lanes, pick: pickRate(S, h.id), ban: banRate(S, h.id) };
    });
    const key = this.metaSort || "power", dir = this.metaDir || -1;
    const val = { name: (r) => r.h.name, power: (r) => r.power, pr: (r) => r.pr, pick: (r) => r.pick, ban: (r) => r.ban, wr: (r) => r.wr, n: (r) => r.s.n };
    rows.sort((a, b) => (val[key](a) > val[key](b) ? 1 : -1) * dir);
    const sorted = [...rows].sort((a, b) => b.power - a.power);
    const tierOf = new Map(sorted.map((r, i) => [r.h.id, i < 8 ? "S" : i < 22 ? "A" : i < 45 ? "B" : i < 75 ? "C" : "D"]));
    const th = (k, l) => `<th data-k="${k}">${l}${key === k ? (dir > 0 ? " ▲" : " ▼") : ""}</th>`;
    $("metaTable").innerHTML = `<thead><tr>${th("power", "Tier")}${th("name", "Hero")}<th>Lanes</th>${th("pr", "Presence")}${th("pick", "Pick %")}${th("ban", "Ban %")}${th("n", "Games")}${th("wr", "Win % (smoothed)")}</tr></thead>
      <tbody>${rows.map((r) => `<tr data-hero="${r.h.id}" style="cursor:pointer">
        <td><span class="tier ${tierOf.get(r.h.id)}">${tierOf.get(r.h.id)}</span></td>
        <td><div class="hcell" data-tip="${r.h.id}"><img src="${r.h.icon}" alt="">${esc(r.h.name)}</div></td>
        <td class="muted">${r.lanes}</td>
        <td><span class="bar" style="width:${r.pr * 80}px"></span>${pct(r.pr, 1)}</td>
        <td>${pct(r.pick, 1)}</td><td>${pct(r.ban, 1)}</td><td>${r.s.n}</td>
        <td class="${r.wr > 0.52 ? "good" : r.wr < 0.48 ? "bad" : ""}">${pct(r.wr, 1)} <span class="muted">(${r.s.n ? pct(r.s.nw / r.s.n) : "—"} raw)</span></td></tr>`).join("")}</tbody>`;
    $("metaTable").querySelector("thead").onclick = (e) => {
      const k = e.target.closest("th")?.dataset.k; if (!k) return;
      this.metaDir = this.metaSort === k ? -this.metaDir : -1; this.metaSort = k; this.renderMeta();
    };
    $("metaTable").querySelector("tbody").onclick = (e) => {
      const id = e.target.closest("tr")?.dataset.hero; if (!id) return;
      $("heroPageSearch").value = this.name(id); this.show("heroes");
    };
  }

  // ---------------- TEAMS ----------------
  renderTeam() {
    const name = $("teamPageSel").value, S = this.stats, t = S.team[name];
    const box = $("teamReport");
    if (!t) { box.innerHTML = `<div class="empty">No team data in this window.</div>`; return; }
    const picks = Object.entries(t.picks).map(([h, p]) => ({ h, ...p })).sort((a, b) => b.g - a.g).slice(0, 14);
    const bans = Object.entries(t.bans).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const bannedBy = Object.entries(t.bannedBy).sort((a, b) => b[1] - a[1]).slice(0, 10);
    const lanePicks = LANES.map((l, li) => {
      const c = {};
      for (const g of t.games) { const i = g.teams.indexOf(name); const h = g.picks[i][li]; c[h] = (c[h] || 0) + 1; }
      return [l, Object.entries(c).sort((a, b) => b[1] - a[1]).slice(0, 4)];
    });
    const side = (s) => t.side[s][0] ? `${pct(t.side[s][1] / t.side[s][0])} (${t.side[s][0]})` : "—";
    const row = (h, v, n) => `<div class="row" data-tip="${h}"><img src="${this.icon(h)}" alt="">${esc(this.name(h))}<span class="v">${v}</span><span class="n">${n}</span></div>`;
    const logo = this.logo(name);
    box.innerHTML = `
      <div class="team-banner">${logo ? `<img src="${logo}" alt="">` : ""}<div><h3>${esc(name)}</h3>
        <div class="stat-pills"><span class="pill">${t.n} games</span><span class="pill">Win ${pct(t.nw / t.n)}</span>
        <span class="pill">Blue side ${side("blue")}</span><span class="pill">Red side ${side("red")}</span><span class="pill">Last game ${t.last}</span></div>
        <div style="margin-top:8px"><button class="btn" id="draftVs">Draft against ${esc(name)}</button></div></div></div>
      <div class="report-grid">
        <div class="card"><div class="card-title">Most picked <span class="muted">WR · games</span></div><div class="hlist">${picks.map((p) => row(p.h, pct(p.nw / p.n), p.n)).join("")}</div></div>
        <div class="card"><div class="card-title">Their bans <span class="muted">share of games</span></div><div class="hlist">${bans.map(([h, v]) => row(h, pct(v / t.g), "")).join("")}</div>
          <div class="card-title" style="margin-top:12px">Opponents ban vs them <span class="muted">respect bans</span></div><div class="hlist">${bannedBy.map(([h, v]) => row(h, pct(v / t.g), "")).join("")}</div></div>
        <div class="card"><div class="card-title">Hero pool by lane</div>${lanePicks.map(([l, hs]) => `<div class="comp-row"><span>${LANE_NAMES[l]}</span><span>${hs.map(([h, n]) => `<img src="${this.icon(h)}" data-tip="${h}" title="${esc(this.name(h))} ×${n}" style="width:28px;height:28px;border-radius:6px;margin-left:3px" alt="">`).join("")}</span></div>`).join("")}
          <p class="muted">Ban plan: target their most-picked heroes they also win with, especially single-hero lanes.</p></div>
      </div>
      <h3 style="font-family:var(--display);margin:18px 0 8px">Recent games</h3>
      <div>${t.games.slice(-12).reverse().map((g) => this.gameCard(g)).join("")}</div>`;
    $("draftVs").onclick = () => {
      this.draft.teams[1] = name; $("teamSel1").value = name;
      this.show("draft"); this.draft.render();
    };
    this.bindGameButtons(box);
  }

  // ---------------- HEROES ----------------
  renderHero() {
    const q = $("heroPageSearch").value.toLowerCase().trim();
    const h = this.heroes.find((x) => x.name.toLowerCase() === q) || (q && this.heroes.find((x) => x.name.toLowerCase().startsWith(q)));
    const box = $("heroReport");
    if (!h) { box.innerHTML = `<div class="empty">Pick a hero to see their best partners, counters and threats.</div>`; return; }
    const S = this.stats, s = S.hero[h.id] || { n: 0, nw: 0, nb: 0, side: { blue: [0, 0], red: [0, 0] } }, k = kb(h.id);
    const others = this.heroes.filter((x) => x.id !== h.id);
    const syn = others.map((x) => ({ id: x.id, ...synergy(S, h.id, x.id) })).filter((x) => x.n >= 5).sort((a, b) => b.d - a.d);
    const vs = others.map((x) => ({ id: x.id, ...matchup(S, h.id, x.id) })).filter((x) => x.n >= 5).sort((a, b) => b.d - a.d);
    const row = (x) => `<div class="row" data-tip="${x.id}"><img src="${this.icon(x.id)}" alt="">${esc(this.name(x.id))}<span class="v ${x.d > 0 ? "good" : "bad"}">${pct(x.wr)}</span><span class="n">${x.n} games</span></div>`;
    const combos = COMBOS.filter(([a, b]) => a === h.id || b === h.id).map(([a, b, w]) => ({ id: a === h.id ? b : a, w }));
    const counters = COUNTERS.filter(([, b]) => b === h.id).map(([a, , w]) => ({ id: a, w }));
    const beats = COUNTERS.filter(([a]) => a === h.id).map(([, b, w]) => ({ id: b, w }));
    const cur = (x) => `<div class="row" data-tip="${x.id}"><img src="${this.icon(x.id)}" alt="">${esc(this.name(x.id))}<span class="muted" style="margin-left:8px">${esc(x.w)}</span></div>`;
    const teams = Object.values(S.team).map((t) => ({ t: t.name, ...teamPickRate(S, t.name, h.id) })).filter((x) => x.n >= 2).sort((a, b) => b.n - a.n).slice(0, 8);
    const lanes = this.engine.lp[h.id].map((p, i) => `${LANE_NAMES[LANES[i]]} ${pct(p)}`).filter((_, i) => this.engine.lp[h.id][i] > 0.05).join(" · ");
    box.innerHTML = `
      <div class="hero-head"><img src="${h.icon}" alt=""><div><h3>${esc(h.name)}</h3>
        <div class="muted">${k.roles.map((r) => ROLE_NAMES[r]).join(" / ")} · ${k.dmg === "M" ? "Magic" : "Physical"} damage · ${lanes}</div>
        <div class="stat-pills"><span class="pill">${s.n} pro games</span><span class="pill">WR ${s.n ? pct(s.nw / s.n, 1) : "—"}</span><span class="pill">${s.nb} bans</span>
        <span class="pill">Presence ${pct(presence(S, h.id))}</span><span class="pill">Blue WR ${s.side.blue[0] ? pct(s.side.blue[1] / s.side.blue[0]) : "—"}</span><span class="pill">Red WR ${s.side.red[0] ? pct(s.side.red[1] / s.side.red[0]) : "—"}</span></div></div></div>
      <div class="report-grid">
        <div class="card"><div class="card-title">Best teammates <span class="muted">WR together</span></div><div class="hlist">${syn.slice(0, 10).map(row).join("") || `<div class="empty">Not enough games.</div>`}</div></div>
        <div class="card"><div class="card-title">Strong against <span class="muted">${esc(h.name)}'s WR</span></div><div class="hlist">${vs.slice(0, 10).map(row).join("") || `<div class="empty">Not enough games.</div>`}</div></div>
        <div class="card"><div class="card-title">Countered by <span class="muted">${esc(h.name)}'s WR</span></div><div class="hlist">${vs.slice(-10).reverse().map(row).join("") || `<div class="empty">Not enough games.</div>`}</div></div>
        <div class="card"><div class="card-title">Known combos & counters</div><div class="hlist">
          ${combos.length ? `<div class="muted">Combos</div>${combos.map(cur).join("")}` : ""}
          ${beats.length ? `<div class="muted" style="margin-top:6px">Counters</div>${beats.map(cur).join("")}` : ""}
          ${counters.length ? `<div class="muted" style="margin-top:6px">Countered by</div>${counters.map(cur).join("")}` : ""}
          ${!combos.length && !beats.length && !counters.length ? `<div class="empty">No curated notes.</div>` : ""}</div></div>
        <div class="card"><div class="card-title">Teams that play it</div><div class="hlist">${teams.map((x) => `<div class="row">${this.logo(x.t) ? `<img src="${this.logo(x.t)}" style="object-fit:contain" alt="">` : ""}${esc(x.t)}<span class="v">${pct(x.wr)}</span><span class="n">${x.n} games</span></div>`).join("") || `<div class="empty">—</div>`}</div></div>
      </div>`;
  }

  // ---------------- MATCHES ----------------
  renderMatches() {
    const q = $("matchSearch").value.toLowerCase().trim();
    const list = this.games.filter((g) => !q || g.teams.some((t) => t.toLowerCase().includes(q)) ||
      g.picks.flat().some((h) => this.name(h).toLowerCase().includes(q))).slice().reverse();
    $("matchCount").textContent = `${list.length} games`;
    $("matchList").innerHTML = list.slice(0, 80).map((g) => this.gameCard(g)).join("") + (list.length > 80 ? `<div class="empty">Showing 80 most recent — refine the filter.</div>` : "");
    this.bindGameButtons($("matchList"));
  }

  gameCard(g) {
    const idx = this.games.indexOf(g);
    const side = (t) => {
      const logo = this.logo(g.teams[t]);
      return `<div class="side ${g.winner === t ? "win" : ""}"><span class="tn"><span class="sdot ${g.sides[t] || ""}"></span>${logo ? `<img src="${logo}" alt="">` : ""}${esc(g.teams[t])}</span>
        ${g.picks[t].map((h) => `<img class="h" src="${this.icon(h)}" data-tip="${h}" alt="">`).join("")}
        <span class="muted" style="margin:0 4px">bans</span>${g.bans[t].map((h) => `<img class="b" src="${this.icon(h)}" data-tip="${h}" alt="">`).join("")}</div>`;
    };
    return `<div class="game"><div class="meta">${g.date}<br>${esc(g.region)}<br>${esc(g.stage.split("/").slice(-1)[0])}${g.length ? `<br>${g.length}` : ""}<br><button class="btn" data-load="${idx}">Open in draft</button></div>
      <div>${side(0)}${side(1)}</div></div>`;
  }
  bindGameButtons(root) {
    root.querySelectorAll("[data-load]").forEach((b) => (b.onclick = () => { this.show("draft"); this.draft.loadGame(this.games[+b.dataset.load]); }));
  }
}

new App().init().catch((e) => {
  console.error(e);
  document.querySelector("main").innerHTML = `<div class="card"><h3>Couldn't load data</h3><p>Open this site through a local web server (run <code>start.bat</code> or <code>python serve.py</code>), not by double-clicking index.html.</p><pre>${esc(e.message)}</pre></div>`;
});
