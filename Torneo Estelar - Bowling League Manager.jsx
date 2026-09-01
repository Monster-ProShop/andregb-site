import React, { useState, useEffect, useMemo, useCallback } from "react";

/* ============================================================================
   TORNEO ESTELAR — Bowling League Manager
   Single-file React app. Data persists via window.storage (personal, per user).
   ============================================================================ */

/* ---------------------------- constants ---------------------------------- */

const CATEGORIES = ["Oro", "Plata", "Bronze", "Niquel"];
const GROUPS = ["Oro", "Plata"];
const BLIND_SCORE = 190;
const STORAGE_KEY = "torneo-estelar:league:v1";

const CATEGORY_MAX = { Oro: 10, Plata: 20, Bronze: 30, Niquel: 40 };
function categoryMax(category, isWoman) {
  if (category === "Niquel" && isWoman) return 50;
  return CATEGORY_MAX[category] ?? 0;
}
function calcHandicapFromAverage(average, category, isWoman) {
  if (average == null || Number.isNaN(average)) return 0;
  const raw = Math.max(0, 220 - average) * 0.9;
  const max = categoryMax(category, isWoman);
  return Math.min(Math.floor(raw), max);
}

function uid(prefix = "id") {
  return `${prefix}_${Math.random().toString(36).slice(2, 9)}_${Date.now().toString(36)}`;
}

/* ---------------------------- storage helpers ------------------------------ */

async function loadLeague() {
  try {
    const res = await window.storage.get(STORAGE_KEY, false);
    if (!res) return null;
    return JSON.parse(res.value);
  } catch (e) {
    return null;
  }
}
async function saveLeague(league) {
  try {
    await window.storage.set(STORAGE_KEY, JSON.stringify(league), false);
    return true;
  } catch (e) {
    console.error("Error guardando la liga", e);
    return false;
  }
}
async function deleteLeagueStorage() {
  try {
    await window.storage.delete(STORAGE_KEY, false);
  } catch (e) {
    /* ignore */
  }
}

/* ---------------------------- schedule generation -------------------------- */

// Standard circle-method round robin. Returns array of "rounds"; each round is
// an array of [teamIdHome, teamIdAway] pairs. If odd number of teams, a "BYE"
// placeholder absorbs one slot per round.
function generateRoundRobin(teamIds) {
  let teams = [...teamIds];
  if (teams.length < 2) return [];
  if (teams.length % 2 !== 0) teams.push("BYE");
  const n = teams.length;
  const rounds = n - 1;
  const half = n / 2;
  let arr = [...teams];
  const schedule = [];
  for (let r = 0; r < rounds; r++) {
    const roundMatches = [];
    for (let i = 0; i < half; i++) {
      const home = arr[i];
      const away = arr[n - 1 - i];
      if (home !== "BYE" && away !== "BYE") {
        // Alternate which side is "lane A" each round so lane-side rotates,
        // approximating USBC-style lane-assignment rotation.
        roundMatches.push(r % 2 === 0 ? [home, away] : [away, home]);
      }
    }
    schedule.push(roundMatches);
    const fixed = arr[0];
    const rest = arr.slice(1);
    rest.unshift(rest.pop());
    arr = [fixed, ...rest];
  }
  return schedule;
}

// Build the full season plan: for each week 1..sessionsCount, either a regular
// round-robin round (cycling / reversing home-away if the season is longer
// than one full round robin) or a placeholder for a positions round.
function buildSeasonPlan(league) {
  const teamIds = league.teams.map((t) => t.id);
  const baseRounds = generateRoundRobin(teamIds);
  const plan = [];
  let regularIdx = 0;
  const positionsWeeks = new Map(league.positionsRounds.map((p) => [p.week, p.type]));
  for (let week = 1; week <= league.sessionsCount; week++) {
    if (positionsWeeks.has(week)) {
      plan.push({ week, type: "positions", positionsType: positionsWeeks.get(week), pairs: null });
    } else {
      if (baseRounds.length === 0) {
        plan.push({ week, type: "regular", pairs: [] });
      } else {
        const cycle = Math.floor(regularIdx / baseRounds.length);
        const round = baseRounds[regularIdx % baseRounds.length];
        const pairs = cycle % 2 === 0 ? round : round.map(([a, b]) => [b, a]);
        plan.push({ week, type: "regular", pairs });
        regularIdx++;
      }
    }
  }
  return plan;
}

function assignLanes(pairs, startLane = 1) {
  return pairs.map((pair, i) => ({ pair, lanes: [startLane + i * 2, startLane + i * 2 + 1] }));
}

/* ---------------------------- bowler stat helpers --------------------------- */

// All scratch (non-blind) games a bowler has bowled, in week order, reading
// only from *saved* weeks strictly before `beforeWeek` (or all saved weeks if
// beforeWeek is undefined).
function bowlerScratchGamesBefore(league, bowlerId, beforeWeek) {
  const out = [];
  const weeks = Object.keys(league.weeklyResults)
    .map(Number)
    .sort((a, b) => a - b);
  for (const w of weeks) {
    if (beforeWeek != null && w >= beforeWeek) continue;
    const wr = league.weeklyResults[w];
    for (const m of wr.matches) {
      if (!m.saved) continue;
      const line = m.lineup[bowlerId];
      if (!line) continue;
      line.forEach((s) => {
        if (s !== "B" && s !== null && s !== undefined && s !== "") out.push(Number(s));
      });
    }
  }
  return out;
}

function bowlerHandicapForWeek(bowler, league, week) {
  const prior = bowlerScratchGamesBefore(league, bowler.id, week);
  const priorCount = prior.length;
  const priorTotal = prior.reduce((a, b) => a + b, 0);
  let baseAverage = null;
  if (bowler.enteringAverage != null && bowler.enteringAverage !== "") {
    baseAverage = priorCount < 9 ? Number(bowler.enteringAverage) : Math.floor(priorTotal / priorCount);
  } else {
    if (priorCount < 2) return 0;
    baseAverage = Math.floor(priorTotal / priorCount);
  }
  return calcHandicapFromAverage(baseAverage, bowler.category, bowler.isWoman);
}

function bowlerCareerStats(bowler, league, uptoWeek) {
  const games = bowlerScratchGamesBefore(league, bowler.id, uptoWeek != null ? uptoWeek + 1 : undefined);
  const gamesPlayed = games.length;
  const totalPins = games.reduce((a, b) => a + b, 0);
  const average = gamesPlayed > 0 ? totalPins / gamesPlayed : null;
  const bestGame = gamesPlayed > 0 ? Math.max(...games) : null;
  return { gamesPlayed, totalPins, average, bestGame };
}

/* ---------------------------- match computations ---------------------------- */

function scoreValue(entry) {
  if (entry === "B" || entry === "b") return { score: BLIND_SCORE, blind: true };
  const n = Number(entry);
  return { score: Number.isFinite(n) ? n : 0, blind: false };
}

// Compute per-game and series totals (with handicap) for a saved match, for a
// given side ("A" or "B" -> teamA/teamB), using the frozen handicapUsed map.
function teamGameTotals(match, side) {
  const teamId = side === "A" ? match.teamA : match.teamB;
  const bowlerIds = Object.keys(match.lineup).filter((bid) => match.bowlerTeam[bid] === teamId);
  const gameTotals = [0, 0, 0];
  let anyBlind = false;
  bowlerIds.forEach((bid) => {
    const line = match.lineup[bid] || [];
    const hcp = match.handicapUsed[bid] || 0;
    line.forEach((entry, gi) => {
      if (entry === "" || entry === null || entry === undefined) return;
      const { score, blind } = scoreValue(entry);
      if (blind) anyBlind = true;
      gameTotals[gi] += score + (blind ? 0 : hcp);
    });
  });
  const seriesTotal = gameTotals.reduce((a, b) => a + b, 0);
  return { gameTotals, seriesTotal, anyBlind, bowlerIds };
}

