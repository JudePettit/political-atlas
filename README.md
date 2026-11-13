# Political Atlas

An interactive world map showing who holds power, country by country. The atlas is growing to **198 countries and territories**: the 193 UN member states, the Holy See, Palestine, Kosovo, Taiwan and Greenland. Every European state (including Turkey and the South Caucasus), every North American state (including Central America, the Caribbean and Greenland), Russia, China, Japan, Israel and Saudi Arabia have records; the rest are listed in `data/seeds.json` and are added a region at a time (see [Adding countries](#adding-countries)). The page counts the records it has, and a country without one shows as "Not covered".

Click a country to see:

- **Executive**: head of state, head of government and governing parties
- **Legislature**: who controls each chamber, with seat counts
- **Judiciary**: the top courts and any notable tensions
- **Key election dates**: past and upcoming, with countdowns
- **Synopsis, key policies and main challenges** of the current leadership

Hover over a country for its name and **whoever holds the most power** there, with their office and party. That is the head of government in parliamentary systems (the UK's prime minister, Germany's chancellor) and the head of state where the president, monarch or party leader directs the government (France's president, not its prime minister; Russia's and Ukraine's presidents; China's party leader; Monaco's prince), or a regent who exercises the head of state's powers on his behalf (Liechtenstein's Hereditary Prince Alois, since 2004; the Prince stays head of state, and the record keeps the regent in `executive.regent`). Each record says which it is, in `executive.leader` (`headOfState`, `headOfGovernment` or `regent`), judged by practice and not by the constitution's wording alone. The field names an office, so where the most powerful figure holds neither (Georgia's ruling-party founder, for example), the atlas still names the officeholder.

You can colour the map by **system of government**, **time to next election**, or **stability** (stable vs. in flux). On the map, systems are grouped into three families (parliamentary, presidential or semi-presidential, one-party or absolute rule, which includes theocracies and military governments) plus "Other", so the colours stay distinguishable for colour-blind readers; the tooltip, profile and table give each country's exact system. The **Table** tab lists every country with its system, leaders, stability and next election, sortable by any column (`?view=table` links straight to it). The **Region** filter narrows the table and the upcoming-elections list to one region and zooms the map to it (`?region=Africa` links straight to it); its list is built from the records, so a region appears once its first country has one.

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
| `data/seeds.json` | Countries still to be added, with their codes, names, regions and groups (not read by the site) |
| `scripts/update-data.mjs` | Monthly refresh, and create mode for new countries, using Claude with live web search |
| `scripts/research.mjs` | The prompts, request loop, parsing and checks both modes share |
| `scripts/validate.mjs` | Schema and duplicate check |
| `.github/workflows/monthly-update.yml` | Runs the refresh on the 1st of each month, and create runs by hand |
| `tests/` | Data checks, create mode against a stub client, and end-to-end tests in Edge |

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

**Cost:** each country uses up to 8 web searches plus one model call (more if a long search turn pauses and is resumed). The one measured run so far (Sweden, 25 October 2026) used about 175,000 input and 4,000 output tokens and 8 searches: about **$0.85 per country** at list prices ($4 and $20 per million input and output tokens, $10 per 1,000 searches). A monthly run covers every country that has a record, so its cost grows with the atlas: about $65 a month for today's records, and about **$170 a month once all 198 countries have one**. Every run now prints its token and search totals and an estimated dollar figure. Lower `effort` or narrow `--only` or `--region` to reduce it.

Records Claude cannot fully confirm keep their existing values and get a `reviewNote`. The note shows as a yellow "Needs review" box in the app.

## Adding countries

Countries without a record are listed in `data/seeds.json`, in nine groups of 6 to 18 (`africa-north`, `africa-west`, `africa-central-south`, `africa-east`, `south-america`, `middle-east`, `asia-south-central`, `asia-east-southeast`, `oceania`). **Create mode** researches each one from its identity (ISO codes, name and region) and writes its complete record:

1. In GitHub, *Actions → Monthly data update → Run workflow*, with **mode** `create` and **region** one group (e.g. `africa-north`). A region name such as `South America` also works. A run of more than 20 countries is refused (`Africa` alone is 54, too many for one reviewable run and for the job's time limit); locally, `--allow-large` overrides this.
2. Each country is one research turn with up to 14 web searches. Its reply is checked against the schema and the data tests' rules (dates, an upcoming election or a system that has none, a named leader, filled text, no HTML); a record that fails goes back to Claude once with the problems. A country that still fails is reported and nothing of it is written.
3. Records are written to `data/countries/<group>.json` as they are ready, and the file is added to `data/manifest.json` (its `lastUpdated` date stays the monthly refresh's). The run opens its own pull request (branch `data-add-<group>`). For each country it gives the leader, the reason for that choice where it is not obvious, and the web pages Claude cites for the executive, the elections and the legislature, so each name and date can be checked against a source; a cited page that was not among the run's search results is marked. It also lists what needs review, what failed and the run's estimated cost. If the run reaches its time limit, the pull request still opens with the countries it finished.
4. **One group at a time: merge (or close) a create pull request before starting the next create run.** The workflow refuses a create run while one is open, because every run starts from `main`: a second run would research the open pull request's countries again, and two open create pull requests would conflict in `data/manifest.json`. To retry failures, merge the pull request, then run the same group again: countries that already have a record are skipped. `only` narrows a run to some codes (e.g. `BRA,ARG`).

**Cost of adding countries:** not yet measured. A record written from nothing uses more searches and tokens than a monthly check: an estimate of $1.50 to $2.50 per country (more when a record needs its repair turn), so about $10 to $15 for `africa-north` and $200 to $300 for all 120. Start with `africa-north` (6 countries) and use its reported total to judge the rest. A country that fails costs money too.

Locally: `node scripts/update-data.mjs --mode=create --region=africa-north` (add `--dry-run` to write nothing). Monthly refreshes cover a new region from the first 1st of the month after its pull request is merged.

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

The first 78 records were current to **25 October 2026** and were checked against news sources for the many changes since mid-2026 (new governments in the UK, Hungary, Slovenia, Bulgaria, Denmark and the Netherlands, among others). Countries with fast-moving situations are marked **In flux** with a review note. On 6 November 2026 these are Bosnia, France, Haiti, Israel, Latvia, Serbia, Spain and Sweden. Run the updater once after setup to refresh them.
