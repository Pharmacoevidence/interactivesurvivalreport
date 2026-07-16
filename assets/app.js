/* ==========================================================================
   EmpowHER-303 · Survival Extrapolation demonstrator
   Pharmacoevidence (PCE)

   Vanilla ES module. No build step. Charts via Chart.js v4 (loaded in index.html).
   All data is SIMULATED — see README and data.json.

   Sections:
     1. CONFIG          — passphrase hash + tunables (change passphrase here)
     2. Gate            — client-side passphrase obfuscation (NOT security)
     3. Math + curves   — parametric survival generation from data.json params
     4. Charts          — the six panels
     5. Render          — recompute every panel for the current selection
     6. Interpretation  — the sentence generator (§6 of the brief)
     7. Wiring          — filters, tabs, modal, persistence, reset
     8. Boot
   ========================================================================== */

/* =========================================================================
   1. CONFIG
   -------------------------------------------------------------------------
   To change the passphrase, replace PASSPHRASE_SHA256 with the SHA-256 hex
   digest of the new passphrase. Compute it with, e.g.:
       printf 'my new passphrase' | shasum -a 256
   The plaintext passphrase is NEVER stored in this file.

   Default demo passphrase: "empowher-2026"
   ========================================================================= */
const CONFIG = {
  // SHA-256 of the passphrase "empowher-2026"
  PASSPHRASE_SHA256: "a24cfad22fe1702a44355e7075811d505c358ea48a0a88fc0a7d3bc077e4e1e5",
  SESSION_KEY: "empowher303_survival_authed",
  STORE_KEY:   "empowher303_survival_selection",
  DATA_URL:    "assets/data.json",
  // Arm display colours (brand tokens)
  COLOR: {
    zani: "#0F7D74",   // teal  — experimental arm (Zanidatamab)
    tras: "#9B2D42",   // red   — control arm (Trastuzumab)
    floor:"#6B7A8A",   // muted — general-population mortality floor
    fan:  "#C7D3DF",   // faint — non-selected distributions
    cut:  "#0B2447",   // navy  — data-cut marker
    blue: "#1B5E92",
    amber:"#8A5A00",
    green:"#2E6B3E",
    navy: "#0B2447",
  },
};

/* =========================================================================
   2. PASSPHRASE GATE  (client-side obfuscation only)
   ========================================================================= */
async function sha256Hex(text) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function revealApp() {
  document.getElementById("gate").classList.add("hidden");
  const app = document.getElementById("app");
  app.classList.remove("hidden");
  app.setAttribute("aria-hidden", "false");
}

function initGate() {
  const input = document.getElementById("gate-input");
  const btn   = document.getElementById("gate-btn");
  const error = document.getElementById("gate-error");

  // Already authenticated this browser session?
  if (sessionStorage.getItem(CONFIG.SESSION_KEY) === "1") {
    revealApp();
    boot();
    return;
  }

  async function attempt() {
    const hex = await sha256Hex(input.value);
    if (hex === CONFIG.PASSPHRASE_SHA256) {
      sessionStorage.setItem(CONFIG.SESSION_KEY, "1");
      error.classList.remove("show");
      revealApp();
      boot();
    } else {
      error.classList.add("show");
      input.select();
    }
  }

  btn.addEventListener("click", attempt);
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") attempt(); });
  input.focus();
}

/* =========================================================================
   3. MATH + CURVE GENERATION
   -------------------------------------------------------------------------
   Curves are computed from the parameters in data.json. The observed region
   (t <= data cut) is shared across distributions (all fits match the KM);
   only the extrapolated tail differs by distribution / waning / fit type —
   this is the core message: many curves fit the data then diverge in the tail.
   ========================================================================= */

// Deterministic PRNG (mulberry32) — reproducible jitter, no Math.random().
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
// Stable integer seed from a string (so each arm/endpoint has its own jitter).
function seedFromString(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return h >>> 0;
}

// Weibull survival S(t) = exp(-(t/scale)^k), scale set from the median.
function weibullScale(median, k) { return median / Math.pow(Math.LN2, 1 / k); }
function weibullS(t, scale, k)   { return Math.exp(-Math.pow(t / scale, k)); }

// General-population mortality floor: slow exponential decline.
function floorS(t, annualHazard) { return Math.exp(-annualHazard * (t / 12)); }

// Restricted mean survival time (area under S(t)) over the horizon, in months.
function rmst(fullPts) {
  let area = 0;
  for (let i = 1; i < fullPts.length; i++) {
    const dx = fullPts[i].x - fullPts[i - 1].x;
    const y0 = fullPts[i - 1].y / 100, y1 = fullPts[i].y / 100;
    area += dx * (y0 + y1) / 2;
  }
  return area;
}