// Compute automated points for a saved match: 1 pt per game (3), 2 pts series,
// 1 pt assistance (no blinds on either side). Manual: prontoPago, uniforme.
function computeMatchPoints(match) {
  const a = teamGameTotals(match, "A");
  const b = teamGameTotals(match, "B");
  const points = { A: 0, B: 0 };
  for (let g = 0; g < 3; g++) {
    if (a.gameTotals[g] > b.gameTotals[g]) points.A += 1;
    else if (b.gameTotals[g] > a.gameTotals[g]) points.B += 1;
    else {
      points.A += 0.5;
      points.B += 0.5;
    }
  }
  if (a.seriesTotal > b.seriesTotal) points.A += 2;
  else if (b.seriesTotal > a.seriesTotal) points.B += 2;
  else {
    points.A += 1;
    points.B += 1;
  }
  if (!a.anyBlind) points.A += 1;
  if (!b.anyBlind) points.B += 1;
  if (match.prontoPago?.A) points.A += 1;
  if (match.prontoPago?.B) points.B += 1;
  if (match.uniforme?.A) points.A += 1;
  if (match.uniforme?.B) points.B += 1;
  return { points, totals: { A: a, B: b } };
}

/* ---------------------------- standings ------------------------------------- */

function computeTeamStandings(league) {
  const byGroup = { Oro: [], Plata: [] };
  const acc = {};
  league.teams.forEach((t) => {
    acc[t.id] = { teamId: t.id, name: t.name, group: t.group, points: 0, pinfall: 0, highGame: 0, possiblePoints: 0 };
  });
  Object.entries(league.weeklyResults).forEach(([week, wr]) => {
    wr.matches.forEach((m) => {
      if (!m.saved) return;
      const { points, totals } = computeMatchPoints(m);
      acc[m.teamA].points += points.A;
      acc[m.teamB].points += points.B;
      acc[m.teamA].pinfall += totals.A.seriesTotal;
      acc[m.teamB].pinfall += totals.B.seriesTotal;
      acc[m.teamA].highGame = Math.max(acc[m.teamA].highGame, ...totals.A.gameTotals);
      acc[m.teamB].highGame = Math.max(acc[m.teamB].highGame, ...totals.B.gameTotals);
      acc[m.teamA].possiblePoints += 8;
      acc[m.teamB].possiblePoints += 8;
    });
  });
  Object.values(acc).forEach((row) => {
    byGroup[row.group]?.push(row);
  });
  GROUPS.forEach((g) => {
    byGroup[g].sort((x, y) => y.points - x.points || y.pinfall - x.pinfall || y.highGame - x.highGame);
  });
  return byGroup;
}

const GAMES_PER_WEEK = 3;

function totalPossibleGamesForBowlerRange(league) {
  return league.sessionsCount * GAMES_PER_WEEK;
}

function computeIndividualStandings(league, currentWeek) {
  const totalPossible = totalPossibleGamesForBowlerRange(league);
  const requiredGames = Math.ceil(totalPossible * 0.8);
  const byCategory = {};
  CATEGORIES.forEach((c) => (byCategory[c] = []));
  league.bowlers.forEach((b) => {
    const stats = bowlerCareerStats(b, league);
    const remainingWeeks = Math.max(0, league.sessionsCount - currentWeek);
    const maxPossible = stats.gamesPlayed + remainingWeeks * GAMES_PER_WEEK;
    const eliminated = maxPossible < requiredGames;
    byCategory[b.category]?.push({
      bowlerId: b.id,
      name: b.name,
      teamId: b.teamId,
      isWoman: b.isWoman,
      gamesPlayed: stats.gamesPlayed,
      average: stats.average,
      bestGame: stats.bestGame,
      qualifies: !eliminated,
    });
  });
  CATEGORIES.forEach((c) => {
    byCategory[c].sort((x, y) => {
      if (x.qualifies !== y.qualifies) return x.qualifies ? -1 : 1;
      const ax = x.average ?? -1;
      const ay = y.average ?? -1;
      return ay - ax;
    });
  });
  return { byCategory, requiredGames, totalPossible };
}

function computeLeagueRecords(league) {
  let highTeamGame = { value: 0 };
  let highTeamSeries = { value: 0 };
  let highIndGame = { value: 0 };
  let highIndSeries = { value: 0 };
  const scratch300 = [];
  const scratch800 = [];
  const teamsById = Object.fromEntries(league.teams.map((t) => [t.id, t]));
  const bowlersById = Object.fromEntries(league.bowlers.map((b) => [b.id, b]));

  Object.entries(league.weeklyResults).forEach(([week, wr]) => {
    wr.matches.forEach((m) => {
      if (!m.saved) return;
      const a = teamGameTotals(m, "A");
      const b = teamGameTotals(m, "B");
      [
        { side: "A", teamId: m.teamA, t: a },
        { side: "B", teamId: m.teamB, t: b },
      ].forEach(({ teamId, t }) => {
        const maxG = Math.max(...t.gameTotals);
        if (maxG > highTeamGame.value) highTeamGame = { value: maxG, teamId, week };
        if (t.seriesTotal > highTeamSeries.value) highTeamSeries = { value: t.seriesTotal, teamId, week };
      });
      // individual
      Object.keys(m.lineup).forEach((bid) => {
        const line = m.lineup[bid] || [];
        const hcp = m.handicapUsed[bid] || 0;
        let scratchSeries = 0;
        let hasBlind = false;
        line.forEach((entry, gi) => {
          if (entry === "" || entry == null) return;
          const { score, blind } = scoreValue(entry);
          if (blind) {
            hasBlind = true;
            return;
          }
          scratchSeries += score;
          const gameWithHcp = score + hcp;
          if (gameWithHcp > highIndGame.value) highIndGame = { value: gameWithHcp, bowlerId: bid, week, gi };
          if (score === 300) scratch300.push({ bowlerId: bid, week, gi });
        });
        const seriesWithHcp = scratchSeries + hcp * line.filter((e) => e !== "B" && e !== "" && e != null).length;
        if (!hasBlind && seriesWithHcp > highIndSeries.value) {
          highIndSeries = { value: seriesWithHcp, bowlerId: bid, week };
        }
        if (!hasBlind && scratchSeries >= 800) scratch800.push({ bowlerId: bid, week, series: scratchSeries });
      });
    });
  });

  scratch300.sort((x, y) => x.week - y.week);
  scratch800.sort((x, y) => x.week - y.week);

  return {
    highTeamGame: highTeamGame.value ? { ...highTeamGame, name: teamsById[highTeamGame.teamId]?.name } : null,
    highTeamSeries: highTeamSeries.value ? { ...highTeamSeries, name: teamsById[highTeamSeries.teamId]?.name } : null,
    highIndGame: highIndGame.value ? { ...highIndGame, name: bowlersById[highIndGame.bowlerId]?.name } : null,
    highIndSeries: highIndSeries.value ? { ...highIndSeries, name: bowlersById[highIndSeries.bowlerId]?.name } : null,
    scratch300: scratch300.map((r) => ({ ...r, name: bowlersById[r.bowlerId]?.name })),
    scratch800: scratch800.map((r) => ({ ...r, name: bowlersById[r.bowlerId]?.name })),
  };
}

/* ============================================================================
   MAIN APP
   ============================================================================ */

