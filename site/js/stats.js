// Aggregates Liquipedia games into hero / pair / matchup / team statistics.
// All counts are recency-weighted (w = 0.5 ^ (age / halfLife)); raw counts are kept for display.

export const LANES = ["exp", "jungle", "mid", "gold", "roam"];
export const LANE_NAMES = { exp: "EXP", jungle: "Jungle", mid: "Mid", gold: "Gold", roam: "Roam" };

const pairKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

export function filterGames(games, { regions, days, team }) {
  const latest = games.reduce((m, g) => (g.date && g.date > m ? g.date : m), "");
  const cutoff = days ? addDays(latest, -days) : "";
  return games.filter((g) =>
    (!regions || regions.has(g.region)) &&
    (!cutoff || (g.date && g.date >= cutoff)) &&
    (!team || g.teams.includes(team)));
}

function addDays(iso, n) {
  const d = new Date(iso + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function buildStats(games, { halfLife = 120 } = {}) {
  const latest = games.reduce((m, g) => (g.date && g.date > m ? g.date : m), "");
  const latestT = latest ? Date.parse(latest) : Date.now();
  const S = { games: games.length, totalW: 0, hero: {}, pair: {}, vs: {}, team: {}, latest, earliest: games[0]?.date };

  const H = (h) => (S.hero[h] ||= { g: 0, w: 0, b: 0, b1: 0, n: 0, nw: 0, nb: 0, lanes: [0, 0, 0, 0, 0], side: { blue: [0, 0], red: [0, 0] } });
  const T = (t) => (S.team[t] ||= { name: t, n: 0, nw: 0, g: 0, picks: {}, bans: {}, bannedBy: {}, side: { blue: [0, 0], red: [0, 0] }, last: "", games: [] });

  for (const g of games) {
    const age = g.date ? (latestT - Date.parse(g.date)) / 864e5 : 365;
    const w = halfLife ? Math.pow(0.5, age / halfLife) : 1;
    S.totalW += w;
    for (let t = 0; t < 2; t++) {
      const won = g.winner === t ? 1 : 0;
      const side = g.sides[t];
      const picks = g.picks[t], opp = g.picks[1 - t];
      const tm = T(g.teams[t]);
      tm.n++; tm.nw += won; tm.g += w; tm.games.push(g);
      if (g.date > tm.last) tm.last = g.date;
      if (side) { tm.side[side][0]++; tm.side[side][1] += won; }
      picks.forEach((h, lane) => {
        const s = H(h);
        s.g += w; s.w += w * won; s.n++; s.nw += won; s.lanes[lane] += w;
        if (side) { s.side[side][0]++; s.side[side][1] += won; }
        const tp = (tm.picks[h] ||= { g: 0, w: 0, n: 0, nw: 0 });
        tp.g += w; tp.w += w * won; tp.n++; tp.nw += won;
      });
      g.bans[t].forEach((h, i) => {
        const s = H(h);
        s.b += w; s.nb++;
        if (i < 3) s.b1 += w;
        tm.bans[h] = (tm.bans[h] || 0) + w;
        const opp = T(g.teams[1 - t]);
        opp.bannedBy[h] = (opp.bannedBy[h] || 0) + w;
      });
      for (let i = 0; i < 5; i++) for (let j = i + 1; j < 5; j++) {
        const p = (S.pair[pairKey(picks[i], picks[j])] ||= { g: 0, w: 0, n: 0 });
        p.g += w; p.w += w * won; p.n++;
      }
      if (t === 0) for (const a of picks) for (const b of opp) {
        // stored from the alphabetically-first hero's point of view
        const [x, y, xw] = a < b ? [a, b, won] : [b, a, 1 - won];
        const v = (S.vs[`${x}>${y}`] ||= { g: 0, w: 0, n: 0 });
        v.g += w; v.w += w * xw; v.n++;
      }
    }
  }
  return S;
}

// ---- smoothed accessors (values are win-rate deltas, e.g. +0.06 = +6 %) ----
const K_HERO = 10, K_PAIR = 8, K_VS = 8;

export function heroWR(S, h) {
  const s = S.hero[h];
  return s ? (s.w + K_HERO * 0.5) / (s.g + K_HERO) : 0.5;
}
export function presence(S, h) {
  const s = S.hero[h];
  return s && S.totalW ? Math.min(1, (s.g + s.b) / S.totalW) : 0;
}
export function pickRate(S, h) { const s = S.hero[h]; return s && S.totalW ? s.g / S.totalW : 0; }
export function banRate(S, h) { const s = S.hero[h]; return s && S.totalW ? s.b / S.totalW : 0; }

export function synergy(S, a, b) {
  const p = S.pair[pairKey(a, b)];
  if (!p) return { d: 0, n: 0 };
  const exp = clamp(heroWR(S, a) + heroWR(S, b) - 0.5, 0.2, 0.8);
  return { d: (p.w + K_PAIR * exp) / (p.g + K_PAIR) - exp, n: p.n, wr: p.w / p.g };
}

// advantage of hero a when facing hero b
export function matchup(S, a, b) {
  const [x, y] = a < b ? [a, b] : [b, a];
  const v = S.vs[`${x}>${y}`];
  if (!v) return { d: 0, n: 0 };
  const exp = clamp(0.5 + heroWR(S, x) - heroWR(S, y), 0.2, 0.8);
  let d = (v.w + K_VS * exp) / (v.g + K_VS) - exp;
  let raw = v.w / v.g;
  if (x !== a) { d = -d; raw = 1 - raw; }
  return { d, n: v.n, wr: raw };
}

// lane probabilities for a hero: data-driven with the Liquipedia lane as prior
export function laneProbs(S, hero) {
  const s = S.hero[hero.id];
  const prior = LANES.map((l) => (hero.lanes.includes(l) ? 3 : 0.05));
  const counts = LANES.map((_, i) => (s ? s.lanes[i] : 0) + prior[i]);
  const tot = counts.reduce((a, b) => a + b, 0);
  return counts.map((c) => c / tot);
}

export function teamPickRate(S, team, h) {
  const t = S.team[team];
  const p = t?.picks[h];
  return p ? { rate: p.g / t.g, n: p.n, wr: p.nw / p.n } : { rate: 0, n: 0, wr: 0 };
}

export const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
export const pct = (x, d = 0) => (x * 100).toFixed(d) + "%";
export const signed = (x, d = 1) => (x >= 0 ? "+" : "") + (x * 100).toFixed(d);