/*
  Build one arm's survival object for the current selection.
  The tail target at 60 months is driven by three levers so every filter
  visibly moves the curve:
    • Distribution — dist.tailFactor / dist.curv (shape of the tail)
    • Waning       — pulls the experimental tail toward the control tail
    • Fit type     — joint (constrained, lower) vs stratified (free, higher)
*/
function buildArm({ endpoint, subgroupKey, distKey, waningKey, fitKey, armKey, DATA }) {
  const ep     = DATA.endpoints[endpoint];
  const sg     = ep.subgroups[subgroupKey];
  const arm    = sg.arms[armKey];
  const dist   = DATA.distributions[distKey];
  const waning = DATA.waning[waningKey];
  const fit    = DATA.fitTypes[fitKey];
  const cut    = ep.cut;
  const H      = DATA.horizonMonths;
  const k      = ep.shape;
  const scale  = weibullScale(arm.median, k);
  const sCut   = weibullS(cut, scale, k);       // survival at the data cut (shared anchor)

  // --- Tail target at 60 months -------------------------------------------
  let tail5 = arm.base5 * dist.tailFactor;

  if (armKey === "Zanidatamab") {
    // Waning: pull the experimental (better) arm's tail toward the control tail.
    if (waning.converge > 0) {
      const controlTail5 = sg.arms.Trastuzumab.base5 * dist.tailFactor;
      tail5 = tail5 + (controlTail5 - tail5) * waning.converge;
    }
    // Fit type: joint fit constrains the experimental tail (proportional to
    // control) → lower; stratified frees it → higher, wider long-term gap.
    tail5 *= fit.expTailMult;
  }
  // Keep the tail strictly positive and above the numerical floor.
  tail5 = Math.max(tail5, 0.004);

  // --- Observed KM (stepped) ----------------------------------------------
  // Sample the Weibull monthly and add tiny censoring-like flat runs + jitter
  // so it reads as a Kaplan-Meier step function rather than a smooth curve.
  const rnd = mulberry32(seedFromString(endpoint + subgroupKey + armKey));
  const kmSteps = [];
  let last = 1;
  for (let t = 0; t <= cut; t += 1) {
    let s = weibullS(t, scale, k);
    s = s + (rnd() - 0.5) * 0.012;            // small event-driven jitter
    s = Math.min(last, Math.max(0, s));       // monotone non-increasing
    if (t > 0 && rnd() < 0.25) s = last;      // occasionally hold flat (censoring)
    last = s;
    kmSteps.push({ x: t, y: +(s * 100).toFixed(2) });
  }

  // --- In-sample fitted curve (smooth), for the Panel F goodness-of-fit view
  const fitted = [];
  for (let t = 0; t <= cut; t += 0.5) {
    fitted.push({ x: +t.toFixed(1), y: +(weibullS(t, scale, k) * 100).toFixed(2) });
  }

  // --- Extrapolated tail cut..60 ------------------------------------------
  // Smooth monotone interpolation from sCut (at cut) to tail5 (at 60), shaped
  // by the distribution's `curv` so the family "fans out" in the mid-tail:
  //   curv < 1  -> drops faster early (convex)    -> lower mid-tail
  //   curv > 1  -> stays high then falls (concave) -> higher mid-tail
  const extrap = [{ x: cut, y: +(sCut * 100).toFixed(2) }];
  const full   = kmSteps.slice();
  for (let t = cut + 0.5; t <= H + 0.001; t += 0.5) {
    const f = (t - cut) / (H - cut);           // 0..1
    const shaped = Math.pow(f, dist.curv);
    const s = sCut * Math.pow(tail5 / sCut, shaped);
    const pt = { x: +t.toFixed(1), y: +(s * 100).toFixed(3) };
    extrap.push(pt);
    full.push(pt);
  }

  // --- Landmark reads (modelled) ------------------------------------------
  const readAt = (months) => {
    let best = full[0], bestD = Infinity;
    for (const p of full) { const d = Math.abs(p.x - months); if (d < bestD) { bestD = d; best = p; } }
    return +(best.y / 100).toFixed(4);
  };
  const landmarks = { 1: readAt(12), 2: readAt(24), 3: readAt(36), 5: readAt(60) };

  return {
    kmSteps, fitted, extrap, full, landmarks, sCut, scale, k,
    median: arm.median, meanRmst: rmst(full),
  };
}

// The "fan" — faint full curves for all non-selected distributions (arm = Zani).
function buildFan(sel, DATA) {
  const fans = [];
  for (const dKey of Object.keys(DATA.distributions)) {
    if (dKey === sel.distKey) continue;
    const a = buildArm({ ...sel, distKey: dKey, armKey: "Zanidatamab", DATA });
    fans.push(a.extrap);
  }
  return fans;
}

// General-population floor series across the horizon.
function buildFloor(DATA) {
  const pts = [];
  for (let t = 0; t <= DATA.horizonMonths; t += 2) {
    pts.push({ x: t, y: +(floorS(t, DATA.genPopFloor.annualHazard) * 100).toFixed(2) });
  }
  return pts;
}

/* --- Diagnostics: log-cumulative hazard (PH check) ------------------------
   LCH(t) = ln(-ln S(t)) plotted against ln(t). Parallel lines => PH holds.
   For PFS (mature, PH ~ held) the lines are near-parallel; for OS/ToT they
   diverge (PH violated). */
