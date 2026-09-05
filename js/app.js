const EDINBURGH = { latitude: 55.9533, longitude: -3.1883 };

const FORECAST_URL = new URL("https://api.open-meteo.com/v1/forecast");
// Pinned to the explicit UK model rather than best_match: same grid cell,
// same values for every field that's genuinely UKV (confirmed identical
// lat/lon/elevation either way) -- but a field UKV can't provide (like
// precipitation_probability, which needs an ensemble UKV doesn't have)
// comes back null instead of best_match silently substituting a
// mismatched ~27km source and us displaying it as if it were local.
FORECAST_URL.search = new URLSearchParams({
  latitude: EDINBURGH.latitude,
  longitude: EDINBURGH.longitude,
  timezone: "Europe/London",
  forecast_days: "2",
  models: "ukmo_uk_deterministic_2km",
  current: "temperature_2m,weathercode,wind_speed_10m,precipitation",
  // wind_gusts_10m is a preceding-hour max (like probability/mm were) --
  // fetched hourly and shifted the same way. wind_speed_10m and
  // wind_direction_10m are instant, fetched at native 15-min resolution
  // via minutely_15 instead, no shift needed.
  hourly: "wind_gusts_10m",
  // weathercode confirmed genuinely 15-min resolution (derived per-timestep
  // from cloud_cover etc., not hourly-native) -- fetched here instead of
  // hourly so condition icons stop repeating a stale value 4x per hour.
  minutely_15: "temperature_2m,precipitation,wind_speed_10m,wind_direction_10m,weathercode",
});

let latestData = null; // most recent fetch, read by the ask handler when building model context

// WMO weather codes: https://open-meteo.com/en/docs -> "WMO Weather interpretation codes"
const WEATHER_CODES = {
  0: ["Clear sky", "☀️"],
  1: ["Mainly clear", "🌤️"],
  2: ["Partly cloudy", "⛅"],
  3: ["Overcast", "☁️"],
  45: ["Fog", "🌫️"],
  48: ["Depositing rime fog", "🌫️"],
  51: ["Light drizzle", "🌦️"],
  53: ["Moderate drizzle", "🌦️"],
  55: ["Dense drizzle", "🌧️"],
  56: ["Light freezing drizzle", "🌧️"],
  57: ["Dense freezing drizzle", "🌧️"],
  61: ["Slight rain", "🌧️"],
  63: ["Moderate rain", "🌧️"],
  65: ["Heavy rain", "🌧️"],
  66: ["Light freezing rain", "🌨️"],
  67: ["Heavy freezing rain", "🌨️"],
  71: ["Slight snow", "🌨️"],
  73: ["Moderate snow", "🌨️"],
  75: ["Heavy snow", "❄️"],
  77: ["Snow grains", "❄️"],
  80: ["Slight rain showers", "🌦️"],
  81: ["Moderate rain showers", "🌧️"],
  82: ["Violent rain showers", "⛈️"],
  85: ["Slight snow showers", "🌨️"],
  86: ["Heavy snow showers", "❄️"],
  95: ["Thunderstorm", "⛈️"],
  96: ["Thunderstorm, slight hail", "⛈️"],
  99: ["Thunderstorm, heavy hail", "⛈️"],
};

function describeCode(code) {
  return WEATHER_CODES[code] ?? [`Unknown (code ${code})`, "❓"];
}

const SNOW_CODES = new Set([71, 73, 75, 77, 85, 86]);
const STORM_CODES = new Set([95, 96, 99]);

function precipFamily(code) {
  if (STORM_CODES.has(code)) return "storm";
  if (SNOW_CODES.has(code)) return "snow";
  return "rain"; // default/majority case -- drizzle, rain, showers, and the no-precip codes all read as the existing blue
}

const DRIZZLE_CODES = new Set([51, 53, 55, 56, 57]);
const RAIN_CODES = new Set([61, 63, 65, 66, 67, 80, 81, 82]);

// Short single-word label for the model context -- separate from
// describeCode's fuller text, kept compact since this repeats once per
// hour in the prompt. Severity ("slight"/"heavy") is dropped here since
// the mm series already carries that; this is type only.
function conditionLabel(code) {
  if (STORM_CODES.has(code)) return "storm";
  if (SNOW_CODES.has(code)) return "snow";
  if (code === 45 || code === 48) return "fog";
  if (DRIZZLE_CODES.has(code)) return "drizzle";
  if (RAIN_CODES.has(code)) return "rain";
  return code === 0 ? "clear" : "cloudy";
}

