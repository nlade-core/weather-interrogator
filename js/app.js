const EDINBURGH = { latitude: 55.9533, longitude: -3.1883 };

const FORECAST_URL = new URL("https://api.open-meteo.com/v1/forecast");
FORECAST_URL.search = new URLSearchParams({
  latitude: EDINBURGH.latitude,
  longitude: EDINBURGH.longitude,
  timezone: "Europe/London",
  forecast_days: "2",
  current: "temperature_2m,weathercode,wind_speed_10m,precipitation",
  hourly: "temperature_2m,precipitation_probability,weathercode,windspeed_10m",
  minutely_15: "temperature_2m",
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
  padX: 28,
  plotHeight: 190,
  labelHeight: 44,
};

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

  const { width, padX, plotHeight, labelHeight } = CHART;
  const plotWidth = width - padX * 2;
  const height = plotHeight + labelHeight;

  // Temperature (15-min) and precipitation (hourly) are different native
  // resolutions, so they're placed on one shared axis by actual elapsed
  // time rather than by array index -- that's what keeps a 14:15 point on
  // the line lining up under the right third of the 14:00-15:00 bar.
  const xForTime = (t) => padX + ((t - now) / spanMs) * plotWidth;
  const yTemp = (t) => plotHeight - ((t - min) / (max - min)) * plotHeight;

  const points = tempIdxs.map((idx) => ({
    x: xForTime(new Date(data.minutely_15.time[idx])),
    yTemp: yTemp(data.minutely_15.temperature_2m[idx]),
    temp: data.minutely_15.temperature_2m[idx],
    time: data.minutely_15.time[idx],
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

  // Apple-style: precip is a faded wash behind the temperature line rather
  // than a separate band -- bar height is probability against the full
  // plot height (100% reaches the top), low-opacity so the line stays
  // readable through it. One bar per 15-min slot (matching the temp
  // line's grid), height linearly interpolated between the two bracketing
  // (shifted) hourly readings so it ramps smoothly rather than stepping.
  const quarterMs = 15 * 60 * 1000;
  const barWidth = Math.max((quarterMs / spanMs) * plotWidth * 0.82, 3);
  const bars = points
    .map((p) => {
      const t = new Date(p.time);
      const prob = interpolateHourly(shiftedTime, shiftedPrecip, t);
      const code = weathercodeAt(data.hourly.time, data.hourly.weathercode, t);
      const family = precipFamily(code);
      const barHeight = (prob / 100) * plotHeight;
      const y = plotHeight - barHeight;
      return `<rect x="${(p.x - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.5" class="precip-bar precip-${family}"><title>${formatHour(p.time)} — ${Math.round(prob)}% chance, ${describeCode(code)[0].toLowerCase()} (smoothed)</title></rect>`;
    })
    .join("");

  // Axis + value labels stay anchored to the coarser hourly marks --
  // labelling every 15-min point would be unreadable clutter.
  const labelStep = Math.max(1, Math.ceil(precipPoints.length / 8));
  const labeled = precipPoints.filter((_, i) => i % labelStep === 0 || i === precipPoints.length - 1);

  const hourLabels = labeled
    .map((p) => `<text x="${p.x.toFixed(1)}" y="${height - 6}" class="chart-axis-label" text-anchor="middle">${formatHour(p.time)}</text>`)
    .join("");

  const conditionIcons = labeled
    .map((p) => {
      const hIdx = data.hourly.time.indexOf(p.time);
      const icon = describeCode(data.hourly.weathercode[hIdx])[1];
      return `<text x="${p.x.toFixed(1)}" y="${(plotHeight + 16).toFixed(1)}" class="chart-icon-label" text-anchor="middle">${icon}</text>`;
    })
    .join("");

  const tempLabels = labeled
    .map((p) => {
      const hIdx = data.hourly.time.indexOf(p.time);
      const t = data.hourly.temperature_2m[hIdx];
      const y = Math.max(yTemp(t) - 10, 10);
      return `<text x="${p.x.toFixed(1)}" y="${y.toFixed(1)}" class="chart-temp-label" text-anchor="middle">${Math.round(t)}&deg;</text>`;
    })
    .join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Temperature and rain chance for the rest of today">
      <g class="precip-band">${bars}</g>
      <polyline points="${linePath}" class="chart-line" fill="none" />
      ${tempLabels}
      ${conditionIcons}
      ${hourLabels}
      <line class="hover-guide" x1="0" x2="0" y1="0" y2="${plotHeight}" />
      <circle class="hover-dot" r="5" cx="0" cy="0" />
      <rect class="chart-hit-area" x="${padX}" y="0" width="${plotWidth}" height="${plotHeight}" fill="transparent" />
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

    tooltip.innerHTML = `<strong>${Math.round(p.temp * 10) / 10}&deg;C</strong> at ${formatHour(p.time)}<br>${precip}% chance &middot; ${icon} ${desc.toLowerCase()}`;
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

const WEATHER_SYSTEM_PROMPT = `Weather assistant for Edinburgh. Use only the data below, don't invent numbers. Temperature is a reading every 15 minutes; rain probability is one reading per hour (no rain amount/severity data yet, no wind, no other days — say so if asked). Keep answers to 1-2 sentences.`;

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

  const precipIdxs = remainingTodayIndices(data.hourly.time, now);
  const precipSeries = precipIdxs
    .map((i) => `${formatHour(data.hourly.time[i])}=${data.hourly.precipitation_probability[i]}`)
    .join(",");

  return [
    `Current: ${data.current.temperature_2m.toFixed(1)}C, ${desc.toLowerCase()}, wind ${Math.round(data.current.wind_speed_10m)}km/h.`,
    `Temp forecast today (15-min, HH:MM=C): ${tempSeries}`,
    `Rain probability today (hourly %, HH:MM=%): ${precipSeries}`,
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
