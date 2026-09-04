# weather-interrogator

Short-term weather forecast for Edinburgh, pulled live from [Open-Meteo](https://open-meteo.com/) (no API key needed — safe for a static site). A chart navigates the raw hourly data into something readable; the raw JSON is still there, collapsed, for anyone who wants to check the tool's working.

Live: https://nlade-core.github.io/weather-interrogator/

## Why

Weather APIs return a wall of hourly arrays. Most questions people actually have ("do I need an umbrella," "is it worth a BBQ this weekend") only need a couple of those numbers, weighed together. This is a testbed for going from raw data to a useful answer.

## MVP (current)

- Fetch Open-Meteo's forecast endpoint for Edinburgh: current conditions, hourly, and 15-minutely temperature through midnight
- Chart temperature and rain chance for the rest of today (hourly); raw JSON available collapsed
- "Ask" box is wired to Chrome's built-in Gemini Nano (Prompt API) — on-device, no server. The model is pre-warmed at page load when it's already downloaded, rather than waiting for the first question
- A granularity toggle lets you manually compare answers built from hourly vs. 15-minutely temperature context for the same question
- No build step, no dependencies — plain HTML/CSS/JS

## Roadmap

- [ ] Compare hourly vs. 15-minutely context quality across a few real questions, decide which becomes the default (or whether it should switch per question type)
- [ ] Broaden the fetched fields (feels-like temp, UV index, wind gusts, precipitation in mm) into the model context — needed before it can answer judgment-call questions ("is it worth a BBQ") rather than temperature-only ones
- [ ] Extend the chart itself: wind band, multi-day view for weekend-scale questions, on-line weather icons
- [ ] Consider a location picker beyond Edinburgh

## Stack

Static HTML/CSS/JS, deployed via GitHub Pages. No build step, no API key, no tracking.

`css/style.css` and `js/app.js` are linked with a `?v=N` query string in `index.html`. Bump `N` whenever either file changes — Safari caches GH Pages assets aggressively and won't otherwise pick up the update.