function formatHour(isoTime) {
  const d = new Date(isoTime);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
}

function formatDayMonth(isoTime) {
  const d = new Date(isoTime);
  return d.toLocaleDateString("en-GB", { weekday: "short", day: "numeric", month: "short" });
}

const COMPASS_POINTS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
function compassLabel(deg) {
  return COMPASS_POINTS[Math.round(deg / 45) % 8];
}

function renderCurrent(data) {
  const [desc, icon] = describeCode(data.current.weathercode);
  const card = document.getElementById("current-card");
  card.innerHTML = `
    <span class="temp">${icon} ${Math.round(data.current.temperature_2m)}&deg;C</span>
    <span class="desc">${desc} &middot; wind ${Math.round(data.current.wind_speed_10m)} km/h</span>
  `;
}

const CHART = {
  width: 760,
  padLeft: 34, // room for the temperature axis (ticks + "16°" labels)
  padRight: 38, // room for the precip-probability axis (ticks + "100%" labels)
  topStripHeight: 30, // date, then hour labels
  plotHeight: 170, // main temp line + precip wash area
  axisLabelHeight: 30, // wind arrow + speed row at the bottom
};

// "Nice" round-number ticks (steps of 1/2/5/10) rather than ticks derived
// straight from the data's own min/max -- an axis should read in numbers a
// person would actually think in, not whatever the data happened to span.
function niceTemperatureTicks(min, max) {
  const range = max - min || 1;
  const rawStep = range / 4;
  const step = [1, 2, 5, 10].find((s) => s >= rawStep) || 10;
  const start = Math.ceil(min / step) * step;
  const ticks = [];
  for (let t = start; t <= max + 1e-9; t += step) ticks.push(Math.round(t));
  return ticks;
}

function remainingTodayIndices(times, now) {
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);

  const idxs = [];
  times.forEach((t, i) => {
    const ts = new Date(t);
    if (ts >= now && ts < midnight) idxs.push(i);
  });
  return idxs;
}