function buildLCH(zani, tras, cut, phViolated) {
  const spread = phViolated ? 0.16 : 0.03; // larger slope gap => less parallel
  const toLCH = (arm, divergePerLnT) => {
    const pts = [];
    for (let t = 1; t <= cut; t += 1) {
      const s = weibullS(t, arm.scale, arm.k);
      if (s <= 0 || s >= 1) continue;
      let y = Math.log(-Math.log(s));
      y += divergePerLnT * Math.log(t);
      pts.push({ x: +Math.log(t).toFixed(3), y: +y.toFixed(3) });
    }
    return pts;
  };
  return { zani: toLCH(zani, 0.0), tras: toLCH(tras, spread) };
}

/* --- Diagnostics: Schoenfeld residuals ------------------------------------
   Scaled residuals scattered over time with a fitted trend that crosses zero
   and drifts negative after the fade month (~16m) — signals the treatment
   effect attenuating. Deterministic jitter via seeded PRNG. */
function buildSchoenfeld(endpoint, subgroupKey, cut, fadeMonth) {
  const rnd = mulberry32(seedFromString("schoen" + endpoint + subgroupKey));
  const points = [];
  const trend  = [];
  const n = 60;
  const trendAt = (t) => 0.42 * (1 - t / fadeMonth) - 0.10 * Math.max(0, (t - fadeMonth) / cut);
  for (let i = 0; i < n; i++) {
    const t = 0.5 + (i / (n - 1)) * (cut - 0.5);
    const y = trendAt(t) + (rnd() - 0.5) * 0.7;
    points.push({ x: +t.toFixed(2), y: +y.toFixed(3) });
  }
  for (let t = 0; t <= cut; t += 1) trend.push({ x: t, y: +trendAt(t).toFixed(3) });
  return { points, trend };
}

/* --- Diagnostics: QQ plot for the AFT assumption --------------------------
   Plots the event-time quantiles of one arm against the other. Under an
   accelerated-failure-time (AFT) model the points fall on a straight line
   through the origin with slope = acceleration factor. Here both arms share
   the endpoint shape, so the relationship is near-linear (AFT supported). */
function buildQQ(zani, tras) {
  const rnd = mulberry32(seedFromString("qq" + zani.median + tras.median));
  const inv = (arm, p) => arm.scale * Math.pow(-Math.log(p), 1 / arm.k);
  const pts = [];
  for (let i = 1; i <= 18; i++) {
    const p  = 1 - i / 20;                    // survival probs 0.95 .. 0.10
    const tt = inv(tras, p);
    const tz = inv(zani, p) * (1 + (rnd() - 0.5) * 0.06); // small empirical jitter
    pts.push({ x: +tt.toFixed(2), y: +tz.toFixed(2) });
  }
  const af   = zani.scale / tras.scale;        // acceleration factor (constant)
  const maxT = inv(tras, 0.10);
  const ref  = [{ x: 0, y: 0 }, { x: +maxT.toFixed(2), y: +(af * maxT).toFixed(2) }];
  return { pts, ref, af };
}

/* =========================================================================
   4. CHARTS
   ========================================================================= */
let DATA = null;
const charts = {};

// Custom plugin: draw vertical marker line(s) + label (data cut / fade month).
function verticalMarkerPlugin(getConfig) {
  return {
    id: "verticalMarker",
    afterDraw(chart) {
      const cfg = getConfig(chart);
      if (!cfg) return;
      const { ctx, chartArea, scales } = chart;
      cfg.lines.forEach((ln) => {
        const x = scales.x.getPixelForValue(ln.value);
        if (x < chartArea.left || x > chartArea.right) return;
        ctx.save();
        ctx.strokeStyle = ln.color;
        ctx.lineWidth = 1.4;
        ctx.setLineDash(ln.dash || [5, 4]);
        ctx.beginPath();
        ctx.moveTo(x, chartArea.top);
        ctx.lineTo(x, chartArea.bottom);
        ctx.stroke();
        ctx.setLineDash([]);
        if (ln.label) {
          ctx.font = "600 10px system-ui, sans-serif";
          ctx.fillStyle = ln.color;
          ctx.textAlign = ln.align || "left";
          ctx.fillText(ln.label, x + (ln.align === "right" ? -6 : 6), chartArea.top + 12);
        }
        ctx.restore();
      });
    },
  };
}

const AXIS_FONT  = { size: 11, family: "system-ui, sans-serif" };
const TITLE_FONT = { size: 11, weight: "600", family: "system-ui, sans-serif" };
const MUTED = "#6B7A8A", GRID = "#EEF2F6";

function makeSurvivalChart() {
  charts.survival = new Chart(document.getElementById("chart-survival"), {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false,
      animation: { duration: 300 },
      interaction: { mode: "nearest", intersect: false },
      layout: { padding: { top: 6, right: 10, bottom: 2, left: 2 } },
      scales: {
        x: { type: "linear", min: 0, max: 60,
          title: { display: true, text: "Months from randomisation", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED, stepSize: 6, maxRotation: 0 }, grid: { color: GRID } },
        y: { min: 0, max: 100,
          title: { display: true, text: "Survival (%)", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED, callback: (v) => v + "%" }, grid: { color: GRID } },
      },
      plugins: {
        legend: { display: false },
        tooltip: {
          filter: (item) => !item.dataset._noTip,
          callbacks: {
            title: (items) => `Month ${(+items[0].parsed.x).toFixed(0)}`,
            label: (i) => `${i.dataset._plainLabel || i.dataset.label}: ${(+i.parsed.y).toFixed(1)}%`,
          },
        },
      },
    },
    plugins: [verticalMarkerPlugin((chart) => chart.$cutCfg)],
  });
}

