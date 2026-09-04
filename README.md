# weather-interrogator

Short-term weather forecast for Edinburgh, pulled live from [Open-Meteo](https://open-meteo.com/) (no API key needed — safe for a static site). A chart navigates the raw hourly data into something readable; the raw JSON is still there, collapsed, for anyone who wants to check the tool's working.

Live: https://nlade-core.github.io/weather-interrogator/

## Why

Weather APIs return a wall of hourly arrays. Most questions people actually have ("do I need an umbrella," "is it worth a BBQ this weekend") only need a couple of those numbers, weighed together. This is a testbed for going from raw data to a useful answer.

## MVP (current)

- Fetch Open-Meteo's forecast endpoint for Edinburgh: current conditions, hourly, and 15-minutely temperature through midnight
- Chart shows temperature at 15-minute resolution (a visibly smoother, more precise line than hourly) with a rain-probability bar strip underneath, Apple Weather-style solid blocks at 15-min granularity (holding each hour's value — that's the real native resolution, no finer probability data exists); both series share one time axis so they line up correctly; raw JSON available collapsed
- Custom hover (dashed guide line, snapped highlight, floating tooltip) instead of native title-tooltips — same interaction pattern as Plotly/Yr, hand-rolled with no charting library
- "Ask" is wired to Chrome's built-in Gemini Nano (Prompt API) — on-device, no server. Edinburgh's 15-minute temperature forecast and hourly rain probability for the rest of today are baked into one persistent session's system prompt at creation time, so follow-up questions share context instead of starting fresh each time
- The model is pre-warmed at page load when it's already downloaded; a "downloadable" state waits for your first Ask click to trigger anything, with real download-progress percentages shown rather than a page that just looks stuck
- A visible log (status pill + a running log under Ask) surfaces every state transition — preparing, downloading, thinking, error — instead of failing silently
- No build step, no dependencies — plain HTML/CSS/JS

## Roadmap

- [ ] Confirm the on-device chat actually works end-to-end in real desktop Chrome (last manual test found it not responding; logging added since should surface why)
- [ ] Revisit hourly vs. 15-minutely context comparison — dropped for now in favour of a single persistent 15-minutely session, worth re-adding once the core chat flow is confirmed solid
- [ ] Precipitation severity/intensity (mm, from `precipitation`/`rain`/`showers`/`snowfall`) — deliberately deferred this iteration; probability is in, intensity and type (rain vs. snow vs. hail, via `weathercode`) are next
- [ ] Broaden the fetched fields further (feels-like temp, UV index, wind gusts) into the model context — needed before it can answer judgment-call questions ("is it worth a BBQ") rather than temperature/rain-only ones
- [ ] Extend the chart itself: wind band, multi-day view for weekend-scale questions, on-line weather icons
- [ ] Consider a location picker beyond Edinburgh

## Stack

Static HTML/CSS/JS, deployed via GitHub Pages. No build step, no API key, no tracking.

`css/style.css` and `js/app.js` are linked with a `?v=N` query string in `index.html`. Bump `N` whenever either file changes — Safari caches GH Pages assets aggressively and won't otherwise pick up the update.

The footer's "Deployed" timestamp is hand-set in `index.html` on every push (no CI/build step for a repo this size) — update it to the current Europe/London time alongside whatever else changed in that commit.