function renderTodayChart(data) {
  const wrap = document.getElementById("today-chart");
  const now = new Date(data.current.time);
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const spanMs = midnight - now;

  const tempIdxs = remainingTodayIndices(data.minutely_15.time, now);
  const precipIdxs = remainingTodayIndices(data.hourly.time, now);

  if (tempIdxs.length < 2) {
    wrap.innerHTML = `<p class="chart-empty">Not much of today left to chart &mdash; check back after midnight.</p>`;
    return;
  }

  // Axis bounds round to nice numbers rather than hugging the data exactly:
  // both bottom and top round to the nearest multiple of 10 (floor/ceil
  // respectively) around the data range (e.g. min 14 -> 10, max 19 -> 20).
  // Guards against the degenerate case where both round to the same value
  // (a flat day sitting exactly on a multiple of 10).
  const temps = tempIdxs.map((i) => data.minutely_15.temperature_2m[i]);
  const rawMin = Math.min(...temps);
  const rawMax = Math.max(...temps);
  const min = Math.floor(rawMin / 10) * 10;
  let max = Math.ceil(rawMax / 10) * 10;
  if (max <= min) max = min + 10;

  const { width, padLeft, padRight, topStripHeight, plotHeight, axisLabelHeight } = CHART;
  const plotWidth = width - padLeft - padRight;
  const plotTop = topStripHeight;
  const height = topStripHeight + plotHeight + axisLabelHeight;

  // Temperature (15-min) and precipitation (hourly) are different native
  // resolutions, so they're placed on one shared axis by actual elapsed
  // time rather than by array index -- that's what keeps a 14:15 point on
  // the line lining up under the right third of the 14:00-15:00 bar.
  const xForTime = (t) => padLeft + ((t - now) / spanMs) * plotWidth;
  const yTemp = (t) => plotTop + plotHeight - ((t - min) / (max - min)) * plotHeight;

  // precipitation (mm) at 15-min resolution also describes the *preceding*
  // interval (confirmed against the docs, same convention as the hourly
  // probability field) -- so the reading at minutely_15 index (idx+1) is
  // the one actually in force during this bar's slot, not index idx.
  const mmAt = (idx) => data.minutely_15.precipitation[idx + 1] ?? 0;

  const points = tempIdxs.map((idx) => ({
    idx,
    x: xForTime(new Date(data.minutely_15.time[idx])),
    yTemp: yTemp(data.minutely_15.temperature_2m[idx]),
    temp: data.minutely_15.temperature_2m[idx],
    time: data.minutely_15.time[idx],
    mm: mmAt(idx),
    windSpeed: data.minutely_15.wind_speed_10m[idx],
    windDir: data.minutely_15.wind_direction_10m[idx],
    code: data.minutely_15.weathercode[idx],
  }));

  const linePath = points.map((p) => `${p.x.toFixed(1)},${p.yTemp.toFixed(1)}`).join(" ");

  // Hour-mark positions for the bottom axis labels -- just time/x, no
  // probability attached (that field is gone; see the fetch config note).
  const precipPoints = precipIdxs.map((idx) => ({
    x: xForTime(new Date(data.hourly.time[idx])),
    time: data.hourly.time[idx],
  }));

  // Bar height is predicted amount (mm) directly rather than probability --
  // probability isn't fetched at all now (pinned to the UKV model, which
  // can't produce it; see the fetch config note). Amount is real UKV data,
  // 15-min native resolution, no shifting or interpolation needed. Ceiling
  // at 3mm/15min (~12mm/hr) is solidly "heavy rain" territory -- reaching
  // full height doesn't require an extreme event. Colour still carries
  // type (rain/snow/storm); opacity is now flat per type rather than a
  // second amount-encoding, since height alone already carries amount.
  const HEIGHT_MAX_MM = 3.0;

  const quarterMs = 15 * 60 * 1000;
  const barWidth = Math.max((quarterMs / spanMs) * plotWidth * 0.82, 3);
  const bars = points
    .map((p) => {
      const family = precipFamily(p.code);
      const barHeight = Math.min(p.mm / HEIGHT_MAX_MM, 1) * plotHeight;
      const y = plotTop + plotHeight - barHeight;
      return `<rect x="${(p.x - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.5" class="precip-bar precip-${family}"><title>${formatHour(p.time)} — ${p.mm.toFixed(1)}mm, ${describeCode(p.code)[0].toLowerCase()}</title></rect>`;
    })
    .join("");

  // Hour labels: moved to the top, matching the usual chart convention
  // (time axis reads top-to-bottom-then-across, not buried at the bottom).
  // Date shown once on its own line above -- the chart only ever spans a
  // single calendar day, and prefixing it onto the first hour label
  // collided with the next one (the date string is wider than the gap
  // between hourly ticks).
  const dateLabel = precipPoints.length
    ? `<text x="${padLeft}" y="10" class="chart-axis-label" text-anchor="start">${formatDayMonth(precipPoints[0].time)}</text>`
    : "";
  const hourLabels = precipPoints
    .map((p) => `<text x="${p.x.toFixed(1)}" y="22" class="chart-axis-label" text-anchor="middle">${formatHour(p.time)}</text>`)
    .join("");

  // Icons ride the temperature line (Yr-style), one per 15-min point --
  // back to full resolution after trying the thinned version.
  const conditionIcons = points
    .map((p) => {
      const icon = describeCode(p.code)[1];
      const y = Math.max(p.yTemp - 12, 10);
      return `<text x="${p.x.toFixed(1)}" y="${y.toFixed(1)}" class="chart-icon-label" text-anchor="middle">${icon}</text>`;
    })
    .join("");

  // Wind row: arrow (direction) + speed number, back at the bottom -- after
  // trying a single size-scaled glyph, the explicit number reads clearer.
  // Arrow points in the direction wind is blowing *toward* (direction+180,
  // since wind_direction_10m is meteorological convention -- the direction
  // it's blowing *from*).
  const windRow = points
    .map((p) => {
      const rotation = (p.windDir + 180) % 360;
      const y1 = plotTop + plotHeight + 12;
      const y2 = plotTop + plotHeight + 24;
      return (
        `<text x="${p.x.toFixed(1)}" y="${y1.toFixed(1)}" class="chart-wind-arrow" text-anchor="middle" transform="rotate(${rotation.toFixed(0)}, ${p.x.toFixed(1)}, ${(y1 - 3).toFixed(1)})">&uarr;</text>` +
        `<text x="${p.x.toFixed(1)}" y="${y2.toFixed(1)}" class="chart-wind-speed" text-anchor="middle">${Math.round(p.windSpeed)}</text>`
      );
    })
    .join("");

  // Temperature axis (left): "nice" round-number ticks, not raw data
  // extremes. Precip axis (right): fixed mm ticks matching HEIGHT_MAX_MM --
  // that's what bar *height* now encodes; type (colour) isn't positional,
  // so it doesn't need an axis.
  const tempAxis = niceTemperatureTicks(min, max)
    .map((tv) => {
      const ty = yTemp(tv);
      return (
        `<line x1="${(padLeft - 4).toFixed(1)}" x2="${padLeft}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="axis-tick" />` +
        `<text x="${(padLeft - 7).toFixed(1)}" y="${(ty + 3).toFixed(1)}" class="axis-tick-label" text-anchor="end">${tv}&deg;</text>`
      );
    })
    .join("");

  const precipAxis = [0, 1, 2, 3]
    .map((tv) => {
      const ty = plotTop + plotHeight - (tv / HEIGHT_MAX_MM) * plotHeight;
      const xRight = padLeft + plotWidth;
      return (
        `<line x1="${xRight}" x2="${(xRight + 4).toFixed(1)}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="axis-tick" />` +
        `<text x="${(xRight + 7).toFixed(1)}" y="${(ty + 3).toFixed(1)}" class="axis-tick-label" text-anchor="start">${tv}mm</text>`
      );
    })
    .join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Temperature and rainfall for the rest of today">
      <g class="precip-band">${bars}</g>
      <polyline points="${linePath}" class="chart-line" fill="none" />
      ${conditionIcons}
      ${windRow}
      ${dateLabel}
      ${hourLabels}
      ${tempAxis}
      ${precipAxis}
      <line class="hover-guide" x1="0" x2="0" y1="${plotTop}" y2="${plotTop + plotHeight}" />
      <circle class="hover-dot" r="5" cx="0" cy="0" />
      <rect class="chart-hit-area" x="${padLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" fill="transparent" />
    </svg>
  `;

  attachChartHover(wrap, points);
}

function attachChartHover(wrap, points) {
  const svg = wrap.querySelector(".chart-svg");
  const guide = svg.querySelector(".hover-guide");
  const hoverDot = svg.querySelector(".hover-dot");
  const hitArea = svg.querySelector(".chart-hit-area");
  const tooltip = getChartTooltip();

  function nearestPoint(svgX) {
    let nearest = points[0];
    let minDist = Infinity;
    for (const p of points) {
      const d = Math.abs(p.x - svgX);
      if (d < minDist) {
        minDist = d;
        nearest = p;
      }
    }
    return nearest;
  }

  function onMove(evt) {
    const rect = svg.getBoundingClientRect();
    const scale = CHART.width / rect.width;
    const svgX = (evt.clientX - rect.left) * scale;
    const p = nearestPoint(svgX);
    const [desc, icon] = describeCode(p.code);

    guide.setAttribute("x1", p.x);
    guide.setAttribute("x2", p.x);
    guide.classList.add("visible");

    hoverDot.setAttribute("cx", p.x);
    hoverDot.setAttribute("cy", p.yTemp);
    hoverDot.classList.add("visible");

    tooltip.innerHTML = `<strong>${Math.round(p.temp * 10) / 10}&deg;C</strong> at ${formatHour(p.time)}<br>${p.mm.toFixed(1)}mm &middot; ${icon} ${desc.toLowerCase()}<br>${Math.round(p.windSpeed)}km/h from ${compassLabel(p.windDir)}`;
    tooltip.classList.add("visible");

    const screenX = rect.left + p.x / scale;
    const screenY = rect.top + p.yTemp / scale;
    tooltip.style.left = `${screenX}px`;
    tooltip.style.top = `${screenY - 10}px`;
  }

  function onLeave() {
    guide.classList.remove("visible");
    hoverDot.classList.remove("visible");
    tooltip.classList.remove("visible");
  }

  hitArea.addEventListener("pointermove", onMove);
  hitArea.addEventListener("pointerleave", onLeave);
}

function getChartTooltip() {
  let tooltip = document.getElementById("chart-tooltip");
  if (!tooltip) {
    tooltip = document.createElement("div");
    tooltip.id = "chart-tooltip";
    tooltip.className = "chart-tooltip";
    document.body.appendChild(tooltip);
  }
  return tooltip;
}

function renderRaw(data) {
  document.getElementById("raw-output").textContent = JSON.stringify(data, null, 2);
}

async function loadForecast() {
  const statusEl = document.getElementById("status");
  try {
    const res = await fetch(FORECAST_URL);
    if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
    const data = await res.json();
    latestData = data;

    renderRaw(data);
    renderCurrent(data);
    renderTodayChart(data);

    statusEl.textContent = `Updated ${new Date().toLocaleTimeString("en-GB")} — Edinburgh (${data.latitude.toFixed(2)}, ${data.longitude.toFixed(2)})`;
    return data;
  } catch (err) {
    statusEl.textContent = `Failed to load forecast: ${err.message}`;
    statusEl.classList.add("error");
    throw err;
  }
}

const WEATHER_SYSTEM_PROMPT = `Weather assistant for Edinburgh. Use only the data below, don't invent numbers. Temperature, rain amount, and wind (speed+direction) are readings every 15 minutes; wind gusts and conditions are hourly. No rain-probability figure is provided (deliberately — the available one wasn't locally reliable), no other days — say so if asked. Keep answers to 1-2 sentences.`;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

function buildWeatherContext(data) {
  const now = new Date(data.current.time);
  const [desc] = describeCode(data.current.weathercode);

  const tempIdxs = remainingTodayIndices(data.minutely_15.time, now);
  const tempSeries = tempIdxs
    .map((i) => `${formatHour(data.minutely_15.time[i])}=${data.minutely_15.temperature_2m[i].toFixed(1)}`)
    .join(",");

  // Same preceding-interval shift as the chart: the reading at index i+1
  // is the one actually in force during the slot at index i.
  const mmSeries = tempIdxs
    .map((i) => `${formatHour(data.minutely_15.time[i])}=${(data.minutely_15.precipitation[i + 1] ?? 0).toFixed(1)}`)
    .join(",");

  const windSeries = tempIdxs
    .map((i) => `${formatHour(data.minutely_15.time[i])}=${Math.round(data.minutely_15.wind_speed_10m[i])}${compassLabel(data.minutely_15.wind_direction_10m[i])}`)
    .join(",");

  const precipIdxs = remainingTodayIndices(data.hourly.time, now);
  // weathercode moved to minutely_15 (see fetch config) -- kept at hourly
  // cadence here to match the on-the-hour marks the rest of this series
  // set uses, not to blow up the prompt to 15-min granularity for every
  // field.
  const conditionSeries = precipIdxs
    .map((i) => {
      const mIdx = data.minutely_15.time.indexOf(data.hourly.time[i]);
      return `${formatHour(data.hourly.time[i])}=${conditionLabel(data.minutely_15.weathercode[mIdx])}`;
    })
    .join(",");

  // wind_gusts_10m is a preceding-hour max, same convention precipitation_
  // probability had -- shifted back one position so the reading lines up
  // with the hour it's actually in force for, not the hour it's filed
  // under.
  const gustSeries = precipIdxs
    .map((i) => `${formatHour(data.hourly.time[i])}=${Math.round(data.hourly.wind_gusts_10m[i + 1])}`)
    .join(",");

  return [
    `Current: ${data.current.temperature_2m.toFixed(1)}C, ${desc.toLowerCase()}, wind ${Math.round(data.current.wind_speed_10m)}km/h.`,
    `Temp forecast today (15-min, HH:MM=C): ${tempSeries}`,
    `Rain amount today (15-min mm, HH:MM=mm): ${mmSeries}`,
    `Wind today (15-min, HH:MM=km/h+direction): ${windSeries}`,
    `Wind gusts today (hourly peak km/h, HH:MM=km/h): ${gustSeries}`,
    `Conditions today (hourly, HH:MM=type): ${conditionSeries}`,
  ].join(" ");
}

// --- Model loading -------------------------------------------------------
// One session, created once, with the weather data baked into its system
// prompt so it doesn't need re-sending on every question — kept alive so
// follow-ups share context instead of starting fresh each time. Mirrors
// chrome-chat's policy of only auto-creating at startup when the model is
// already downloaded (never a silent download); a "downloadable" state
// still lets Ask be clicked, and that click is what triggers the download,
// with progress reported rather than a page that just looks stuck.

let forecastPromise = null;
let chatSession = null; // Promise<session> | null, persistent once created
let promptOk = false;

function setStatusPill(className, text, pillId = "model-status-pill") {
  const pill = document.getElementById(pillId);
  pill.className = `stub-badge ${className}`;
  pill.textContent = text;
}

function logEntry(kind, text, logId = "ask-log") {
  const log = document.getElementById(logId);
  const p = document.createElement("p");
  p.className = `log-entry log-${kind}`;
  p.textContent = text;
  log.appendChild(p);
  log.scrollTop = log.scrollHeight;
  return p;
}

async function checkModelCapability() {
  if (!self.LanguageModel) {
    setStatusPill("missing", "not in this browser");
    return;
  }

  try {
    const availability = await withTimeout(LanguageModel.availability(), 5000);
    promptOk = availability !== "unavailable";
    setStatusPill(availability, availability === "downloadable" ? "needs download" : availability);

    if (availability === "available") {
      ensureChatSession(); // fire and forget: warms the model before anyone's asked anything
    }
  } catch (err) {
    setStatusPill("unavailable", `error: ${err.message}`);
  }

  document.getElementById("ask-submit").disabled = !promptOk;
}

function ensureChatSession() {
  if (chatSession) return chatSession;

  chatSession = (async () => {
    setStatusPill("preparing", "preparing model…");
    const data = await forecastPromise;
    const systemPrompt = `${WEATHER_SYSTEM_PROMPT}\n\n${buildWeatherContext(data)}`;

    const session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: systemPrompt }],
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const pct = Math.round(e.loaded * 100);
          setStatusPill("preparing", `downloading model… ${pct}%`);
          logEntry("status", `Downloading model… ${pct}%`);
        });
      },
    });

    setStatusPill("available", "ready");
    return session;
  })();

  // Allow retrying: a failed creation shouldn't permanently wedge the app.
  chatSession.catch(() => { chatSession = null; });

  return chatSession;
}

function setupAsk() {
  const form = document.getElementById("ask-form");
  const input = document.getElementById("ask-input");
  const submitBtn = document.getElementById("ask-submit");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question) return;

    input.value = "";
    logEntry("question", question);
    submitBtn.disabled = true;

    try {
      const session = await ensureChatSession();

      // Two turns rather than one: a small on-device model does better at
      // combining two separate data series (temp + rain%) into a judgment
      // when it's first made to say what the question actually needs and
      // whether that's covered, instead of jumping straight to an answer.
      // Both turns land in the same session, so the answer turn has the
      // unpacking already in its own context for free.
      logEntry("status", "Understanding question…");
      const unpack = await session.prompt(
        `Before answering, in one short line: what data does this question need, and is it covered above? Question: "${question}"`
      );
      logEntry("reasoning", unpack);

      logEntry("status", "Answering…");
      const answer = await session.prompt(`Now answer in 1-2 sentences using that.`);
      logEntry("answer", answer);
    } catch (err) {
      logEntry("error", `Error: ${err.message}`);
    } finally {
      submitBtn.disabled = !promptOk;
    }
  });
}

// --- Webcam weather detector (v1) ----------------------------------------
// Point a camera outside, grab one frame, ask the on-device model what it
// thinks the weather is. No comparison to the forecast yet -- that's the
// obvious next step once this works reliably on its own.

const WEBCAM_SYSTEM_PROMPT = `You are shown a single photo taken from a webcam pointed outdoors. Describe the weather you can see: sky condition, whether it looks like it's raining or snowing, and roughly how bright/overcast it is. If the image doesn't show anything useful (e.g. pointed indoors, too dark, unclear), say so plainly instead of guessing. Keep it to 1-2 sentences.`;

let webcamStream = null;
let webcamSession = null; // Promise<session> | null, separate from the text-only Ask session (different expectedInputs)
let webcamPromptOk = false;
let webcamCameraOn = false;

async function checkWebcamCapability() {
  if (!self.LanguageModel) {
    setStatusPill("missing", "not in this browser", "webcam-status-pill");
    return;
  }
  try {
    const availability = await withTimeout(LanguageModel.availability({ expectedInputs: [{ type: "image" }] }), 5000);
    webcamPromptOk = availability !== "unavailable";
    setStatusPill(availability, availability === "downloadable" ? "needs download" : availability, "webcam-status-pill");
  } catch (err) {
    setStatusPill("unavailable", `error: ${err.message}`, "webcam-status-pill");
  }
  document.getElementById("webcam-capture").disabled = !(webcamPromptOk && webcamCameraOn);
}

function ensureWebcamSession() {
  if (webcamSession) return webcamSession;

  webcamSession = (async () => {
    setStatusPill("preparing", "preparing model…", "webcam-status-pill");

    const session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: WEBCAM_SYSTEM_PROMPT }],
      expectedInputs: [{ type: "text" }, { type: "image" }],
      monitor(m) {
        m.addEventListener("downloadprogress", (e) => {
          const pct = Math.round(e.loaded * 100);
          setStatusPill("preparing", `downloading model… ${pct}%`, "webcam-status-pill");
          logEntry("status", `Downloading model… ${pct}%`, "webcam-log");
        });
      },
    });

    setStatusPill("available", "ready", "webcam-status-pill");
    return session;
  })();

  webcamSession.catch(() => { webcamSession = null; });

  return webcamSession;
}

async function startWebcam() {
  const video = document.getElementById("webcam-video");
  const startBtn = document.getElementById("webcam-start");
  const captureBtn = document.getElementById("webcam-capture");

  startBtn.disabled = true;
  try {
    webcamStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
    video.srcObject = webcamStream;
    startBtn.textContent = "Stop camera";
    webcamCameraOn = true;
    captureBtn.disabled = !webcamPromptOk;
    logEntry("status", "Camera started. Point it out of a window, then ask.", "webcam-log");
  } catch (err) {
    logEntry("error", `Couldn't start camera: ${err.message}`, "webcam-log");
  } finally {
    startBtn.disabled = false;
  }
}