function makeLandmarkChart() {
  charts.landmark = new Chart(document.getElementById("chart-landmark"), {
    type: "bar",
    data: { labels: ["1y", "2y", "3y", "5y"], datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      layout: { padding: { top: 6, right: 8, bottom: 2, left: 2 } },
      scales: {
        x: { grid: { display: false }, ticks: { font: AXIS_FONT, color: MUTED } },
        y: { beginAtZero: true, max: 70,
          title: { display: true, text: "Survival (%)", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED, callback: (v) => v + "%" }, grid: { color: GRID } },
      },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 12, font: AXIS_FONT, color: "#2C3E50" } },
        tooltip: { callbacks: { label: (i) => `${i.dataset.label}: ${(+i.parsed.y).toFixed(1)}%` } },
      },
    },
  });
}

// Shared factory for the two log-cumulative-hazard charts (Panel C + Panel D tab).
function makeLCHChart(id) {
  return new Chart(document.getElementById(id), {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: "nearest", intersect: false },
      layout: { padding: { top: 6, right: 12, bottom: 2, left: 2 } },
      scales: {
        x: { type: "linear",
          title: { display: true, text: "ln(time)", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED }, grid: { color: GRID } },
        y: { title: { display: true, text: "ln(−ln S)", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED }, grid: { color: GRID } },
      },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 12, font: AXIS_FONT, color: "#2C3E50" } },
        tooltip: { enabled: true },
      },
    },
  });
}

function makeSchoenfeldChart() {
  charts.schoen = new Chart(document.getElementById("chart-schoenfeld"), {
    type: "scatter",
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      layout: { padding: { top: 6, right: 12, bottom: 2, left: 2 } },
      scales: {
        x: { type: "linear", min: 0,
          title: { display: true, text: "Months", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED, stepSize: 4 }, grid: { color: GRID } },
        y: { title: { display: true, text: "Scaled Schoenfeld residual", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED }, grid: { color: GRID } },
      },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 12, font: AXIS_FONT, color: "#2C3E50" } },
        tooltip: { callbacks: { label: (i) => `t=${(+i.parsed.x).toFixed(1)}m, r=${(+i.parsed.y).toFixed(2)}` } },
      },
    },
    plugins: [verticalMarkerPlugin((chart) => chart.$fadeCfg)],
  });
}

function makeQQChart() {
  return new Chart(document.getElementById("chart-qq"), {
    type: "scatter",
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      layout: { padding: { top: 6, right: 12, bottom: 2, left: 2 } },
      scales: {
        x: { type: "linear", min: 0,
          title: { display: true, text: "Trastuzumab event-time quantile (months)", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED }, grid: { color: GRID } },
        y: { min: 0,
          title: { display: true, text: "Zanidatamab quantile (months)", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED }, grid: { color: GRID } },
      },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 12, font: AXIS_FONT, color: "#2C3E50" } },
        tooltip: { callbacks: { label: (i) => `(${(+i.parsed.x).toFixed(1)}, ${(+i.parsed.y).toFixed(1)})` } },
      },
    },
  });
}

function makeGOFChart() {
  charts.gof = new Chart(document.getElementById("chart-gof"), {
    type: "line",
    data: { datasets: [] },
    options: {
      responsive: true, maintainAspectRatio: false, animation: { duration: 300 },
      interaction: { mode: "nearest", intersect: false },
      layout: { padding: { top: 6, right: 12, bottom: 2, left: 2 } },
      scales: {
        x: { type: "linear", min: 0, max: 30,
          title: { display: true, text: "Months (observed period)", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED, stepSize: 4 }, grid: { color: GRID } },
        y: { min: 0, max: 100,
          title: { display: true, text: "Survival (%)", font: TITLE_FONT, color: MUTED },
          ticks: { font: AXIS_FONT, color: MUTED, callback: (v) => v + "%" }, grid: { color: GRID } },
      },
      plugins: {
        legend: { position: "top", labels: { boxWidth: 12, font: AXIS_FONT, color: "#2C3E50" } },
        tooltip: { filter: (i) => !i.dataset._noTip,
          callbacks: { label: (i) => `${i.dataset.label}: ${(+i.parsed.y).toFixed(1)}%` } },
      },
    },
  });
}

/* =========================================================================
   5. RENDER — recompute all curves for the current selection
   ========================================================================= */
function currentSelection() {
  return {
    endpoint:    document.getElementById("f-endpoint").value,
    distKey:     document.getElementById("f-distribution").value,
    subgroupKey: document.getElementById("f-subgroup").value,
    waningKey:   document.getElementById("f-waning").value,
    fitKey:      document.getElementById("f-fittype").value,
  };
}

