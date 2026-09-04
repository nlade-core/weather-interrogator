# weather-interrogator

Short-term weather forecast for Edinburgh, pulled live from [Open-Meteo](https://open-meteo.com/) (no API key needed — safe for a static site). A chart navigates the raw hourly data into something readable; the raw JSON is still there, collapsed, for anyone who wants to check the tool's working.

Live: https://nlade-core.github.io/weather-interrogator/

## Why

Weather APIs return a wall of hourly arrays. Most questions people actually have ("do I need an umbrella," "is it worth a BBQ this weekend") only need a couple of those numbers, weighed together. This is a testbed for going from raw data to a useful answer.

## MVP (current)

- Fetch Open-Meteo's forecast endpoint for Edinburgh: current conditions, hourly, and 15-minutely temperature through midnight
- Chart shows temperature at 15-minute resolution (a visibly smoother, more precise line than hourly) with rain probability as a full-height, low-opacity wash behind it, Apple Weather-style — 100% reaches the top of the chart, faded enough that the temperature line stays readable through it. Rain probability is hourly data, and each reading describes the *preceding* hour (confirmed against Open-Meteo's docs) — so the "15:00" reading is what's actually in force at 14:20, not the "14:00" one. Readings are shifted back one hour position before interpolating, so bar height is exact at each hour mark using the *correct* reading and smoothly blended in between, rather than stepping or lagging by an hour. Both series share one time axis so they line up correctly; raw JSON available collapsed
- Precip wash is coloured by type (blue rain/drizzle, pale cyan snow, violet thunderstorm/hail) from `weathercode` — confirmed against the docs that weathercode is an *instant* reading (unlike probability, no hour-shift needed), so it's a plain "most recent known reading" lookup
- Chart has a fixed-height condition-icon strip at the top (one icon per 15-min slot — repeats within an hour since weathercode is hourly, honestly rather than fabricating finer detail), hour labels along the bottom (every hour, not every-other), and dual Y-axes: temperature on the left with "nice" round-number ticks, rain probability on the right (fixed 0/25/50/75/100% — that's what bar *height* encodes; type and intensity live in colour/opacity, not position). The old inline "16°" point labels were removed — redundant now that there's both an axis for general scale and a working hover tooltip for exact values
- Wash opacity scales with predicted intensity (`precipitation` in mm, fetched at 15-min resolution — also a *preceding-interval* field per the docs, same shift applied as probability) — height still means "how likely," opacity now means "how much," so a faint high-probability drizzle and a bold high-probability downpour no longer look identical
- Custom hover (dashed guide line, snapped highlight, floating tooltip) instead of native title-tooltips — same interaction pattern as Plotly/Yr, hand-rolled with no charting library
- "Ask" is wired to Chrome's built-in Gemini Nano (Prompt API) — on-device, no server. Edinburgh's 15-min temperature, 15-min rain amount (mm), hourly rain probability, and hourly conditions (type) for the rest of today are all baked into one persistent session's system prompt at creation time, so follow-up questions share context instead of starting fresh each time. The prompt also flags that probability and amount can genuinely disagree (a real forecast characteristic — see below), so the model doesn't treat it as an error when asked
- Each question runs as two turns in that session rather than one: first a short "what does this need, is it covered" unpacking step, then the answer — small on-device models do better at combining two data series into a judgment when made to state what's needed before answering, rather than jumping straight there
- The model is pre-warmed at page load when it's already downloaded; a "downloadable" state waits for your first Ask click to trigger anything, with real download-progress percentages shown rather than a page that just looks stuck
- Chat-style log under Ask: your question right-aligned, the model's reasoning step and answer left-aligned and visually distinct, status/error lines centered — every state transition (preparing, downloading, understanding, answering, error) visible instead of failing silently
- No build step, no dependencies — plain HTML/CSS/JS

## Roadmap

- [ ] Confirm the on-device chat actually works end-to-end in real desktop Chrome (last manual test found it not responding; logging added since should surface why)
- [ ] Revisit hourly vs. 15-minutely context comparison — dropped for now in favour of a single persistent 15-minutely session, worth re-adding once the core chat flow is confirmed solid
- [ ] Verified live: Edinburgh regularly shows ~90-100% rain probability alongside ~0.0mm predicted amount (and a non-rain weathercode). Likely explanation — probability comes from the ensemble (MOGREPS-UK), amount/conditions from the deterministic UKV run, so "confident forecast of a trace" is coherent, not a bug — but that's a reasoned inference, not a confirmed fact from Open-Meteo. A real answer needs the Previous Model Runs API (see below) to check calibration against actual outcomes
- [ ] Broaden the fetched fields further (feels-like temp, UV index, wind gusts) into the model context — needed before it can answer judgment-call questions ("is it worth a BBQ") rather than temperature/rain-only ones
- [ ] Extend the chart itself: wind band, multi-day view for weekend-scale questions, on-line weather icons
- [ ] Consider a location picker beyond Edinburgh

## Data notes

- Open-Meteo has no map/radar/tile imagery — point-location JSON only. For Edinburgh, the default `best_match` model resolves to the **UK Met Office's own UKV model (2km resolution)**, the best available option for this location, not a generic global grid.
- Historical **observed** data goes back to 1940 (reanalysis-based) via the Historical Weather API.
- Historical **forecast** data (what the model predicted, not what happened) is also available, separately: the **Previous Model Runs API** (`previous-runs-api.open-meteo.com`) returns past forecasts at fixed lead times (1-7 days ahead) via `_previous_dayN` suffixed variables — this is what a real probability-calibration check for Edinburgh would be built on, comparing predicted vs. observed rather than trusting either general model reputation or reasoned guesses.

## Stack

Static HTML/CSS/JS, deployed via GitHub Pages. No build step, no API key, no tracking.

`css/style.css` and `js/app.js` are linked with a `?v=N` query string in `index.html`. Bump `N` whenever either file changes — Safari caches GH Pages assets aggressively and won't otherwise pick up the update.

The footer's "Deployed" timestamp is hand-set in `index.html` on every push (no CI/build step for a repo this size) — update it to the current Europe/London time alongside whatever else changed in that commit.