export default function App() {
  const [league, setLeague] = useState(undefined); // undefined = loading, null = none yet
  const [tab, setTab] = useState("teams");
  const [saveState, setSaveState] = useState("idle");

  useEffect(() => {
    (async () => {
      const l = await loadLeague();
      setLeague(l);
    })();
  }, []);

  const persist = useCallback(async (next) => {
    setLeague(next);
    setSaveState("saving");
    const ok = await saveLeague(next);
    setSaveState(ok ? "saved" : "error");
    setTimeout(() => setSaveState("idle"), 1500);
  }, []);

  if (league === undefined) {
    return (
      <div style={styles.loadingScreen}>
        <StyleBlock />
        <div style={styles.loadingLogo}>🎳</div>
        <div style={{ color: TOKENS.textDim, fontFamily: TOKENS.fontBody }}>Cargando Torneo Estelar…</div>
      </div>
    );
  }

  if (!league || league.setupComplete !== true) {
    return (
      <div style={styles.appShell}>
        <StyleBlock />
        <SetupWizard existing={league} onComplete={persist} />
      </div>
    );
  }

  return (
    <div style={styles.appShell}>
      <StyleBlock />
      <Header league={league} saveState={saveState} />
      <div style={styles.body}>
        <Sidebar tab={tab} setTab={setTab} league={league} />
        <main style={styles.main}>
          {tab === "teams" && <TeamsView league={league} onChange={persist} />}
          {tab === "schedule" && <ScheduleView league={league} onChange={persist} />}
          {tab === "entry" && <WeekEntryView league={league} onChange={persist} />}
          {tab === "standings" && <StandingsView league={league} />}
          {tab === "records" && <RecordsView league={league} />}
          {tab === "data" && <DataView league={league} onChange={persist} />}
        </main>
      </div>
    </div>
  );
}

/* ---------------------------- design tokens & shared style ------------------ */

const TOKENS = {
  bg: "#0B1220",
  panel: "#121A2E",
  panelAlt: "#0E1526",
  line: "#243156",
  gold: "#F0B429",
  goldSoft: "#C9932A",
  coral: "#EF476F",
  teal: "#17C3B2",
  text: "#F4F1E8",
  textDim: "#9AA5C4",
  textFaint: "#5C6588",
  fontDisplay: "'Oswald', 'Arial Narrow', sans-serif",
  fontBody: "'Inter', -apple-system, 'Segoe UI', sans-serif",
};

function StyleBlock() {
  return (
    <style>{`
      @import url('https://fonts.googleapis.com/css2?family=Oswald:wght@500;600;700&family=Inter:wght@400;500;600;700&display=swap');
      * { box-sizing: border-box; }
      ::selection { background: ${TOKENS.gold}; color: #0B1220; }
      input, select { font-family: ${TOKENS.fontBody}; }
      table { border-collapse: collapse; width: 100%; }
      @media print {
        .no-print { display: none !important; }
        .print-page { page-break-after: always; }
        body { background: white !important; }
      }
    `}</style>
  );
}

const styles = {
  loadingScreen: {
    minHeight: "100vh",
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    gap: 12,
    background: TOKENS.bg,
  },
  loadingLogo: { fontSize: 40 },
  appShell: {
    minHeight: "100vh",
    background: TOKENS.bg,
    color: TOKENS.text,
    fontFamily: TOKENS.fontBody,
  },
  body: { display: "flex", alignItems: "flex-start" },
  main: { flex: 1, padding: "24px 28px", minWidth: 0 },
};

/* ---------------------------- Logo ------------------------------------------ */

function Logo({ size = 40 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 100 100" xmlns="http://www.w3.org/2000/svg">
      <defs>
        <linearGradient id="pinGrad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#FDF6E3" />
          <stop offset="100%" stopColor="#E7DCC0" />
        </linearGradient>
      </defs>
      <circle cx="50" cy="50" r="48" fill={TOKENS.panelAlt} stroke={TOKENS.gold} strokeWidth="2" />
      <polygon
        points="50,10 54.5,24 69,24 57.5,33 62,47 50,38 38,47 42.5,33 31,24 45.5,24"
        fill={TOKENS.gold}
      />
      <path
        d="M50 46 C 44 46 40 52 40 60 C 40 68 44 78 50 88 C 56 78 60 68 60 60 C 60 52 56 46 50 46 Z"
        fill="url(#pinGrad)"
        stroke={TOKENS.textFaint}
        strokeWidth="1"
      />
      <ellipse cx="50" cy="58" rx="6" ry="2.4" fill={TOKENS.coral} opacity="0.85" />
      <ellipse cx="50" cy="64" rx="6" ry="2.4" fill={TOKENS.teal} opacity="0.85" />
    </svg>
  );
}

/* ---------------------------- Header / Sidebar ------------------------------ */

function Header({ league, saveState }) {
  return (
    <header
      className="no-print"
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "14px 28px",
        borderBottom: `1px solid ${TOKENS.line}`,
        background: TOKENS.panel,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Logo size={38} />
        <div>
          <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 22, letterSpacing: 0.5, color: TOKENS.text, lineHeight: 1 }}>
            {league.name || "Torneo Estelar"}
          </div>
          <div style={{ fontSize: 12, color: TOKENS.textDim, marginTop: 2 }}>
            Temporada {league.seasonLabel || "actual"} · {league.sessionsCount} semanas · {league.teams.length} equipos
          </div>
        </div>
      </div>
      <div style={{ fontSize: 12, color: saveState === "error" ? TOKENS.coral : TOKENS.textDim, minWidth: 90, textAlign: "right" }}>
        {saveState === "saving" && "Guardando…"}
        {saveState === "saved" && "Guardado ✓"}
        {saveState === "error" && "Error al guardar"}
      </div>
    </header>
  );
}

const NAV_ITEMS = [
  { id: "teams", label: "Equipos" },
  { id: "schedule", label: "Calendario" },
  { id: "entry", label: "Captura semanal" },
  { id: "standings", label: "Posiciones" },
  { id: "records", label: "Récords" },
  { id: "data", label: "Datos" },
];

function Sidebar({ tab, setTab, league }) {
  return (
    <nav
      className="no-print"
      style={{
        width: 200,
        flexShrink: 0,
        borderRight: `1px solid ${TOKENS.line}`,
        minHeight: "calc(100vh - 70px)",
        padding: "18px 10px",
        background: TOKENS.panelAlt,
      }}
    >
      {NAV_ITEMS.map((item) => (
        <button
          key={item.id}
          onClick={() => setTab(item.id)}
          style={{
            display: "block",
            width: "100%",
            textAlign: "left",
            padding: "10px 14px",
            marginBottom: 4,
            borderRadius: 4,
            border: "none",
            cursor: "pointer",
            fontFamily: TOKENS.fontDisplay,
            fontSize: 14,
            letterSpacing: 0.3,
            background: tab === item.id ? TOKENS.gold : "transparent",
            color: tab === item.id ? "#0B1220" : TOKENS.textDim,
          }}
        >
          {item.label}
        </button>
      ))}
      {league.ended && (
        <div style={{ marginTop: 16, padding: "8px 10px", fontSize: 11, color: TOKENS.coral, border: `1px solid ${TOKENS.coral}`, borderRadius: 4 }}>
          Temporada finalizada
        </div>
      )}
    </nav>
  );
}

/* ---------------------------- shared small components ------------------------ */

function Panel({ title, subtitle, children, right }) {
  return (
    <section style={{ background: TOKENS.panel, border: `1px solid ${TOKENS.line}`, borderRadius: 6, padding: 20, marginBottom: 20 }}>
      {(title || right) && (
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: subtitle ? 2 : 14 }}>
          {title && <h2 style={{ fontFamily: TOKENS.fontDisplay, fontSize: 18, margin: 0, color: TOKENS.text }}>{title}</h2>}
          {right}
        </div>
      )}
      {subtitle && <div style={{ fontSize: 12.5, color: TOKENS.textDim, marginBottom: 14 }}>{subtitle}</div>}
      {children}
    </section>
  );
}