function stopWebcam() {
  const video = document.getElementById("webcam-video");
  const startBtn = document.getElementById("webcam-start");
  const captureBtn = document.getElementById("webcam-capture");

  webcamStream.getTracks().forEach((track) => track.stop());
  webcamStream = null;
  video.srcObject = null;
  startBtn.textContent = "Start camera";
  webcamCameraOn = false;
  captureBtn.disabled = true;
  logEntry("status", "Camera stopped.", "webcam-log");
}

function captureFrameAsBlob() {
  const video = document.getElementById("webcam-video");
  const canvas = document.getElementById("webcam-canvas");
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext("2d").drawImage(video, 0, 0, canvas.width, canvas.height);
  return new Promise((resolve) => canvas.toBlob(resolve, "image/jpeg", 0.85));
}

function setupWebcam() {
  document.getElementById("webcam-start").addEventListener("click", () => {
    if (webcamCameraOn) stopWebcam();
    else startWebcam();
  });

  document.getElementById("webcam-capture").addEventListener("click", async () => {
    const captureBtn = document.getElementById("webcam-capture");
    captureBtn.disabled = true;

    try {
      const frame = await captureFrameAsBlob();
      if (!frame) throw new Error("couldn't capture a frame");

      logEntry("status", "Looking…", "webcam-log");
      const session = await ensureWebcamSession();
      const answer = await session.prompt([
        {
          role: "user",
          content: [
            { type: "text", value: "What's the weather like in this image?" },
            { type: "image", value: frame },
          ],
        },
      ]);
      logEntry("answer", answer, "webcam-log");
    } catch (err) {
      logEntry("error", `Error: ${err.message}`, "webcam-log");
    } finally {
      captureBtn.disabled = !webcamPromptOk;
    }
  });
}

setupAsk();
checkModelCapability();
forecastPromise = loadForecast();

setupWebcam();
checkWebcamCapability();