let diagNotes = { schoen: "", lch: "", qq: "" };
let activeDiagTab = "schoen";
// Latest computed diagnostic data — applied to the LCH/QQ tab charts, which are
// created lazily (only once their tab is first shown) to avoid the Chart.js
// "sized 0×0 when created inside a display:none container" pitfall.
let diagData = { lch: [], qq: null };

function render() {
  const sel = currentSelection();
  const ep  = DATA.endpoints[sel.endpoint];
  const sg  = ep.subgroups[sel.subgroupKey];
  const phViolated = sel.endpoint !== "PFS"; // OS/ToT violate PH; PFS ~ holds

  const zani  = buildArm({ ...sel, armKey: "Zanidatamab", DATA });
  const tras  = buildArm({ ...sel, armKey: "Trastuzumab", DATA });
  const fan   = buildFan(sel, DATA);
  const floor = buildFloor(DATA);

  /* ---- Panel A: survival curve (hero) ---- */
  const fanDatasets = fan.map((pts) => ({
    label: "", data: pts, _noTip: true,
    borderColor: CONFIG.COLOR.fan, borderWidth: 1, borderDash: [3, 3],
    pointRadius: 0, tension: 0.25, fill: false, order: 10,
  }));
  charts.survival.data.datasets = [
    ...fanDatasets,
    { label: "Zanidatamab (KM)", _plainLabel: "Zanidatamab KM", data: zani.kmSteps,
      borderColor: CONFIG.COLOR.zani, borderWidth: 2.4, stepped: true, pointRadius: 0, fill: false, order: 1 },
    { label: "Trastuzumab (KM)", _plainLabel: "Trastuzumab KM", data: tras.kmSteps,
      borderColor: CONFIG.COLOR.tras, borderWidth: 2.4, stepped: true, pointRadius: 0, fill: false, order: 1 },
    { label: "Zanidatamab (extrap.)", _plainLabel: "Zanidatamab extrap.", data: zani.extrap,
      borderColor: CONFIG.COLOR.zani, borderWidth: 2.4, borderDash: [7, 5], pointRadius: 0, tension: 0.2, fill: false, order: 2 },
    { label: "Trastuzumab (extrap.)", _plainLabel: "Trastuzumab extrap.", data: tras.extrap,
      borderColor: CONFIG.COLOR.tras, borderWidth: 2.4, borderDash: [7, 5], pointRadius: 0, tension: 0.2, fill: false, order: 2 },
    { label: "Gen-pop floor", _plainLabel: "Gen-pop floor", data: floor,
      borderColor: CONFIG.COLOR.floor, borderWidth: 1.6, borderDash: [2, 3], pointRadius: 0, tension: 0.3, fill: false, order: 9 },
  ];
  charts.survival.$cutCfg = { lines: [{ value: ep.cut, color: CONFIG.COLOR.cut, label: `Data cut · ${ep.cut}m`, dash: [5, 4], align: "left" }] };
  charts.survival.update();

  document.getElementById("a-title").textContent = `${ep.label} · ${sel.distKey}`;
  document.getElementById("a-med-z").textContent = zani.median.toFixed(1);
  document.getElementById("a-med-t").textContent = tras.median.toFixed(1);
  document.getElementById("a-5y-z").textContent  = (zani.landmarks[5] * 100).toFixed(1) + "%";
  document.getElementById("a-cut").textContent   = ep.cut;

  /* ---- Panel B: landmark validation ---- */
  const modelled = [1, 2, 3, 5].map((y) => +(zani.landmarks[y] * 100).toFixed(1));
  const anchor   = [1, 2, 3, 5].map((y) => +(sg.anchor[y] * 100).toFixed(1));
  charts.landmark.data.datasets = [
    { label: "Modelled (Zanidatamab)", data: modelled, backgroundColor: CONFIG.COLOR.blue, borderRadius: 3, maxBarThickness: 30 },
    { label: "RWE anchor", data: anchor, backgroundColor: "#B9C9D9", borderRadius: 3, maxBarThickness: 30 },
  ];
  charts.landmark.update();

  /* ---- Panel C: log-cumulative hazard (PH check) ---- */
  const lch = buildLCH(zani, tras, ep.cut, phViolated);
  const lchDatasets = [
    { label: "Zanidatamab", data: lch.zani, borderColor: CONFIG.COLOR.zani, borderWidth: 2, pointRadius: 0, tension: 0.1 },
    { label: "Trastuzumab", data: lch.tras, borderColor: CONFIG.COLOR.tras, borderWidth: 2, pointRadius: 0, tension: 0.1 },
  ];
  charts.ph.data.datasets = lchDatasets.map((d) => ({ ...d }));
  charts.ph.update();
  const phBadge = document.getElementById("ph-badge");
  phBadge.textContent = phViolated ? "PH violated" : "PH ~ held";
  phBadge.className = "ph-badge " + (phViolated ? "rejected" : "held");

  /* ---- Panel D: tabbed diagnostics (Schoenfeld / LCH / QQ) ---- */
  const sch = buildSchoenfeld(sel.endpoint, sel.subgroupKey, ep.cut, DATA.phFadeMonth);
  charts.schoen.data.datasets = [
    { label: "Residuals", data: sch.points, type: "scatter",
      backgroundColor: "rgba(138,90,0,0.55)", pointRadius: 3, pointHoverRadius: 5 },
    { label: "Fitted trend", data: sch.trend, type: "line",
      borderColor: CONFIG.COLOR.amber, borderWidth: 2, pointRadius: 0, tension: 0.2, fill: false },
    { label: "Zero", data: [{ x: 0, y: 0 }, { x: ep.cut, y: 0 }], type: "line",
      borderColor: "#B9C9D9", borderWidth: 1, borderDash: [4, 4], pointRadius: 0 },
  ];
  charts.schoen.$fadeCfg = { lines: [{ value: DATA.phFadeMonth, color: CONFIG.COLOR.amber, label: `effect fades · ${DATA.phFadeMonth}m`, dash: [4, 4], align: "right" }] };
  charts.schoen.update();

  // LCH and QQ tab charts are created lazily; stash their data and update
  // whichever already exist (see updateDiagCharts / switchDiagTab).
  const qq = buildQQ(zani, tras);
  diagData.lch = lchDatasets;
  diagData.qq  = [
    { label: "Quantile pairs", data: qq.pts, type: "scatter",
      backgroundColor: "rgba(27,94,146,0.6)", pointRadius: 3.5, pointHoverRadius: 5 },
    { label: `AFT reference (slope ${qq.af.toFixed(2)})`, data: qq.ref, type: "line",
      borderColor: CONFIG.COLOR.navy, borderWidth: 1.6, borderDash: [5, 4], pointRadius: 0 },
  ];
  updateDiagCharts();

  // Per-tab explanatory notes (shown beneath the active diagnostic).
  const fade = DATA.phFadeMonth;
  diagNotes = {
    schoen: phViolated
      ? `The fitted trend crosses zero near <b>${fade} months</b> and drifts negative — the treatment effect attenuates, a hallmark of <b>non-proportional hazards</b>.`
      : `Residuals scatter around zero with only mild drift — consistent with <b>proportional hazards</b> holding over the observed period.`,
    lch: phViolated
      ? `The two log-cumulative-hazard lines are <b>not parallel</b> — proportional hazards is rejected, so per-arm (stratified) fits are preferred.`
      : `The log-cumulative-hazard lines are <b>near-parallel</b> — proportional hazards is a reasonable approximation here.`,
    qq: `Quantile pairs fall close to a straight line through the origin (slope ≈ acceleration factor <b>${qq.af.toFixed(2)}</b>) — the <b>AFT</b> assumption is supported even where PH is not.`,
  };
  showDiagNote();

  /* ---- Panel F: observed vs predicted + milestones ---- */
  charts.gof.options.scales.x.max = ep.cut;
  charts.gof.data.datasets = [
    { label: "Zanidatamab (KM)", data: zani.kmSteps, borderColor: CONFIG.COLOR.zani, borderWidth: 2.4, stepped: true, pointRadius: 0, fill: false },
    { label: "Trastuzumab (KM)", data: tras.kmSteps, borderColor: CONFIG.COLOR.tras, borderWidth: 2.4, stepped: true, pointRadius: 0, fill: false },
    { label: "Zanidatamab (fitted)", data: zani.fitted, borderColor: CONFIG.COLOR.zani, borderWidth: 1.8, borderDash: [6, 4], pointRadius: 0, tension: 0.2, fill: false },
    { label: "Trastuzumab (fitted)", data: tras.fitted, borderColor: CONFIG.COLOR.tras, borderWidth: 1.8, borderDash: [6, 4], pointRadius: 0, tension: 0.2, fill: false },
  ];
  charts.gof.update();
  renderMilestones(zani, tras);

  /* ---- Panel E: interpretation ---- */
  renderInterpretation(sel, ep, sg, zani, phViolated);

  saveSelection(sel);
}