function Btn({ children, onClick, variant = "primary", small, disabled, type = "button" }) {
  const palette = {
    primary: { bg: TOKENS.gold, color: "#0B1220" },
    ghost: { bg: "transparent", color: TOKENS.text, border: `1px solid ${TOKENS.line}` },
    danger: { bg: "transparent", color: TOKENS.coral, border: `1px solid ${TOKENS.coral}` },
    teal: { bg: TOKENS.teal, color: "#0B1220" },
  }[variant];
  return (
    <button
      type={type}
      disabled={disabled}
      onClick={onClick}
      style={{
        background: palette.bg,
        color: palette.color,
        border: palette.border || "none",
        borderRadius: 4,
        padding: small ? "6px 10px" : "9px 16px",
        fontFamily: TOKENS.fontDisplay,
        fontSize: small ? 12 : 13.5,
        letterSpacing: 0.3,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
      }}
    >
      {children}
    </button>
  );
}

function Field({ label, children }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 12.5, color: TOKENS.textDim, marginBottom: 10 }}>
      {label}
      {children}
    </label>
  );
}

const inputStyle = {
  background: TOKENS.panelAlt,
  border: `1px solid ${TOKENS.line}`,
  borderRadius: 4,
  padding: "8px 10px",
  color: TOKENS.text,
  fontSize: 13.5,
};

/* ============================================================================
   SETUP WIZARD
   ============================================================================ */

function SetupWizard({ existing, onComplete }) {
  const [step, setStep] = useState(1);
  const [name, setName] = useState(existing?.name || "Torneo Estelar");
  const [seasonLabel, setSeasonLabel] = useState(existing?.seasonLabel || "");
  const [numTeams, setNumTeams] = useState(existing?.teams?.length || 8);
  const [teamLineupGames, setTeamLineupGames] = useState(existing?.teamLineupGames ? existing.teamLineupGames / 3 : 4);
  const [sessionsCount, setSessionsCount] = useState(existing?.sessionsCount || 16);
  const [teams, setTeams] = useState(existing?.teams || []);
  const [positionsRounds, setPositionsRounds] = useState(existing?.positionsRounds || []);

  useEffect(() => {
    if (step === 2 && teams.length !== numTeams) {
      const next = [];
      for (let i = 0; i < numTeams; i++) {
        next.push(
          teams[i] || {
            id: uid("team"),
            name: `Equipo ${i + 1}`,
            group: i % 2 === 0 ? "Oro" : "Plata",
            bowlers: [],
          }
        );
      }
      setTeams(next);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step]);

  function updateTeam(id, patch) {
    setTeams((ts) => ts.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }

  function addBowler(teamId) {
    setTeams((ts) =>
      ts.map((t) =>
        t.id === teamId && t.bowlers.length < 8
          ? {
              ...t,
              bowlers: [
                ...t.bowlers,
                { id: uid("bwl"), name: "", category: "Oro", isWoman: false, enteringAverage: "" },
              ],
            }
          : t
      )
    );
  }
  function updateBowler(teamId, bowlerId, patch) {
    setTeams((ts) =>
      ts.map((t) =>
        t.id === teamId
          ? { ...t, bowlers: t.bowlers.map((b) => (b.id === bowlerId ? { ...b, ...patch } : b)) }
          : t
      )
    );
  }
  function removeBowler(teamId, bowlerId) {
    setTeams((ts) =>
      ts.map((t) => (t.id === teamId ? { ...t, bowlers: t.bowlers.filter((b) => b.id !== bowlerId) } : t))
    );
  }

  function addPositionsRound() {
    setPositionsRounds((p) => [...p, { week: Math.min(sessionsCount, 4), type: "within" }]);
  }
  function updatePositionsRound(i, patch) {
    setPositionsRounds((p) => p.map((r, idx) => (idx === i ? { ...r, ...patch } : r)));
  }
  function removePositionsRound(i) {
    setPositionsRounds((p) => p.filter((_, idx) => idx !== i));
  }

  async function finish() {
    const flatBowlers = [];
    const cleanTeams = teams.map((t) => ({
      id: t.id,
      name: t.name,
      group: t.group,
      bowlers: t.bowlers.map((b) => b.id),
    }));
    teams.forEach((t) => {
      t.bowlers.forEach((b) => {
        flatBowlers.push({
          id: b.id,
          teamId: t.id,
          name: b.name || "Sin nombre",
          category: b.category,
          isWoman: !!b.isWoman,
          enteringAverage: b.enteringAverage === "" ? null : Number(b.enteringAverage),
        });
      });
    });
    const league = {
      setupComplete: true,
      name,
      seasonLabel,
      sessionsCount: Number(sessionsCount),
      teamLineupGames: Number(teamLineupGames) * 3,
      teamLineupPerGame: Number(teamLineupGames),
      teams: cleanTeams,
      bowlers: flatBowlers,
      positionsRounds: positionsRounds.map((p) => ({ week: Number(p.week), type: p.type })),
      weeklyResults: {},
      ended: false,
      createdAt: Date.now(),
    };
    await onComplete(league);
  }

  return (
    <div style={{ maxWidth: 780, margin: "0 auto", padding: "40px 20px" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 28 }}>
        <Logo size={44} />
        <div>
          <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 26, color: TOKENS.text }}>Torneo Estelar</div>
          <div style={{ fontSize: 13, color: TOKENS.textDim }}>Configuración de la liga — paso {step} de 4</div>
        </div>
      </div>

      {step === 1 && (
        <Panel title="Datos generales de la liga">
          <Field label="Nombre de la liga">
            <input style={inputStyle} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <Field label="Temporada (etiqueta, opcional)">
            <input style={inputStyle} placeholder="p. ej. Otoño 2026" value={seasonLabel} onChange={(e) => setSeasonLabel(e.target.value)} />
          </Field>
          <Field label="Número de equipos">
            <input type="number" min={2} style={inputStyle} value={numTeams} onChange={(e) => setNumTeams(Math.max(2, Number(e.target.value)))} />
          </Field>
          <Field label="Bowlers en la alineación por semana (por equipo)">
            <input type="number" min={1} max={8} style={inputStyle} value={teamLineupGames} onChange={(e) => setTeamLineupGames(Math.max(1, Math.min(8, Number(e.target.value))))} />
          </Field>
          <Field label="Número de sesiones (semanas) de la temporada">
            <input type="number" min={1} style={inputStyle} value={sessionsCount} onChange={(e) => setSessionsCount(Math.max(1, Number(e.target.value)))} />
          </Field>
          <div style={{ display: "flex", justifyContent: "flex-end" }}>
            <Btn onClick={() => setStep(2)}>Siguiente: Equipos →</Btn>
          </div>
        </Panel>
      )}

      {step === 2 && (
        <Panel title="Equipos y jugadores" subtitle="Hasta 8 bowlers por equipo. Cada equipo pertenece al grupo Oro o Plata.">
          {teams.map((t) => (
            <div key={t.id} style={{ border: `1px solid ${TOKENS.line}`, borderRadius: 6, padding: 14, marginBottom: 14 }}>
              <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
                <input style={{ ...inputStyle, flex: 1, fontFamily: TOKENS.fontDisplay }} value={t.name} onChange={(e) => updateTeam(t.id, { name: e.target.value })} />
                <select style={inputStyle} value={t.group} onChange={(e) => updateTeam(t.id, { group: e.target.value })}>
                  {GROUPS.map((g) => (
                    <option key={g} value={g}>
                      Grupo {g}
                    </option>
                  ))}
                </select>
              </div>
              {t.bowlers.map((b) => (
                <div key={b.id} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 0.7fr 1fr auto", gap: 8, marginBottom: 6, alignItems: "center" }}>
                  <input style={inputStyle} placeholder="Nombre" value={b.name} onChange={(e) => updateBowler(t.id, b.id, { name: e.target.value })} />
                  <select style={inputStyle} value={b.category} onChange={(e) => updateBowler(t.id, b.id, { category: e.target.value })}>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label style={{ fontSize: 11.5, color: TOKENS.textDim, display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={!!b.isWoman} onChange={(e) => updateBowler(t.id, b.id, { isWoman: e.target.checked })} /> Mujer
                  </label>
                  <input style={inputStyle} type="number" placeholder="Promedio entrada" value={b.enteringAverage} onChange={(e) => updateBowler(t.id, b.id, { enteringAverage: e.target.value })} />
                  <Btn variant="danger" small onClick={() => removeBowler(t.id, b.id)}>
                    ✕
                  </Btn>
                </div>
              ))}
              {t.bowlers.length < 8 && (
                <Btn variant="ghost" small onClick={() => addBowler(t.id)}>
                  + Agregar bowler
                </Btn>
              )}
            </div>
          ))}
          <div style={{ display: "flex", justifyContent: "space-between" }}>
            <Btn variant="ghost" onClick={() => setStep(1)}>
              ← Atrás
            </Btn>
            <Btn onClick={() => setStep(3)}>Siguiente: Rondas de posiciones →</Btn>
          </div>
        </Panel>
      )}

      {step === 3 && (
        <Panel
          title="Rondas de posiciones"
          subtitle="Define en qué semana(s) se juega una ronda de posiciones en vez de la rotación normal, y si empareja dentro del mismo grupo (1° vs 2°, 3° vs 4°…) o entre grupos (Oro 1° vs Plata 1°…)."
        >
          {positionsRounds.map((r, i) => (
            <div key={i} style={{ display: "flex", gap: 10, marginBottom: 8, alignItems: "center" }}>
              <span style={{ fontSize: 12.5, color: TOKENS.textDim }}>Semana</span>
              <input
                type="number"
                min={1}
                max={sessionsCount}
                style={{ ...inputStyle, width: 80 }}
                value={r.week}
                onChange={(e) => updatePositionsRound(i, { week: e.target.value })}
              />
              <select style={inputStyle} value={r.type} onChange={(e) => updatePositionsRound(i, { type: e.target.value })}>
                <option value="within">Dentro del grupo</option>
                <option value="between">Entre grupos</option>
              </select>
              <Btn variant="danger" small onClick={() => removePositionsRound(i)}>
                ✕
              </Btn>
            </div>
          ))}
          <Btn variant="ghost" small onClick={addPositionsRound}>
            + Agregar ronda de posiciones
          </Btn>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 16 }}>
            <Btn variant="ghost" onClick={() => setStep(2)}>
              ← Atrás
            </Btn>
            <Btn onClick={() => setStep(4)}>Siguiente: Confirmar →</Btn>
          </div>
        </Panel>
      )}

      {step === 4 && (
        <Panel title="Confirmar y crear la liga">
          <ul style={{ fontSize: 13.5, color: TOKENS.textDim, lineHeight: 1.9 }}>
            <li>
              <b style={{ color: TOKENS.text }}>{name}</b> {seasonLabel && `· ${seasonLabel}`}
            </li>
            <li>{teams.length} equipos, {teams.reduce((a, t) => a + t.bowlers.length, 0)} bowlers registrados</li>
            <li>{sessionsCount} semanas · {teamLineupGames} bowlers en alineación semanal</li>
            <li>{positionsRounds.length} ronda(s) de posiciones configurada(s)</li>
          </ul>
          <div style={{ display: "flex", justifyContent: "space-between", marginTop: 10 }}>
            <Btn variant="ghost" onClick={() => setStep(3)}>
              ← Atrás
            </Btn>
            <Btn onClick={finish}>Crear liga 🎳</Btn>
          </div>
        </Panel>
      )}
    </div>
  );
}

