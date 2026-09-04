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
  tempBandHeight: 150,
  bandGap: 8,
  precipBandHeight: 64,
  labelHeight: 28,
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
  const idxs = remainingTodayIndices(data.hourly.time, new Date(data.current.time));

  if (idxs.length < 2) {
    wrap.innerHTML = `<p class="chart-empty">Not much of today left to chart &mdash; check back after midnight.</p>`;
    return;
  }

  const { time, temperature_2m, precipitation_probability } = data.hourly;
  const temps = idxs.map((i) => temperature_2m[i]);
  const rawMin = Math.min(...temps);
  const rawMax = Math.max(...temps);
  const min = rawMin === rawMax ? rawMin - 1 : rawMin;
  const max = rawMin === rawMax ? rawMax + 1 : rawMax;

  const { width, padX, tempBandHeight, bandGap, precipBandHeight, labelHeight } = CHART;
  const plotWidth = width - padX * 2;
  const height = tempBandHeight + bandGap + precipBandHeight + labelHeight;
  const precipTop = tempBandHeight + bandGap;

  const x = (i) => padX + (idxs.length === 1 ? plotWidth / 2 : (i / (idxs.length - 1)) * plotWidth);
  const yTemp = (t) => tempBandHeight - ((t - min) / (max - min)) * tempBandHeight;

  const points = idxs.map((idx, i) => ({
    idx,
    x: x(i),
    yTemp: yTemp(temperature_2m[idx]),
    temp: temperature_2m[idx],
    precip: precipitation_probability[idx],
    time: time[idx],
  }));

  const linePath = points.map((p) => `${p.x.toFixed(1)},${p.yTemp.toFixed(1)}`).join(" ");

  const barWidth = Math.max((plotWidth / idxs.length) * 0.55, 4);
  const bars = points
    .map((p) => {
      const barHeight = (p.precip / 100) * precipBandHeight;
      const y = precipTop + (precipBandHeight - barHeight);
      return `<rect x="${(p.x - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" class="precip-bar"><title>${formatHour(p.time)} — ${p.precip}% rain chance</title></rect>`;
    })
    .join("");

  const labelStep = Math.max(1, Math.ceil(points.length / 8));
  const labeled = points.filter((_, i) => i % labelStep === 0 || i === points.length - 1);

  const hourLabels = labeled
    .map((p) => `<text x="${p.x.toFixed(1)}" y="${height - 6}" class="chart-axis-label" text-anchor="middle">${formatHour(p.time)}</text>`)
    .join("");

  const tempLabels = labeled
    .map((p) => `<text x="${p.x.toFixed(1)}" y="${(p.yTemp - 10).toFixed(1)}" class="chart-temp-label" text-anchor="middle">${Math.round(p.temp)}&deg;</text>`)
    .join("");

  const dots = points
    .map((p) => `<circle cx="${p.x.toFixed(1)}" cy="${p.yTemp.toFixed(1)}" r="3" class="chart-dot"><title>${formatHour(p.time)} — ${Math.round(p.temp)}&deg;C, ${p.precip}% rain chance</title></circle>`)
    .join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Temperature and rain chance for the rest of today">
      <g class="precip-band">${bars}</g>
      <polyline points="${linePath}" class="chart-line" fill="none" />
      ${dots}
      ${tempLabels}
      ${hourLabels}
    </svg>
  `;
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
  } catch (err) {
    statusEl.textContent = `Failed to load forecast: ${err.message}`;
    statusEl.classList.add("error");
  }
}

const WEATHER_SYSTEM_PROMPT = `You are a concise weather assistant for Edinburgh, Scotland. Answer using only the forecast data provided in the prompt — don't invent numbers that aren't there. Be direct and practical, aimed at someone deciding whether to do something outdoors. A couple of sentences is enough.`;

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

function buildWeatherContext(data, granularity) {
  const now = new Date(data.current.time);
  const [desc] = describeCode(data.current.weathercode);
  const block = granularity === "minutely_15" ? data.minutely_15 : data.hourly;
  const idxs = remainingTodayIndices(block.time, now);

  const lines = idxs.map((i) => `${formatHour(block.time[i])}: ${block.temperature_2m[i].toFixed(1)}°C`);

  return [
    `Current conditions: ${data.current.temperature_2m.toFixed(1)}°C, ${desc.toLowerCase()}, wind ${Math.round(data.current.wind_speed_10m)} km/h.`,
    ``,
    `Temperature forecast for the rest of today (${granularity === "minutely_15" ? "15-minute" : "hourly"} intervals):`,
    ...lines,
  ].join("\n");
}

// --- Model loading -------------------------------------------------------
// Mirrors the prewarm pattern from chrome-chat: only auto-create a session
// at startup when the model is already downloaded, never trigger a silent
// download the visitor didn't ask for. A "downloadable" or "unavailable"
// state still lets Ask be clicked — creation is attempted lazily then,
// which is the visitor's own action triggering any download.

let prewarmedSession = null; // Promise<session> | null
let promptOk = false;

function setStatusPill(className, text) {
  const pill = document.getElementById("model-status-pill");
  pill.className = `stub-badge ${className}`;
  pill.textContent = text;
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
      prewarmedSession = LanguageModel.create({
        initialPrompts: [{ role: "system", content: WEATHER_SYSTEM_PROMPT }],
      });
    }
  } catch (err) {
    setStatusPill("unavailable", `error: ${err.message}`);
  }

  document.getElementById("ask-submit").disabled = !promptOk;
}

async function getModelSession() {
  if (prewarmedSession) {
    const session = await prewarmedSession;
    prewarmedSession = null;
    return session;
  }
  return LanguageModel.create({
    initialPrompts: [{ role: "system", content: WEATHER_SYSTEM_PROMPT }],
  });
}

function setupAsk() {
  const form = document.getElementById("ask-form");
  const input = document.getElementById("ask-input");
  const output = document.getElementById("ask-response");
  const submitBtn = document.getElementById("ask-submit");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const question = input.value.trim();
    if (!question || !latestData) return;

    const granularity = form.elements["granularity"].value;

    output.hidden = false;
    output.textContent = "Thinking…";
    submitBtn.disabled = true;

    let session;
    try {
      session = await getModelSession();
      const context = buildWeatherContext(latestData, granularity);
      const answer = await session.prompt(`${context}\n\nQuestion: ${question}`);
      output.textContent = answer;
    } catch (err) {
      output.textContent = `Model error: ${err.message}`;
    } finally {
      if (session) {
        try { session.destroy(); } catch {}
      }
      submitBtn.disabled = !promptOk;
    }
  });
}

setupAsk();
checkModelCapability();
loadForecast();
