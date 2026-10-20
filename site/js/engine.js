// Draft recommendation engine: scores candidate picks / bans with human-readable reasons.
import { kb, COMBOS, COUNTERS } from "./kb.js";
import { LANES, LANE_NAMES, heroWR, presence, synergy, matchup, laneProbs, teamPickRate, clamp, pct, signed } from "./stats.js";

const comboMap = new Map(), counterMap = new Map();
for (const [a, b, why] of COMBOS) { comboMap.set(a + "|" + b, why); comboMap.set(b + "|" + a, why); }
for (const [a, b, why] of COUNTERS) counterMap.set(a + ">" + b, why);

export class Engine {
  constructor(stats, heroes) {
    this.S = stats;
    this.heroes = heroes;
    this.byId = Object.fromEntries(heroes.map((h) => [h.id, h]));
    this.lp = Object.fromEntries(heroes.map((h) => [h.id, laneProbs(stats, h)]));
  }

  // Best lane assignment for up to 5 heroes. Returns { lanes: [laneIdx per hero], p: probability product }
  assign(ids) {
    let best = { lanes: [], p: ids.length ? 0 : 1 };
    const used = new Array(5).fill(false), cur = [];
    const rec = (i, p) => {
      if (p <= best.p) return;
      if (i === ids.length) { best = { lanes: cur.slice(), p }; return; }
      for (let l = 0; l < 5; l++) if (!used[l]) {
        used[l] = true; cur.push(l);
        rec(i + 1, p * this.lp[ids[i]][l]);
        used[l] = false; cur.pop();
      }
    };
    rec(0, 1);
    return best;
  }

  // how plausibly a candidate fits the remaining lanes (0..1) and which lane it would take
  laneFit(picks, c) {
    const base = this.assign(picks), withC = this.assign([...picks, c]);
    const fit = base.p > 0 ? clamp(withC.p / base.p / Math.max(...this.lp[c]), 0, 1) : 0;
    return { fit, lane: LANES[withC.lanes[withC.lanes.length - 1]] };
  }

  composition(picks) {
    const k = picks.map(kb);
    const phys = k.filter((x) => x.dmg === "P").length, mag = k.length - phys;
    const tags = {};
    k.forEach((x) => x.tags.forEach((t) => (tags[t] = (tags[t] || 0) + 1)));
    return {
      phys, mag, tags,
      cc: k.reduce((a, x) => a + x.cc, 0),
      front: k.filter((x) => x.dur >= 3).length,
      burst: k.reduce((a, x) => a + x.burst, 0),
      mob: k.reduce((a, x) => a + x.mob, 0),
      curve: { E: k.filter((x) => x.curve === "E").length, M: k.filter((x) => x.curve === "M").length, L: k.filter((x) => x.curve === "L").length },
      dashers: picks.filter((h) => kb(h).mob >= 3 || kb(h).tags.includes("dash")),
      healers: picks.filter((h) => kb(h).tags.some((t) => t === "heal" || t === "sustain")),
      lanes: this.assign(picks).lanes.map((l) => LANES[l]),
    };
  }