/* ============================================================================
   TEAMS VIEW  (roster management after creation)
   ============================================================================ */

function TeamsView({ league, onChange }) {
  function updateBowler(bowlerId, patch) {
    const bowlers = league.bowlers.map((b) => (b.id === bowlerId ? { ...b, ...patch } : b));
    onChange({ ...league, bowlers });
  }
  function addBowler(teamId) {
    const team = league.teams.find((t) => t.id === teamId);
    if (team.bowlers.length >= 8) return;
    const newB = { id: uid("bwl"), teamId, name: "Nuevo bowler", category: "Oro", isWoman: false, enteringAverage: null };
    const teams = league.teams.map((t) => (t.id === teamId ? { ...t, bowlers: [...t.bowlers, newB.id] } : t));
    onChange({ ...league, teams, bowlers: [...league.bowlers, newB] });
  }
  function removeBowler(teamId, bowlerId) {
    const teams = league.teams.map((t) => (t.id === teamId ? { ...t, bowlers: t.bowlers.filter((id) => id !== bowlerId) } : t));
    onChange({ ...league, teams, bowlers: league.bowlers.filter((b) => b.id !== bowlerId) });
  }
  function updateTeam(teamId, patch) {
    onChange({ ...league, teams: league.teams.map((t) => (t.id === teamId ? { ...t, ...patch } : t)) });
  }

  return (
    <div>
      <Panel title="Equipos y rosters" subtitle="Edita nombres, categorías, sexo y promedio de entrada. Los cambios afectan el cálculo de hándicap.">
        {league.teams.map((t) => (
          <div key={t.id} style={{ border: `1px solid ${TOKENS.line}`, borderRadius: 6, padding: 14, marginBottom: 14 }}>
            <div style={{ display: "flex", gap: 10, alignItems: "center", marginBottom: 10 }}>
              <input style={{ ...inputStyle, flex: 1, fontFamily: TOKENS.fontDisplay }} value={t.name} onChange={(e) => updateTeam(t.id, { name: e.target.value })} />
              <select style={inputStyle} value={t.group} onChange={(e) => updateTeam(t.id, { group: e.target.value })}>
                {GROUPS.map((g) => (
                  <option key={g} value={g}>
                    Grupo {g}
                  </option>
                ))}
              </select>
            </div>
            {t.bowlers.map((bid) => {
              const b = league.bowlers.find((x) => x.id === bid);
              if (!b) return null;
              const stats = bowlerCareerStats(b, league);
              return (
                <div key={bid} style={{ display: "grid", gridTemplateColumns: "1.6fr 1fr 0.7fr 1fr 1fr auto", gap: 8, marginBottom: 6, alignItems: "center" }}>
                  <input style={inputStyle} value={b.name} onChange={(e) => updateBowler(bid, { name: e.target.value })} />
                  <select style={inputStyle} value={b.category} onChange={(e) => updateBowler(bid, { category: e.target.value })}>
                    {CATEGORIES.map((c) => (
                      <option key={c} value={c}>
                        {c}
                      </option>
                    ))}
                  </select>
                  <label style={{ fontSize: 11.5, color: TOKENS.textDim, display: "flex", alignItems: "center", gap: 4 }}>
                    <input type="checkbox" checked={!!b.isWoman} onChange={(e) => updateBowler(bid, { isWoman: e.target.checked })} /> Mujer
                  </label>
                  <input
                    style={inputStyle}
                    type="number"
                    placeholder="Prom. entrada"
                    value={b.enteringAverage ?? ""}
                    onChange={(e) => updateBowler(bid, { enteringAverage: e.target.value === "" ? null : Number(e.target.value) })}
                  />
                  <div style={{ fontSize: 11.5, color: TOKENS.textFaint }}>
                    {stats.gamesPlayed} jgs · prom {stats.average ? stats.average.toFixed(1) : "—"}
                  </div>
                  <Btn variant="danger" small onClick={() => removeBowler(t.id, bid)}>
                    ✕
                  </Btn>
                </div>
              );
            })}
            {t.bowlers.length < 8 && (
              <Btn variant="ghost" small onClick={() => addBowler(t.id)}>
                + Agregar bowler
              </Btn>
            )}
          </div>
        ))}
      </Panel>
    </div>
  );
}