function showDiagNote() {
  document.getElementById("d-note").innerHTML = diagNotes[activeDiagTab] || "";
}

// Push the latest LCH / QQ data into whichever tab charts have been created.
function updateDiagCharts() {
  if (charts.lch2 && diagData.lch.length) {
    charts.lch2.data.datasets = diagData.lch.map((d) => ({ ...d }));
    charts.lch2.update();
  }
  if (charts.qq && diagData.qq) {
    charts.qq.data.datasets = diagData.qq;
    charts.qq.update();
  }
}

// Panel F milestones table (median, mean/RMST, % survival at 1/2/3/5 years).
function renderMilestones(zani, tras) {
  const pc = (v) => (v * 100).toFixed(1) + "%";
  const rows = [
    { grp: "Central tendency" },
    { k: "Median (months)", z: zani.median.toFixed(1), t: tras.median.toFixed(1) },
    { k: "Mean · RMST 0–60m (months)", z: zani.meanRmst.toFixed(1), t: tras.meanRmst.toFixed(1) },
    { grp: "Survival probability (modelled)" },
    { k: "1 year",  z: pc(zani.landmarks[1]), t: pc(tras.landmarks[1]) },
    { k: "2 years", z: pc(zani.landmarks[2]), t: pc(tras.landmarks[2]) },
    { k: "3 years", z: pc(zani.landmarks[3]), t: pc(tras.landmarks[3]) },
    { k: "5 years", z: pc(zani.landmarks[5]), t: pc(tras.landmarks[5]) },
  ];
  const html = rows.map((r) =>
    r.grp
      ? `<tr class="grp"><td colspan="3">${r.grp}</td></tr>`
      : `<tr><td>${r.k}</td><td class="z">${r.z}</td><td class="t">${r.t}</td></tr>`
  ).join("");
  document.querySelector("#milestones tbody").innerHTML = html;
  document.getElementById("gof-badge").textContent = "in-sample fit: close";
}