  /**
   * Score every available hero as a PICK for `ctx.side`.
   * ctx: { ours: [ids], theirs: [ids], unavailable: Set, ourTeam, theirTeam }
   */
  suggestPicks(ctx) {
    const { ours, theirs, unavailable, ourTeam, theirTeam } = ctx;
    const comp = this.composition(ours), enemy = this.composition(theirs);
    const out = [];
    for (const h of this.heroes) {
      const c = h.id;
      if (unavailable.has(c)) continue;
      const reasons = [];
      const k = kb(c);
      let score = 0;

      // 1. Meta strength from pro play
      const wr = heroWR(this.S, c), pr = presence(this.S, c);
      const meta = (wr - 0.5) * 60 + pr * 22;
      score += meta;
      if (pr > 0.35) reasons.push({ t: "meta", txt: `Pro priority: ${pct(pr)} pick/ban presence, ${pct(wr)} WR` });
      else if (wr > 0.54 && this.S.hero[c]?.n >= 8) reasons.push({ t: "meta", txt: `Strong pro WR ${pct(wr)} (${this.S.hero[c].n} games)` });

      // 2. Lane fit
      const lf = ours.length ? this.laneFit(ours, c) : { fit: 1, lane: LANES[this.lp[c].indexOf(Math.max(...this.lp[c]))] };
      score += Math.max(-30, Math.log(Math.max(lf.fit, 1e-3)) * 7);
      if (ours.length && lf.fit > 0.4) reasons.push({ t: "lane", txt: `Fills ${LANE_NAMES[lf.lane]} lane` });

      // 3. Synergy with our picks
      for (const p of ours) {
        const s = synergy(this.S, c, p);
        const v = clamp(s.d * 100, -8, 8) * Math.min(1, s.n / 6);
        score += v;
        if (v > 2.5 && s.n >= 5) reasons.push({ t: "syn", h: p, txt: `Pairs with ${this.name(p)}: ${pct(s.wr)} WR together (${s.n} games)` });
        const why = comboMap.get(c + "|" + p);
        if (why) { score += 5; reasons.push({ t: "syn", h: p, txt: why }); }
      }

      // 4. Counters vs enemy picks
      for (const e of theirs) {
        const m = matchup(this.S, c, e);
        const v = clamp(m.d * 100, -8, 8) * Math.min(1, m.n / 6);
        score += v;
        if (v > 2.5 && m.n >= 5) reasons.push({ t: "ctr", h: e, txt: `Good vs ${this.name(e)}: ${pct(m.wr)} WR (${m.n} games)` });
        if (v < -3 && m.n >= 5) reasons.push({ t: "warn", h: e, txt: `Struggles vs ${this.name(e)}: ${pct(m.wr)} WR (${m.n} games)` });
        const why = counterMap.get(c + ">" + e);
        if (why) { score += 5; reasons.push({ t: "ctr", h: e, txt: why }); }
        const bad = counterMap.get(e + ">" + c);
        if (bad) { score -= 4; reasons.push({ t: "warn", h: e, txt: `Countered: ${bad}` }); }
      }

      // 5. Composition needs
      if (ours.length >= 2) {
        if (k.dmg === "M" && comp.mag === 0) { score += 4; reasons.push({ t: "comp", txt: "Adds magic damage (team is all physical)" }); }
        if (k.dmg === "P" && comp.phys === 0) { score += 4; reasons.push({ t: "comp", txt: "Adds physical damage (team is all magic)" }); }
        if ((k.dmg === "M" ? comp.mag : comp.phys) >= 3) score -= 4;
      }
      if (ours.length >= 2 && comp.front === 0 && k.dur >= 3) { score += 4; reasons.push({ t: "comp", txt: "Gives the team a frontline" }); }
      if (ours.length >= 2 && comp.cc < 4 && k.cc >= 2) { score += 2; reasons.push({ t: "comp", txt: "Adds crowd control" }); }
      if (enemy.dashers.length >= 2 && k.tags.includes("antidash")) { score += 5; reasons.push({ t: "ctr", txt: `Anti-dash vs ${enemy.dashers.map((x) => this.name(x)).join(", ")}` }); }
      if (enemy.healers.length >= 2 && k.tags.includes("antiheal")) { score += 4; reasons.push({ t: "ctr", txt: "Anti-heal vs sustain-heavy enemy" }); }
      if (enemy.tags.aoe >= 2 && k.tags.includes("anticc")) { score += 3; reasons.push({ t: "ctr", txt: "Cleanses enemy wombo CC" }); }

      // 6. Team comfort / denial
      if (ourTeam) {
        const tp = teamPickRate(this.S, ourTeam, c);
        if (tp.n >= 2) {
          score += tp.rate * 18 + (tp.wr - 0.5) * 6 * Math.min(1, tp.n / 5);
          if (tp.rate > 0.1) reasons.push({ t: "team", txt: `${ourTeam} comfort pick: ${tp.n} games, ${pct(tp.wr)} WR` });
        }
      }
      if (theirTeam) {
        const tp = teamPickRate(this.S, theirTeam, c);
        if (tp.rate > 0.15 && tp.n >= 3) { score += tp.rate * 10; reasons.push({ t: "deny", txt: `Denies ${theirTeam}'s pick (${tp.n} games, ${pct(tp.wr)} WR)` }); }
      }
      out.push({ id: c, score, reasons, lane: lf.lane, fit: lf.fit });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  /** Score every available hero as a BAN for ctx.side (threat it poses to us). */
  suggestBans(ctx) {
    const { ours, theirs, unavailable, ourTeam, theirTeam } = ctx;
    const out = [];
    for (const h of this.heroes) {
      const c = h.id;
      if (unavailable.has(c)) continue;
      const reasons = [];
      const wr = heroWR(this.S, c), pr = presence(this.S, c);
      let score = pr * 30 + (wr - 0.5) * 50;
      if (pr > 0.3) reasons.push({ t: "meta", txt: `Contested: ${pct(pr)} presence, ${pct(wr)} WR` });

      if (theirTeam) {
        const tp = teamPickRate(this.S, theirTeam, c);
        if (tp.n >= 2) {
          score += tp.rate * 30 + (tp.wr - 0.5) * 10 * Math.min(1, tp.n / 5);
          if (tp.rate > 0.12) reasons.push({ t: "team", txt: `${theirTeam} signature: ${tp.n} games, ${pct(tp.wr)} WR` });
        }
        const resp = this.S.team[theirTeam]?.bannedBy[c] || 0, tg = this.S.team[theirTeam]?.g || 1;
        if (resp / tg > 0.25) { score += (resp / tg) * 6; reasons.push({ t: "team", txt: `Opponents ban it vs ${theirTeam} in ${pct(resp / tg)} of games` }); }
      }
      if (ourTeam) {
        const tp = teamPickRate(this.S, ourTeam, c);
        if (tp.rate > 0.15) { score -= tp.rate * 15; reasons.push({ t: "warn", txt: `${ourTeam} plays this hero themselves` }); }
      }
      for (const p of ours) {
        const m = matchup(this.S, c, p);
        const v = clamp(m.d * 100, -8, 8) * Math.min(1, m.n / 6);
        score += v;
        if (v > 2.5 && m.n >= 5) reasons.push({ t: "ctr", h: p, txt: `Counters our ${this.name(p)}: ${pct(m.wr)} WR (${m.n} games)` });
        const why = counterMap.get(c + ">" + p);
        if (why) { score += 6; reasons.push({ t: "ctr", h: p, txt: `Threat to ${this.name(p)}: ${why}` }); }
      }
      for (const e of theirs) {
        const s = synergy(this.S, c, e);
        const v = clamp(s.d * 100, -8, 8) * Math.min(1, s.n / 6);
        score += v;
        if (v > 2.5 && s.n >= 5) reasons.push({ t: "syn", h: e, txt: `Enables enemy ${this.name(e)}: ${pct(s.wr)} WR together` });
        const why = comboMap.get(c + "|" + e);
        if (why) { score += 5; reasons.push({ t: "syn", h: e, txt: `Enemy combo: ${why}` }); }
      }
      if (theirs.length) {
        const lf = this.laneFit(theirs, c);
        score *= 0.35 + 0.65 * lf.fit;
        if (lf.fit < 0.25) reasons.push({ t: "warn", txt: "Enemy already has that lane covered" });
      }
      out.push({ id: c, score, reasons });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  // Rough draft win estimate for side 0 vs side 1 from hero strength, synergy and matchups.
  winEstimate(a, b) {
    if (!a.length && !b.length) return { p: 0.5, parts: null };
    const str = (xs) => xs.reduce((s, h) => s + (heroWR(this.S, h) - 0.5), 0);
    const syn = (xs) => {
      let s = 0;
      for (let i = 0; i < xs.length; i++) for (let j = i + 1; j < xs.length; j++) {
        const r = synergy(this.S, xs[i], xs[j]);
        s += clamp(r.d, -0.08, 0.08) * Math.min(1, r.n / 4);
      }
      return s;
    };
    let mu = 0;
    for (const x of a) for (const y of b) {
      const m = matchup(this.S, x, y);
      mu += clamp(m.d, -0.08, 0.08) * Math.min(1, m.n / 6);
    }
    const parts = { strength: str(a) - str(b), synergy: syn(a) - syn(b), matchups: mu / 2 };
    const z = parts.strength + parts.synergy * 0.6 + parts.matchups;
    return { p: 1 / (1 + Math.exp(-z * 2)), parts };
  }

  name(id) { return this.byId[id]?.name || id; }
}

export { signed };
