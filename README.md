# weather-interrogator

Short-term weather forecast for Edinburgh, pulled live from [Open-Meteo](https://open-meteo.com/) (no API key needed — safe for a static site). Raw JSON and a navigated view sit side by side, so the point of the tool is visible: same data, easier to use.

Live: _(added once GH Pages is enabled)_

## Why

Weather APIs return a wall of hourly arrays. Most questions people actually have ("do I need an umbrella," "is it worth a BBQ this weekend") only need a couple of those numbers, weighed together. This is a testbed for going from raw data to a useful answer.

## MVP (current)

- Fetch Open-Meteo's forecast endpoint for Edinburgh (current conditions + next 24h hourly)
- Display raw JSON and a formatted table side by side
- No LLM, no build step, no dependencies — plain HTML/CSS/JS

## Roadmap

- [ ] Wire up Chrome's built-in Gemini Nano to answer single-variable questions ("will it rain today") straight from the fetched data
- [ ] Extend to multi-variable judgment calls ("is it worth a BBQ this weekend") — the actual point of adding an LLM at all
- [ ] Consider a location picker beyond Edinburgh

## Stack

Static HTML/CSS/JS, deployed via GitHub Pages. No build step, no API key, no tracking.
