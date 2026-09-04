const EDINBURGH = { latitude: 55.9533, longitude: -3.1883 };

const FORECAST_URL = new URL("https://api.open-meteo.com/v1/forecast");
FORECAST_URL.search = new URLSearchParams({
  latitude: EDINBURGH.latitude,
  longitude: EDINBURGH.longitude,
  timezone: "Europe/London",
  forecast_days: "2",
  current: "temperature_2m,weathercode,wind_speed_10m,precipitation",
  hourly: "temperature_2m,precipitation_probability,weathercode,windspeed_10m",
  minutely_15: "temperature_2m,precipitation",
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

// weathercode is an instant reading at its own timestamp (confirmed against
// the docs -- unlike precipitation_probability, it needs no hour shift), so
// this is a plain "most recent known reading" lookup, not interpolation.
function weathercodeAt(hourlyTime, hourlyCodes, time) {
  let code = hourlyCodes[0];
  for (let i = 0; i < hourlyTime.length; i++) {
    if (new Date(hourlyTime[i]) <= time) code = hourlyCodes[i];
    else break;
  }
  return code;
}

function formatHour(isoTime) {
  const d = new Date(isoTime);
  return d.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
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
  iconRowHeight: 22, // fixed-height strip at the top for condition icons
  plotHeight: 170, // main temp line + precip wash area
  axisLabelHeight: 24, // bottom strip for hour labels
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

const PRECIP_AXIS_TICKS = [0, 25, 50, 75, 100];

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

  const temps = tempIdxs.map((i) => data.minutely_15.temperature_2m[i]);
  const rawMin = Math.min(...temps);
  const rawMax = Math.max(...temps);
  const min = rawMin === rawMax ? rawMin - 1 : rawMin;
  const max = rawMin === rawMax ? rawMax + 1 : rawMax;

  const { width, padLeft, padRight, iconRowHeight, plotHeight, axisLabelHeight } = CHART;
  const plotWidth = width - padLeft - padRight;
  const plotTop = iconRowHeight;
  const height = iconRowHeight + plotHeight + axisLabelHeight;

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
  }));

  const linePath = points.map((p) => `${p.x.toFixed(1)},${p.yTemp.toFixed(1)}`).join(" ");

  // Hourly probability values, kept as-is for the hover tooltip lookup --
  // this is the real native resolution, no finer probability data exists.
  const precipPoints = precipIdxs.map((idx) => ({
    x: xForTime(new Date(data.hourly.time[idx])),
    precip: data.hourly.precipitation_probability[idx],
    time: data.hourly.time[idx],
  }));

  // precipitation_probability describes the *preceding* hour (confirmed
  // against Open-Meteo's docs) -- so the reading filed under "15:00"
  // describes the window (14:00, 15:00], meaning it's the one actually in
  // force at, say, 14:20, not the "14:00" reading (which describes the
  // already-finished (13:00, 14:00]). Shift every reading back by one
  // hour position before interpolating, so hour-mark anchors line up with
  // what's upcoming rather than what just finished.
  const shiftedTime = data.hourly.time.slice(0, -1);
  const shiftedPrecip = data.hourly.precipitation_probability.slice(1);

  // Height = probability (how likely), colour = type (rain/snow/storm),
  // opacity = intensity (how much, in mm) -- three independent channels
  // rather than conflating "likely" and "heavy" into one. Floor keeps a
  // high-probability-but-negligible-amount slot faintly visible instead
  // of invisible; ceiling is reached around 2mm/15min (~8mm/hr, solidly
  // "heavy rain" territory) so it doesn't take an extreme event to read
  // as bold.
  const OPACITY_FLOOR = 0.12;
  const OPACITY_CEILING = 0.85;
  const HEAVY_MM = 2.0;
  const opacityForMm = (mm) => {
    const fraction = Math.min(mm / HEAVY_MM, 1);
    return OPACITY_FLOOR + fraction * (OPACITY_CEILING - OPACITY_FLOOR);
  };

  // Apple-style: precip is a faded wash behind the temperature line rather
  // than a separate band -- bar height is probability against the full
  // plot height (100% reaches the top). One bar per 15-min slot (matching
  // the temp line's grid), height linearly interpolated between the two
  // bracketing (shifted) hourly readings so it ramps smoothly rather than
  // stepping.
  const quarterMs = 15 * 60 * 1000;
  const barWidth = Math.max((quarterMs / spanMs) * plotWidth * 0.82, 3);
  const bars = points
    .map((p) => {
      const t = new Date(p.time);
      const prob = interpolateHourly(shiftedTime, shiftedPrecip, t);
      const code = weathercodeAt(data.hourly.time, data.hourly.weathercode, t);
      const family = precipFamily(code);
      const opacity = opacityForMm(p.mm);
      const barHeight = (prob / 100) * plotHeight;
      const y = plotTop + plotHeight - barHeight;
      return `<rect x="${(p.x - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.5" fill-opacity="${opacity.toFixed(2)}" class="precip-bar precip-${family}"><title>${formatHour(p.time)} — ${Math.round(prob)}% chance, ${p.mm.toFixed(1)}mm, ${describeCode(code)[0].toLowerCase()} (smoothed)</title></rect>`;
    })
    .join("");

  // Hour labels: every hour, along the bottom -- this is the dedicated
  // axis strip now that icons have moved elsewhere, so there's room.
  const hourLabels = precipPoints
    .map((p) => `<text x="${p.x.toFixed(1)}" y="${(plotTop + plotHeight + 18).toFixed(1)}" class="chart-axis-label" text-anchor="middle">${formatHour(p.time)}</text>`)
    .join("");

  // Condition icons: every 15-min point, in a fixed-height strip at the
  // top rather than riding the line -- a fixed y avoids the clipping a
  // line-following position would hit near peaks (same issue the old
  // temp-value labels had), and keeps this row clear of the now-denser
  // hourly axis labels below. weathercode is hourly, so the icon repeats
  // up to 4x within an hour rather than fabricating 15-min detail that
  // doesn't exist -- that repetition is honest, not a bug.
  const conditionIcons = points
    .map((p) => {
      const code = weathercodeAt(data.hourly.time, data.hourly.weathercode, new Date(p.time));
      const icon = describeCode(code)[1];
      return `<text x="${p.x.toFixed(1)}" y="${(iconRowHeight - 6).toFixed(1)}" class="chart-icon-label" text-anchor="middle">${icon}</text>`;
    })
    .join("");

  // Temperature axis (left): "nice" round-number ticks, not raw data
  // extremes. Precip axis (right): fixed 0/25/50/75/100% -- that's what
  // bar *height* encodes; type (colour) and intensity (opacity) aren't
  // positional, so they don't need an axis.
  const tempAxis = niceTemperatureTicks(min, max)
    .map((tv) => {
      const ty = yTemp(tv);
      return (
        `<line x1="${(padLeft - 4).toFixed(1)}" x2="${padLeft}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="axis-tick" />` +
        `<text x="${(padLeft - 7).toFixed(1)}" y="${(ty + 3).toFixed(1)}" class="axis-tick-label" text-anchor="end">${tv}&deg;</text>`
      );
    })
    .join("");

  const precipAxis = PRECIP_AXIS_TICKS
    .map((tv) => {
      const ty = plotTop + plotHeight - (tv / 100) * plotHeight;
      const xRight = padLeft + plotWidth;
      return (
        `<line x1="${xRight}" x2="${(xRight + 4).toFixed(1)}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="axis-tick" />` +
        `<text x="${(xRight + 7).toFixed(1)}" y="${(ty + 3).toFixed(1)}" class="axis-tick-label" text-anchor="start">${tv}%</text>`
      );
    })
    .join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Temperature and rain chance for the rest of today">
      <g class="precip-band">${bars}</g>
      <polyline points="${linePath}" class="chart-line" fill="none" />
      ${conditionIcons}
      ${hourLabels}
      ${tempAxis}
      ${precipAxis}
      <line class="hover-guide" x1="0" x2="0" y1="${plotTop}" y2="${plotTop + plotHeight}" />
      <circle class="hover-dot" r="5" cx="0" cy="0" />
      <rect class="chart-hit-area" x="${padLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" fill="transparent" />
    </svg>
  `;

  attachChartHover(wrap, points, shiftedTime, shiftedPrecip, data.hourly.time, data.hourly.weathercode);
}

// Hourly readings are point samples, not step functions -- linearly
// interpolating between the two bracketing hours gives a continuous
// value with no fabricated precision beyond "assume uniform change
// between two known readings," the same treatment already implicit in
// drawing straight line segments between the temperature points.
function interpolateHourly(hourlyTime, hourlyValues, time) {
  const t = time.getTime();
  const first = new Date(hourlyTime[0]).getTime();
  if (t <= first) return hourlyValues[0];

  for (let i = 0; i < hourlyTime.length - 1; i++) {
    const t0 = new Date(hourlyTime[i]).getTime();
    const t1 = new Date(hourlyTime[i + 1]).getTime();
    if (t >= t0 && t <= t1) {
      const frac = (t - t0) / (t1 - t0);
      return hourlyValues[i] + frac * (hourlyValues[i + 1] - hourlyValues[i]);
    }
  }
  return hourlyValues[hourlyValues.length - 1];
}

function attachChartHover(wrap, points, hourlyTime, hourlyPrecip, rawHourlyTime, hourlyCodes) {
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
    const t = new Date(p.time);
    const precip = Math.round(interpolateHourly(hourlyTime, hourlyPrecip, t));
    const code = weathercodeAt(rawHourlyTime, hourlyCodes, t);
    const [desc, icon] = describeCode(code);

    guide.setAttribute("x1", p.x);
    guide.setAttribute("x2", p.x);
    guide.classList.add("visible");

    hoverDot.setAttribute("cx", p.x);
    hoverDot.setAttribute("cy", p.yTemp);
    hoverDot.classList.add("visible");

    tooltip.innerHTML = `<strong>${Math.round(p.temp * 10) / 10}&deg;C</strong> at ${formatHour(p.time)}<br>${precip}% chance, ${p.mm.toFixed(1)}mm &middot; ${icon} ${desc.toLowerCase()}`;
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

const WEATHER_SYSTEM_PROMPT = `Weather assistant for Edinburgh. Use only the data below, don't invent numbers. Temperature and rain amount (mm) are readings every 15 minutes; rain probability and conditions are hourly (no wind, no other days — say so if asked). Probability and amount can genuinely disagree (e.g. high probability of a trace amount) — that's a real forecast characteristic, not an error, so don't treat it as contradictory. Keep answers to 1-2 sentences.`;

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

  const precipIdxs = remainingTodayIndices(data.hourly.time, now);
  const precipSeries = precipIdxs
    .map((i) => `${formatHour(data.hourly.time[i])}=${data.hourly.precipitation_probability[i]}`)
    .join(",");

  const conditionSeries = precipIdxs
    .map((i) => `${formatHour(data.hourly.time[i])}=${conditionLabel(data.hourly.weathercode[i])}`)
    .join(",");

  return [
    `Current: ${data.current.temperature_2m.toFixed(1)}C, ${desc.toLowerCase()}, wind ${Math.round(data.current.wind_speed_10m)}km/h.`,
    `Temp forecast today (15-min, HH:MM=C): ${tempSeries}`,
    `Rain amount today (15-min mm, HH:MM=mm): ${mmSeries}`,
    `Rain probability today (hourly %, HH:MM=%): ${precipSeries}`,
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

function setStatusPill(className, text) {
  const pill = document.getElementById("model-status-pill");
  pill.className = `stub-badge ${className}`;
  pill.textContent = text;
}

function logEntry(kind, text) {
  const log = document.getElementById("ask-log");
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

setupAsk();
checkModelCapability();
forecastPromise = loadForecast();
