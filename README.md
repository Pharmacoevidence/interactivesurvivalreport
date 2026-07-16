# EmpowHER-303 · Survival Extrapolation (interactive demonstrator)

An interactive, **static** survival-extrapolation report built for GitHub Pages.
It is the survival companion to the EmpowHER-303 utilities dashboard and demonstrates
how an HTA reviewer or payer can explore parametric survival extrapolations by
changing **Endpoint**, **Distribution**, **Subgroup**, **Waning**, and **Fit type**
(jointly fitted vs fully stratified) — every chart and the interpretation text
updates instantly.

> ⚠️ **All figures are simulated dummy data.** Nothing here is real EmpowHER-303
> data or a real clinical result. The dashboard carries a non-dismissible watermark
> saying so. It is a capability demonstrator for Pharmacoevidence (PCE).

## The message it demonstrates

Many parametric curves fit the observed Kaplan–Meier data almost equally well and
then **diverge dramatically in the tail**. Curve selection for extrapolation should
be driven by **external validation and clinical plausibility**, not by AIC/BIC. The
AIC rank shown in the interpretation panel is labelled *reference only* on purpose.

## What's in the box

```
/index.html            – markup: gate, browser frame, title bar, 5 panels, footer
/assets/styles.css     – all styling tokens (brand colours as CSS variables)
/assets/app.js         – ES module: gate, curve generation, charts, interpretation
/assets/data.json      – simulated model parameters (curves computed at runtime)
/assets/logo.svg       – placeholder PCE wordmark
/README.md             – this file
```

Charts use **Chart.js v4** loaded from the jsDelivr CDN. There is **no build step**
and **no backend**. The one runtime fetch is the local `assets/data.json`.

### Filters

**Endpoint** (OS / PFS / ToT), **Distribution** (7 parametric + spline families),
**Subgroup** (ITT / 3L / 4L), **Waning** (None / hazard convergence / no benefit
after progression), and **Fit type** (jointly fitted — treatment as covariate — vs
fully stratified — separate per arm, per NICE DSU practice; the two produce visibly
different tails). A **Reset** button restores defaults; the last selection persists
in `localStorage`.

### Panels

- **A — Survival curve (hero):** KM step per arm (solid) to the data cut, selected
  parametric/spline extrapolation (dashed) to 60 months, general-population floor
  (dotted), a vertical data-cut marker, and a faint "fan" of the non-selected
  distributions to show tail disagreement.
- **B — Landmark validation:** modelled vs external RWE anchor at 1 / 2 / 3 / 5 years.
- **C — Log-cumulative hazard (PH check):** two arms; a badge flags PH violation.
- **D — PH / AFT diagnostics (tabbed):** three model-checking views per NICE DSU
  TSD 14 — Schoenfeld residuals (fitted trend + ~16-month fade marker),
  log-cumulative hazard, and a QQ plot for the AFT assumption.
- **E — Dynamic interpretation:** sentences regenerated from the current selection,
  including a joint-vs-stratified fit-type comparison.
- **F — Observed vs predicted:** the fitted parametric curve overlaid on the observed
  KM, with a survival-milestones table (median, mean/RMST, and % survival at
  1 / 2 / 3 / 5 years) for each arm.

A **Method** button opens a modal rendering the NICE DSU TSD 14 (Latimer 2011)
model-selection algorithm as a flowchart (illustrative adaptation).

## Run it locally (one command)

No install needed — any static file server works. From the repo root:

```bash
python3 -m http.server 8080
```

Then open <http://localhost:8080/>. (Opening `index.html` via `file://` also works
in most browsers, but a local server matches how GitHub Pages serves the site.)

The default demo passphrase is **`empowher-2026`**.

## Deploy to GitHub Pages

1. Push this repo to GitHub.
2. Repository **Settings → Pages**.
3. **Source: Deploy from a branch**, branch **`main`**, folder **`/ (root)`**. Save.
4. Wait ~1 minute; the site publishes at `https://<user>.github.io/<repo>/`.

Everything uses relative paths, so it works from a project subpath. No Actions
workflow or build is required.

## Changing the passphrase

The passphrase is validated against a **SHA-256 hash** — the plaintext is never
stored. To change it:

1. Compute the hash of your new passphrase:
   ```bash
   printf 'your new passphrase' | shasum -a 256
   # Linux: printf 'your new passphrase' | sha256sum
   ```
   Use `printf` (not `echo`) so no trailing newline is hashed.
2. Open `assets/app.js`, find the `CONFIG` block near the top, and replace the
   value of `PASSPHRASE_SHA256` with the new hex digest.

That is the single place to change it.

## Authentication — read this honestly

**The passphrase gate is obfuscation, not security.** GitHub Pages serves public,
static files: anyone can read `app.js`, see the hash, and view the bundled
`data.json` directly. A client-side check cannot keep a determined viewer out, and
the "protected" content ships in the repo regardless of the gate.

If you need **genuine access control**, put the site behind a real gate. Options,
best first:

### Recommended — Cloudflare Access (Zero Trust)

Cloudflare Access enforces authentication *at the edge, before* any file is served,
so the static content is never delivered to an unauthenticated visitor.

1. Put the site on a custom domain proxied through Cloudflare (orange-cloud DNS),
   or host the assets on Cloudflare Pages.
2. In the Cloudflare dashboard: **Zero Trust → Access → Applications → Add an
   application → Self-hosted.**
3. Set the application domain to your site (e.g. `survival.pharmacoevidence.io`).
4. Add an **Access policy** — e.g. *Allow* the emails/domains of the client
   reviewers, or require a one-time PIN sent to approved addresses.
5. Save. Cloudflare now shows its own login before the site loads; unauthenticated
   requests never reach the content.

You can then remove or keep the in-page passphrase gate — with Access in front it is
redundant.

### Other robust options

- **Netlify** site-wide or role-based **password protection** (Netlify's built-in
  gate runs server-side).
- A **private repository** served via **GitHub Enterprise Cloud Pages** with access
  limited to repo collaborators.

## Data & privacy

All numbers are **simulated**. There is **no real or identifiable patient data** in
this repository. Medians, landmark survivals, RWE anchors, PH diagnostics, and
Schoenfeld residuals are generated from the parameters in `assets/data.json` purely
to make the demonstrator behave realistically. Do not present any figure here as an
actual EmpowHER-303 result.

---

*Illustrative demonstrator · simulated data · not EmpowHER-303 results · Pharmacoevidence*