/* =========================================================================
   6. INTERPRETATION GENERATOR  (§6 of the brief)
   Composes sentences from the current selection, incl. a fit-type sentence.
   ========================================================================= */
function renderInterpretation(sel, ep, sg, zani, phViolated) {
  const box    = document.getElementById("interpretation");
  const waning = DATA.waning[sel.waningKey];
  const fit    = DATA.fitTypes[sel.fitKey];

  const surv5   = (zani.landmarks[5] * 100).toFixed(1);
  const anchor5 = (sg.anchor[5] * 100).toFixed(1);
  const surv3   = (zani.landmarks[3] * 100).toFixed(1);
  const anchor3 = (sg.anchor[3] * 100).toFixed(1);

  // AIC ranking (reference only)
  const ranked  = Object.entries(DATA.distributions).sort((a, b) => a[1].aic - b[1].aic);
  const aicRank = ranked.findIndex(([k]) => k === sel.distKey) + 1;
  const bestAic = ranked[0][0];

  const diff5 = (+surv5 - +anchor5);
  const compare5 = Math.abs(diff5) < 1.0 ? "closely matches"
                 : diff5 > 0 ? "sits <b>above</b>" : "sits <b>below</b>";

  const phSentence = phViolated
    ? `Proportional hazards is <b class="rej">rejected</b> — the log-cumulative-hazard lines are non-parallel and the effect attenuates from ~${DATA.phFadeMonth} months, so independent per-arm fits with a capped hazard are used.`
    : `Proportional hazards is <b class="hld">held</b> over the observed period, so a single relative-effect model is acceptable; residual drift near ~${DATA.phFadeMonth} months is still monitored.`;

  const waningClause = waning.converge > 0
    ? ` With waning set to <strong>${waning.label}</strong>, the arms converge in the tail (${waning.note}), reducing the long-term separation.`
    : ` With <strong>${waning.label}</strong> waning, the full treatment effect is carried across the extrapolation.`;

  // Fit-type sentence — compare the current fit's 5y with the alternative fit's.
  const otherFitKey = Object.keys(DATA.fitTypes).find((k) => k !== sel.fitKey);
  const zaniOther = buildArm({ ...sel, fitKey: otherFitKey, armKey: "Zanidatamab", DATA });
  const surv5other = (zaniOther.landmarks[5] * 100).toFixed(1);
  const fitGap = Math.abs(+surv5 - +surv5other);
  const fitAgree = fitGap < 1.0 ? "agree closely" : "differ materially";
  const fitSentence =
    `Fit type is <strong>${fit.short}</strong> (${fit.note}). Jointly fitted and fully stratified 5-year ` +
    `estimates <b>${fitAgree}</b> (${surv5}% vs ${surv5other}%); both are presented as standard NICE DSU practice.`;

  box.innerHTML = `
    <p class="lead">
      For <strong>${ep.label}</strong> in the <strong>${sg.label}</strong> population, the selected
      <strong>${sel.distKey}</strong> distribution implies <strong>${surv5}%</strong> Zanidatamab survival at 5 years
      (${surv3}% at 3 years).${waningClause}
    </p>
    <p class="ph-line">${phSentence}</p>
    <p>${fitSentence}</p>
    <p>
      Against the external RWE anchor, the modelled 5-year value (${surv5}%) ${compare5} the anchor of
      <strong>${anchor5}%</strong> (3-year: ${surv3}% modelled vs ${anchor3}% anchor) — external validation, not fit,
      is what discriminates between the candidate curves here.
    </p>
    <p class="ref-note">
      AIC rank for ${sel.distKey} is #${aicRank} of ${ranked.length} (best by AIC: ${bestAic}) —
      shown for reference only. Selection is on plausibility and external validity, not fit.
    </p>`;
}

/* =========================================================================
   7. WIRING — filters, tabs, modal, persistence, reset, transitions
   ========================================================================= */
function fillSelect(id, entries, current) {
  const el = document.getElementById(id);
  el.innerHTML = "";
  for (const [key, label] of entries) {
    const opt = document.createElement("option");
    opt.value = key; opt.textContent = label;
    if (key === current) opt.selected = true;
    el.appendChild(opt);
  }
}

