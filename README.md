# Political Atlas

An interactive world map showing who holds power in **78 countries and territories**: every European state (including Turkey and the South Caucasus), every North American state (including Central America, the Caribbean and Greenland), plus Russia, China, Japan, Israel and Saudi Arabia.

Click a country to see:

- **Executive**: head of state, head of government and governing parties
- **Legislature**: who controls each chamber, with seat counts
- **Judiciary**: the top courts and any notable tensions
- **Key election dates**: past and upcoming, with countdowns
- **Synopsis, key policies and main challenges** of the current leadership

You can colour the map by **system of government**, **time to next election**, or **stability** (stable vs. in flux). On the map, systems are grouped into three families (parliamentary, presidential or semi-presidential, one-party or absolute rule) plus "Other", so the colours stay distinguishable for colour-blind readers; the tooltip, profile and table give each country's exact system. The **Table** tab lists every country with its system, leaders, stability and next election, sortable by any column (`?view=table` links straight to it).

Political Atlas is a submodule of **Realtime Intelligence** in **PRP** (Personal Resource Planner, by JDP-Iq), also at https://jdpi.pages.dev/#/rt/atlas. It uses the shared PRP stylesheet and connector (`https://jdpi.pages.dev/design/prp.css`, `prp-bar.js`), light by default with a dark theme.

## Run locally

```bash
npm install
npm start          # serves on http://localhost:8080
```

The page has to be served over HTTP, because opening `index.html` directly from disk blocks the data `fetch`.

## Project layout

| Path | Purpose |
|---|---|
| `index.html`, `styles.css`, `app.js` | Static front end (D3 + TopoJSON, no build step) |
| `data/manifest.json` | List of data files and the last-updated date |
| `data/countries/*.json` | One file per region, containing one record per country |
| `data/schema.json` | JSON Schema that every record must match |
| `scripts/update-data.mjs` | Monthly refresh using Claude with live web search |
| `scripts/validate.mjs` | Schema and duplicate check |
| `.github/workflows/monthly-update.yml` | Runs the refresh on the 1st of each month |

## Monthly self-update

On the 1st of each month, `.github/workflows/monthly-update.yml`:

1. Sends each country record to Claude (`claude-opus-5-5`) with the **web search** tool, asking it to verify and update every fact.
2. Validates each response against `data/schema.json` and rejects anything malformed. Identity fields (name, ISO codes) can never change.
3. Opens a **pull request** with the changes. The PR description is `update-report.md`, which lists who changed and which countries still need review.

Merging the PR redeploys the site. This review step is deliberate: political data is sensitive, and a person should approve changes before they go live. If you prefer fully automatic updates, change the last step to commit straight to `main`.

**Setup:** add `ANTHROPIC_API_KEY` under *Settings → Secrets and variables → Actions* in GitHub. You can also run the workflow by hand from the Actions tab (*Run workflow*), optionally for specific countries (e.g. `FRA,SWE`).

To run an update locally:

```bash
node scripts/update-data.mjs --only=SWE,ISR
```

**Cost:** each country uses up to 8 web searches plus one model call. A full monthly run of 78 countries typically costs a few US dollars to low tens of dollars in API usage. Lower `effort` or narrow `--only` to reduce it.

Records Claude cannot fully confirm keep their existing values and get a `reviewNote`. The note shows as a yellow "Needs review" box in the app.

## Hosting

The site is fully static, so any static host works. Recommended setup:

- **GitHub** holds the code and data, and **GitHub Actions** runs the monthly job (free for public repositories).
- **Cloudflare Pages**, **Netlify** or **GitHub Pages** serves the site. Connect the repository and every merged update deploys automatically. No build command is needed; the output directory is `/`.

## Recommended third-party software

### Already used

| Tool | Role |
|---|---|
| [D3.js](https://d3js.org) | Map projection, drawing, zoom and pan |
| [world-atlas / Natural Earth](https://github.com/topojson/world-atlas) | Public-domain country boundaries (TopoJSON) |
| [topojson-client](https://github.com/topojson/topojson-client) | Decodes the boundary data |
| [Anthropic Claude API](https://platform.claude.com) + web search tool | Monthly research and refresh of every record |
| [Ajv](https://ajv.js.org) | JSON Schema validation, so bad data cannot ship |
| [flagcdn](https://flagcdn.com) | Flag images |
| [GitHub Actions](https://github.com/features/actions) + [create-pull-request](https://github.com/peter-evans/create-pull-request) | Scheduler and review workflow |

### Worth adding

| Tool | Why |
|---|---|
| **[Wikidata SPARQL API](https://query.wikidata.org)** (free) | Structured, machine-readable heads of state and government. Useful as a cross-check against Claude's output, flagging disagreements for review. |
| **[IPU Parline](https://data.ipu.org)** (free) | Authoritative parliament composition, seat counts and election dates for every national legislature. |
| **[IFES ElectionGuide](https://www.electionguide.org)** | Election calendar to catch snap elections between monthly runs. |
| **[ParlGov](https://www.parlgov.org)** / **[Chapel Hill Expert Survey](https://www.chesdata.eu)** | Party family classifications (e.g. left/right placement) if you add party-ideology colouring. |
| **[MapLibre GL JS](https://maplibre.org)** | Swap in for D3 if you want smooth vector tiles, labels and street-level zoom. |
| **[Cloudflare Pages](https://pages.cloudflare.com)** or **[Netlify](https://www.netlify.com)** | Free global CDN hosting with automatic deploys and preview links for each update PR. |
| **[Plausible](https://plausible.io)** or **[Umami](https://umami.is)** | Privacy-friendly analytics showing which countries people look at. |
| **[Sentry](https://sentry.io)** | Front-end error monitoring. |
| **[Decap CMS](https://decapcms.org)** | A web form for editors to correct country records without editing JSON. It commits to the same repository. |
| **[Renovate](https://docs.renovatebot.com)** / Dependabot | Keeps library versions current. |
| **[Playwright](https://playwright.dev)** | Automated test that the map loads and every country opens, run before merging data PRs. |
| **Event-driven updates** | Beyond the monthly run, trigger the workflow (`--only=XXX`) the day after a scheduled election, using dates already in the dataset. |

## Data accuracy

The initial dataset is current to **25 October 2026** and was checked against news sources for the many changes since mid-2026 (new governments in the UK, Hungary, Slovenia, Bulgaria, Denmark and the Netherlands, among others). Countries with fast-moving situations are marked **In flux** with a review note. At the time of writing these are Sweden, Israel, Spain, Serbia, Bulgaria, Latvia, Bosnia, Kosovo, Romania, France and Haiti. Run the updater once after setup to refresh them.