/* ============================================================================
   SCHEDULE VIEW
   ============================================================================ */

function ScheduleView({ league }) {
  const plan = useMemo(() => buildSeasonPlan(league), [league]);
  const teamsById = Object.fromEntries(league.teams.map((t) => [t.id, t]));

  return (
    <Panel
      title="Calendario de la temporada"
      subtitle="Round robin generado automáticamente con rotación de lado de carril por semana. Las semanas de ronda de posiciones se emparejan al momento, según las posiciones vigentes."
    >
      <table>
        <thead>
          <tr>
            {["Semana", "Tipo", "Enfrentamientos", "Carriles"].map((h) => (
              <th key={h} style={thStyle}>
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {plan.map((wk) => {
            if (wk.type === "positions") {
              return (
                <tr key={wk.week} style={{ borderBottom: `1px solid ${TOKENS.line}` }}>
                  <td style={tdStyle}>{wk.week}</td>
                  <td style={{ ...tdStyle, color: TOKENS.gold }}>Ronda de posiciones ({wk.positionsType === "within" ? "dentro de grupo" : "entre grupos"})</td>
                  <td style={tdStyle} colSpan={2}>
                    Se genera en Captura semanal según la tabla vigente
                  </td>
                </tr>
              );
            }
            const withLanes = assignLanes(wk.pairs);
            return (
              <tr key={wk.week} style={{ borderBottom: `1px solid ${TOKENS.line}` }}>
                <td style={tdStyle}>{wk.week}</td>
                <td style={tdStyle}>Regular</td>
                <td style={tdStyle}>
                  {withLanes.map(({ pair }, i) => (
                    <div key={i}>
                      {teamsById[pair[0]]?.name} vs {teamsById[pair[1]]?.name}
                    </div>
                  ))}
                  {withLanes.length === 0 && <span style={{ color: TOKENS.textFaint }}>—</span>}
                </td>
                <td style={tdStyle}>
                  {withLanes.map(({ lanes }, i) => (
                    <div key={i}>
                      {lanes[0]}-{lanes[1]}
                    </div>
                  ))}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </Panel>
  );
}

const thStyle = { textAlign: "left", fontSize: 11, textTransform: "none", letterSpacing: 0.4, color: TOKENS.textDim, padding: "6px 10px", borderBottom: `1px solid ${TOKENS.line}`, fontFamily: TOKENS.fontDisplay };
const tdStyle = { padding: "8px 10px", fontSize: 13, color: TOKENS.text, verticalAlign: "top" };

/* ============================================================================
   WEEK ENTRY VIEW
   ============================================================================ */

function WeekEntryView({ league, onChange }) {
  const plan = useMemo(() => buildSeasonPlan(league), [league]);
  const [week, setWeek] = useState(() => {
    const firstUnsaved = plan.find((w) => !league.weeklyResults[w.week]?.matches?.every((m) => m.saved));
    return firstUnsaved ? firstUnsaved.week : 1;
  });
  const weekPlan = plan.find((w) => w.week === week);
  const existingWeek = league.weeklyResults[week];

  const teamsById = Object.fromEntries(league.teams.map((t) => [t.id, t]));
  const bowlersById = Object.fromEntries(league.bowlers.map((b) => [b.id, b]));

  function currentGroupStandings() {
    return computeTeamStandings(league);
  }

  function generatePositionsPairs() {
    const standings = currentGroupStandings();
    let pairs = [];
    if (weekPlan.positionsType === "within") {
      GROUPS.forEach((g) => {
        const ranked = standings[g].map((r) => r.teamId);
        for (let i = 0; i < ranked.length; i += 2) {
          if (ranked[i + 1]) pairs.push([ranked[i], ranked[i + 1]]);
        }
      });
    } else {
      const oro = standings.Oro.map((r) => r.teamId);
      const plata = standings.Plata.map((r) => r.teamId);
      const len = Math.max(oro.length, plata.length);
      for (let i = 0; i < len; i++) {
        if (oro[i] && plata[i]) pairs.push([oro[i], plata[i]]);
      }
    }
    return pairs;
  }

  function ensureWeekInit() {
    if (existingWeek) return existingWeek;
    const pairs = weekPlan.type === "positions" ? generatePositionsPairs() : weekPlan.pairs;
    const withLanes = assignLanes(pairs);
    const matches = withLanes.map(({ pair, lanes }) => {
      const [teamA, teamB] = pair;
      const teamAObj = teamsById[teamA];
      const teamBObj = teamsById[teamB];
      const lineup = {};
      const bowlerTeam = {};
      [...teamAObj.bowlers, ...teamBObj.bowlers].forEach((bid) => {
        lineup[bid] = ["", "", ""];
        bowlerTeam[bid] = teamAObj.bowlers.includes(bid) ? teamA : teamB;
      });
      const handicapUsed = {};
      [...teamAObj.bowlers, ...teamBObj.bowlers].forEach((bid) => {
        const b = bowlersById[bid];
        handicapUsed[bid] = b ? bowlerHandicapForWeek(b, league, week) : 0;
      });
      return {
        id: uid("match"),
        teamA,
        teamB,
        lanes,
        lineup,
        bowlerTeam,
        handicapUsed,
        prontoPago: { A: false, B: false },
        uniforme: { A: false, B: false },
        saved: false,
      };
    });
    return { week, matches };
  }

  const [draft, setDraft] = useState(() => ensureWeekInit());

  useEffect(() => {
    setDraft(ensureWeekInit());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [week, league]);

  function updateMatch(matchId, patch) {
    setDraft((d) => ({ ...d, matches: d.matches.map((m) => (m.id === matchId ? { ...m, ...patch } : m)) }));
  }
  function updateScore(matchId, bowlerId, gameIdx, value) {
    setDraft((d) => ({
      ...d,
      matches: d.matches.map((m) => {
        if (m.id !== matchId) return m;
        const line = [...(m.lineup[bowlerId] || ["", "", ""])];
        line[gameIdx] = value;
        return { ...m, lineup: { ...m.lineup, [bowlerId]: line } };
      }),
    }));
  }

  function saveWeek() {
    const savedMatches = draft.matches.map((m) => ({ ...m, saved: true }));
    const weeklyResults = { ...league.weeklyResults, [week]: { week, matches: savedMatches } };
    onChange({ ...league, weeklyResults });
  }

  if (!weekPlan) return <Panel title="Captura semanal">No hay semanas configuradas.</Panel>;

  return (
    <div>
      <Panel
        title={`Captura semanal — Semana ${week}`}
        subtitle={
          weekPlan.type === "positions"
            ? `Ronda de posiciones (${weekPlan.positionsType === "within" ? "dentro de grupo" : "entre grupos"}), generada según la tabla vigente antes de esta semana.`
            : "Introduce el marcador de cada bowler. Escribe B o b para marcar un blind (190, sin hándicap)."
        }
        right={
          <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
            <select style={inputStyle} value={week} onChange={(e) => setWeek(Number(e.target.value))}>
              {plan.map((w) => (
                <option key={w.week} value={w.week}>
                  Semana {w.week} {league.weeklyResults[w.week]?.matches?.every((m) => m.saved) ? "✓" : ""}
                </option>
              ))}
            </select>
          </div>
        }
      >
        {draft.matches.length === 0 && <div style={{ color: TOKENS.textFaint }}>No hay enfrentamientos esta semana.</div>}
        {draft.matches.map((m) => (
          <MatchEntry key={m.id} match={m} league={league} teamsById={teamsById} bowlersById={bowlersById} onUpdateMatch={(patch) => updateMatch(m.id, patch)} onUpdateScore={(bid, gi, v) => updateScore(m.id, bid, gi, v)} />
        ))}
        <div style={{ display: "flex", justifyContent: "flex-end", marginTop: 10 }}>
          <Btn onClick={saveWeek}>Guardar semana {week}</Btn>
        </div>
      </Panel>
    </div>
  );
}

function MatchEntry({ match, league, teamsById, bowlersById, onUpdateMatch, onUpdateScore }) {
  const teamA = teamsById[match.teamA];
  const teamB = teamsById[match.teamB];
  const live = { ...match };
  const totalsA = teamGameTotals(live, "A");
  const totalsB = teamGameTotals(live, "B");
  const { points } = computeMatchPoints(live);

  return (
    <div style={{ border: `1px solid ${TOKENS.line}`, borderRadius: 6, padding: 14, marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
        <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 15, color: TOKENS.text }}>
          {teamA.name} <span style={{ color: TOKENS.textFaint }}>vs</span> {teamB.name}
        </div>
        <div style={{ fontSize: 11.5, color: TOKENS.textDim }}>Carriles {match.lanes[0]}-{match.lanes[1]}</div>
      </div>

      {[teamA, teamB].map((team, sideIdx) => {
        const side = sideIdx === 0 ? "A" : "B";
        return (
          <div key={team.id} style={{ marginBottom: 8 }}>
            <div style={{ fontSize: 12, color: TOKENS.goldSoft, fontFamily: TOKENS.fontDisplay, marginBottom: 4 }}>{team.name}</div>
            <table>
              <thead>
                <tr>
                  <th style={thStyle}>Bowler</th>
                  <th style={thStyle}>Hcp</th>
                  <th style={thStyle}>J1</th>
                  <th style={thStyle}>J2</th>
                  <th style={thStyle}>J3</th>
                </tr>
              </thead>
              <tbody>
                {team.bowlers.map((bid) => {
                  const b = bowlersById[bid];
                  if (!b) return null;
                  const line = match.lineup[bid] || ["", "", ""];
                  return (
                    <tr key={bid}>
                      <td style={tdStyle}>{b.name}</td>
                      <td style={{ ...tdStyle, color: TOKENS.textDim }}>{match.handicapUsed[bid] ?? 0}</td>
                      {[0, 1, 2].map((gi) => (
                        <td key={gi} style={tdStyle}>
                          <input
                            style={{ ...inputStyle, width: 56 }}
                            value={line[gi]}
                            placeholder="—"
                            onChange={(e) => onUpdateScore(bid, gi, e.target.value)}
                          />
                        </td>
                      ))}
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        );
      })}

      <div style={{ display: "flex", gap: 20, alignItems: "center", marginTop: 8, fontSize: 12.5, flexWrap: "wrap" }}>
        <div style={{ color: TOKENS.textDim }}>
          Juegos c/hcp: <b style={{ color: TOKENS.text }}>{totalsA.gameTotals.join(" / ")}</b> vs <b style={{ color: TOKENS.text }}>{totalsB.gameTotals.join(" / ")}</b>
        </div>
        <div style={{ color: TOKENS.textDim }}>
          Serie c/hcp: <b style={{ color: TOKENS.text }}>{totalsA.seriesTotal}</b> vs <b style={{ color: TOKENS.text }}>{totalsB.seriesTotal}</b>
        </div>
        <div style={{ color: TOKENS.gold }}>
          Puntos: {points.A} — {points.B}
        </div>
      </div>

      <div style={{ display: "flex", gap: 24, marginTop: 8 }}>
        {["A", "B"].map((side) => (
          <div key={side} style={{ display: "flex", gap: 12, fontSize: 12, color: TOKENS.textDim }}>
            <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={!!match.prontoPago[side]}
                onChange={(e) => onUpdateMatch({ prontoPago: { ...match.prontoPago, [side]: e.target.checked } })}
              />
              Pronto pago {side === "A" ? teamA.name : teamB.name}
            </label>
            <label style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                type="checkbox"
                checked={!!match.uniforme[side]}
                onChange={(e) => onUpdateMatch({ uniforme: { ...match.uniforme, [side]: e.target.checked } })}
              />
              Uniforme {side === "A" ? teamA.name : teamB.name}
            </label>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ============================================================================
   STANDINGS VIEW  (screen + printable 2-page layout)
   ============================================================================ */

function currentWeekNumber(league) {
  const weeks = Object.keys(league.weeklyResults).map(Number);
  if (weeks.length === 0) return 0;
  return Math.max(...weeks);
}

function StandingsView({ league }) {
  const teamStandings = useMemo(() => computeTeamStandings(league), [league]);
  const cw = currentWeekNumber(league);
  const indiv = useMemo(() => computeIndividualStandings(league, cw), [league, cw]);
  const records = useMemo(() => computeLeagueRecords(league), [league]);
  const bowlersById = Object.fromEntries(league.bowlers.map((b) => [b.id, b]));
  const teamsById = Object.fromEntries(league.teams.map((t) => [t.id, t]));

  function printStandings() {
    window.print();
  }

  return (
    <div>
      <div className="no-print" style={{ display: "flex", justifyContent: "flex-end", marginBottom: 12 }}>
        <Btn onClick={printStandings}>Imprimir / exportar PDF</Btn>
      </div>

      <div className="print-page">
        <Panel title="Récords de la liga" subtitle="Actualizado a la fecha con hándicap incluido salvo donde se indique.">
          <div style={{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 12, marginBottom: 14 }}>
            <RecordCard label="High Game equipo (c/hcp)" value={records.highTeamGame} render={(r) => `${r.value} — ${r.name} (sem. ${r.week})`} />
            <RecordCard label="High Series equipo (c/hcp)" value={records.highTeamSeries} render={(r) => `${r.value} — ${r.name} (sem. ${r.week})`} />
            <RecordCard label="High Game individual (c/hcp)" value={records.highIndGame} render={(r) => `${r.value} — ${r.name} (sem. ${r.week})`} />
            <RecordCard label="High Series individual (c/hcp)" value={records.highIndSeries} render={(r) => `${r.value} — ${r.name} (sem. ${r.week})`} />
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            <div>
              <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 13, color: TOKENS.gold, marginBottom: 6 }}>Juegos de 300 (scratch)</div>
              {records.scratch300.length === 0 && <div style={{ color: TOKENS.textFaint, fontSize: 12.5 }}>Ninguno todavía</div>}
              {records.scratch300.map((r, i) => (
                <div key={i} style={{ fontSize: 12.5, color: TOKENS.text }}>
                  {r.name} — semana {r.week}
                </div>
              ))}
            </div>
            <div>
              <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 13, color: TOKENS.gold, marginBottom: 6 }}>Series 800+ (scratch)</div>
              {records.scratch800.length === 0 && <div style={{ color: TOKENS.textFaint, fontSize: 12.5 }}>Ninguna todavía</div>}
              {records.scratch800.map((r, i) => (
                <div key={i} style={{ fontSize: 12.5, color: TOKENS.text }}>
                  {r.name} — {r.series} (semana {r.week})
                </div>
              ))}
            </div>
          </div>
        </Panel>

        <Panel title="Posiciones de equipos">
          {GROUPS.map((g) => (
            <div key={g} style={{ marginBottom: 16 }}>
              <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 14, color: TOKENS.coral, marginBottom: 6 }}>Grupo {g}</div>
              <table>
                <thead>
                  <tr>
                    {["#", "Equipo", "Puntos", "Pts. posibles", "Pinos c/hcp", "High game c/hcp"].map((h) => (
                      <th key={h} style={thStyle}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {teamStandings[g].map((row, i) => (
                    <tr key={row.teamId} style={{ borderBottom: `1px solid ${TOKENS.line}` }}>
                      <td style={tdStyle}>{i + 1}</td>
                      <td style={tdStyle}>{row.name}</td>
                      <td style={{ ...tdStyle, color: TOKENS.gold }}>{row.points}</td>
                      <td style={tdStyle}>{row.possiblePoints}</td>
                      <td style={tdStyle}>{row.pinfall}</td>
                      <td style={tdStyle}>{row.highGame}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ))}
        </Panel>
      </div>

      <div>
        <Panel title="Posiciones individuales" subtitle="Por categoría. Bowlers que ya no pueden matemáticamente completar el 80% de juegos posibles aparecen atenuados, debajo de quienes sí califican.">
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20 }}>
            {CATEGORIES.map((c) => (
              <div key={c}>
                <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 14, color: TOKENS.teal, marginBottom: 6 }}>{c}</div>
                <table>
                  <thead>
                    <tr>
                      {["#", "Bowler", "Equipo", "Juegos", "Prom."].map((h) => (
                        <th key={h} style={thStyle}>
                          {h}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {indiv.byCategory[c].map((row, i) => (
                      <tr key={row.bowlerId} style={{ borderBottom: `1px solid ${TOKENS.line}`, opacity: row.qualifies ? 1 : 0.4 }}>
                        <td style={tdStyle}>{i + 1}</td>
                        <td style={tdStyle}>{row.name}</td>
                        <td style={{ ...tdStyle, fontSize: 11.5, color: TOKENS.textDim }}>{teamsById[row.teamId]?.name}</td>
                        <td style={tdStyle}>{row.gamesPlayed}</td>
                        <td style={tdStyle}>{row.average ? row.average.toFixed(1) : "—"}</td>
                      </tr>
                    ))}
                    {indiv.byCategory[c].length === 0 && (
                      <tr>
                        <td style={tdStyle} colSpan={5}>
                          <span style={{ color: TOKENS.textFaint }}>Sin bowlers</span>
                        </td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            ))}
          </div>
          <div style={{ fontSize: 11, color: TOKENS.textFaint, marginTop: 10 }}>
            Requisito: {indiv.requiredGames} de {indiv.totalPossible} juegos posibles (80%).
          </div>
        </Panel>
      </div>
    </div>
  );
}

function RecordCard({ label, value, render }) {
  return (
    <div style={{ border: `1px solid ${TOKENS.line}`, borderRadius: 6, padding: 12 }}>
      <div style={{ fontSize: 11, color: TOKENS.textDim, marginBottom: 4 }}>{label}</div>
      <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 15, color: TOKENS.gold }}>{value ? render(value) : "—"}</div>
    </div>
  );
}

/* ============================================================================
   RECORDS VIEW  (detailed, non-print version — reuses same computation)
   ============================================================================ */

function RecordsView({ league }) {
  const records = useMemo(() => computeLeagueRecords(league), [league]);
  return (
    <Panel title="Récords de la liga" subtitle="Vista detallada de marcas individuales y de equipo.">
      <div style={{ display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 }}>
        <RecordCard label="High Game equipo (c/hcp)" value={records.highTeamGame} render={(r) => `${r.value} — ${r.name} (sem. ${r.week})`} />
        <RecordCard label="High Series equipo (c/hcp)" value={records.highTeamSeries} render={(r) => `${r.value} — ${r.name} (sem. ${r.week})`} />
        <RecordCard label="High Game individual (c/hcp)" value={records.highIndGame} render={(r) => `${r.value} — ${r.name} (sem. ${r.week})`} />
        <RecordCard label="High Series individual (c/hcp)" value={records.highIndSeries} render={(r) => `${r.value} — ${r.name} (sem. ${r.week})`} />
      </div>
      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 20, marginTop: 20 }}>
        <div>
          <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 14, color: TOKENS.gold, marginBottom: 8 }}>Juegos de 300 (honor, scratch)</div>
          {records.scratch300.length === 0 && <div style={{ color: TOKENS.textFaint, fontSize: 13 }}>Ninguno todavía</div>}
          {records.scratch300.map((r, i) => (
            <div key={i} style={{ fontSize: 13, padding: "4px 0", borderBottom: `1px solid ${TOKENS.line}` }}>
              {r.name} — semana {r.week}
            </div>
          ))}
        </div>
        <div>
          <div style={{ fontFamily: TOKENS.fontDisplay, fontSize: 14, color: TOKENS.gold, marginBottom: 8 }}>Series 800+ (honor, scratch)</div>
          {records.scratch800.length === 0 && <div style={{ color: TOKENS.textFaint, fontSize: 13 }}>Ninguna todavía</div>}
          {records.scratch800.map((r, i) => (
            <div key={i} style={{ fontSize: 13, padding: "4px 0", borderBottom: `1px solid ${TOKENS.line}` }}>
              {r.name} — {r.series} (semana {r.week})
            </div>
          ))}
        </div>
      </div>
    </Panel>
  );
}

/* ============================================================================
   DATA VIEW  (import / export / end season)
   ============================================================================ */

function DataView({ league, onChange }) {
  const [importError, setImportError] = useState("");
  const cw = currentWeekNumber(league);

  function exportFile() {
    const blob = new Blob([JSON.stringify(league, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const safeName = (league.name || "torneo").toLowerCase().replace(/[^a-z0-9]+/g, "-");
    a.download = `${safeName}-respaldo-semana-${cw}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }

  function importFile(e) {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      try {
        const parsed = JSON.parse(reader.result);
        if (!parsed.teams || !parsed.bowlers) throw new Error("Archivo inválido");
        setImportError("");
        onChange(parsed);
      } catch (err) {
        setImportError("No se pudo leer el archivo. Verifica que sea un respaldo válido de Torneo Estelar.");
      }
    };
    reader.readAsText(file);
    e.target.value = "";
  }

  function endTournament() {
    const nextBowlers = league.bowlers.map((b) => {
      const stats = bowlerCareerStats(b, league);
      if (stats.gamesPlayed >= 12) {
        return { ...b, enteringAverage: Math.floor(stats.average), frozenFromSeason: league.seasonLabel || true };
      }
      return { ...b, enteringAverage: null };
    });
    onChange({ ...league, bowlers: nextBowlers, ended: true });
  }

  function startNewSeasonFromEnded() {
    onChange({ ...league, weeklyResults: {}, ended: false, setupComplete: true, seasonLabel: "" });
  }

  return (
    <div>
      <Panel title="Respaldo del torneo" subtitle="Exporta un archivo de respaldo cada semana. Si se pierde la información, impórtalo para restaurar todo.">
        <div style={{ display: "flex", gap: 12 }}>
          <Btn onClick={exportFile}>Exportar archivo del torneo</Btn>
          <label style={{ display: "inline-block" }}>
            <input type="file" accept="application/json" onChange={importFile} style={{ display: "none" }} id="import-input" />
            <Btn variant="ghost" onClick={() => document.getElementById("import-input").click()}>
              Importar archivo del torneo
            </Btn>
          </label>
        </div>
        {importError && <div style={{ color: TOKENS.coral, fontSize: 12.5, marginTop: 8 }}>{importError}</div>}
      </Panel>

      <Panel
        title="Finalizar temporada"
        subtitle="Al finalizar: bowlers con 12+ juegos congelan su promedio como nuevo promedio de entrada (fijo 9 juegos la próxima temporada). Bowlers con menos de 12 juegos se tratan como nueva entrada."
      >
        {!league.ended ? (
          <Btn variant="danger" onClick={endTournament}>
            Finalizar temporada
          </Btn>
        ) : (
          <div>
            <div style={{ color: TOKENS.teal, fontSize: 13, marginBottom: 10 }}>Esta temporada ha finalizado. Los promedios de entrada ya se actualizaron.</div>
            <Btn onClick={startNewSeasonFromEnded}>Iniciar nueva temporada con este roster</Btn>
          </div>
        )}
      </Panel>
    </div>
  );
}