function saveSelection(sel) {
  try { localStorage.setItem(CONFIG.STORE_KEY, JSON.stringify(sel)); } catch (e) { /* ignore */ }
}
function loadSelection() {
  try { return JSON.parse(localStorage.getItem(CONFIG.STORE_KEY)) || null; } catch (e) { return null; }
}
const DEFAULT_SELECTION = {
  endpoint: "OS", distKey: "Weibull", subgroupKey: "ITT",
  waningKey: "None", fitKey: "Jointly fitted (treatment as covariate)",
};

function populateFilters(sel) {
  const eps  = Object.entries(DATA.endpoints).map(([k, v]) => [k, v.label]);
  const dsts = Object.keys(DATA.distributions).map((k) => [k, k]);
  const wan  = Object.entries(DATA.waning).map(([k, v]) => [k, v.label]);
  const fits = Object.entries(DATA.fitTypes).map(([k, v]) => [k, v.label]);
  const sgs  = Object.entries(DATA.endpoints[sel.endpoint].subgroups).map(([k, v]) => [k, v.label]);
  fillSelect("f-endpoint", eps, sel.endpoint);
  fillSelect("f-distribution", dsts, sel.distKey);
  fillSelect("f-subgroup", sgs, sel.subgroupKey);
  fillSelect("f-waning", wan, sel.waningKey);
  fillSelect("f-fittype", fits, sel.fitKey);
}

// Render synchronously (so a filter change always takes effect immediately);
// the settle step uses a timer, not requestAnimationFrame (which browsers
// throttle in background tabs), so the grid can never get stuck dimmed.
function withTransition(fn) {
  const grid = document.querySelector(".grid");
  grid.classList.remove("settled");
  grid.classList.add("updating");
  fn();
  setTimeout(() => {
    grid.classList.remove("updating");
    grid.classList.add("settled");
  }, 130);
}

function switchDiagTab(tabKey) {
  activeDiagTab = tabKey;
  document.querySelectorAll(".panel.d .tab").forEach((b) => {
    const on = b.dataset.tab === tabKey;
    b.classList.toggle("active", on);
    b.setAttribute("aria-selected", on ? "true" : "false");
  });
  document.querySelectorAll(".panel.d .tab-panel").forEach((p) => {
    p.classList.toggle("hidden", p.dataset.tabpanel !== tabKey);
  });
  // Charts are always sized (tab-stack keeps their box) — just refresh the one
  // being shown so its animation plays on reveal.
  const c = { schoen: charts.schoen, lch: charts.lch2, qq: charts.qq }[tabKey];
  if (c) c.update();
  showDiagNote();
}

function openMethod()  { document.getElementById("method-modal").classList.remove("hidden"); }
function closeMethod() { document.getElementById("method-modal").classList.add("hidden"); }

function attachHandlers() {
  ["f-endpoint", "f-distribution", "f-subgroup", "f-waning", "f-fittype"].forEach((id) => {
    document.getElementById(id).addEventListener("change", () => withTransition(render));
  });
  document.getElementById("reset-btn").addEventListener("click", () => {
    populateFilters(DEFAULT_SELECTION);
    withTransition(render);
  });

  // Panel D tabs
  document.querySelectorAll(".panel.d .tab").forEach((b) => {
    b.addEventListener("click", () => switchDiagTab(b.dataset.tab));
  });

  // Method modal
  document.getElementById("method-btn").addEventListener("click", openMethod);
  document.getElementById("method-close").addEventListener("click", closeMethod);
  document.querySelector("#method-modal .modal-backdrop").addEventListener("click", closeMethod);
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeMethod(); });
}

/* =========================================================================
   8. BOOT
   ========================================================================= */
let booted = false;
async function boot() {
  if (booted) return; booted = true;
  const res = await fetch(CONFIG.DATA_URL, { cache: "no-store" });
  DATA = await res.json();

  const sel = validateSelection(loadSelection()) || DEFAULT_SELECTION;

  populateFilters(sel);
  makeSurvivalChart();
  makeLandmarkChart();
  charts.ph = makeLCHChart("chart-ph");        // Panel C
  makeSchoenfeldChart();                        // Panel D tab 1
  charts.lch2 = makeLCHChart("chart-lch2");    // Panel D tab 2 (sized via tab-stack)
  charts.qq = makeQQChart();                    // Panel D tab 3
  makeGOFChart();
  attachHandlers();
  render();
}

// Guard against stale/invalid stored selections.
function validateSelection(sel) {
  if (!sel) return null;
  if (!DATA.endpoints[sel.endpoint]) return null;
  if (!DATA.distributions[sel.distKey]) return null;
  if (!DATA.endpoints[sel.endpoint].subgroups[sel.subgroupKey]) return null;
  if (!DATA.waning[sel.waningKey]) return null;
  if (!sel.fitKey || !DATA.fitTypes[sel.fitKey]) return null;
  return sel;
}

// Start the gate on load.
if (document.readyState === "loading") {
  document.addEventListener("DOMContentLoaded", initGate);
} else {
  initGate();
}
