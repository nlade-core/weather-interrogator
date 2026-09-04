# weather-interrogator

Short-term weather forecast for Edinburgh, pulled live from [Open-Meteo](https://open-meteo.com/) (no API key needed — safe for a static site). A chart navigates the raw hourly data into something readable; the raw JSON is still there, collapsed, for anyone who wants to check the tool's working.

Live: https://nlade-core.github.io/weather-interrogator/

## Why

Weather APIs return a wall of hourly arrays. Most questions people actually have ("do I need an umbrella," "is it worth a BBQ this weekend") only need a couple of those numbers, weighed together. This is a testbed for going from raw data to a useful answer.

## MVP (current)

- Fetch Open-Meteo's forecast endpoint for Edinburgh (current conditions + hourly through midnight)
- Chart temperature and rain chance for the rest of today; raw JSON available collapsed
- "Ask" box reserves the layout for the LLM step — currently a stub that returns a canned response, no model wired up
- No build step, no dependencies — plain HTML/CSS/JS

## Roadmap

- [ ] Broaden the fetched fields (feels-like temp, UV index, wind gusts, precipitation in mm) — needed before the LLM step can answer judgment-call questions properly
- [ ] Wire up Chrome's built-in Gemini Nano in place of the "Ask" stub, starting with single-variable questions ("will it rain today")
- [ ] Extend to multi-variable judgment calls ("is it worth a BBQ this weekend") — the actual point of adding an LLM at all
- [ ] Daily summary view (multi-day, not just today) for weekend-scale questions
- [ ] Consider a location picker beyond Edinburgh

## Stack

Static HTML/CSS/JS, deployed via GitHub Pages. No build step, no API key, no tracking.

`css/style.css` and `js/app.js` are linked with a `?v=N` query string in `index.html`. Bump `N` whenever either file changes — Safari caches GH Pages assets aggressively and won't otherwise pick up the update.
