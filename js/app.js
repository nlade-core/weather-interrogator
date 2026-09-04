const EDINBURGH = { latitude: 55.9533, longitude: -3.1883 };

const FORECAST_URL = new URL("https://api.open-meteo.com/v1/forecast");
FORECAST_URL.search = new URLSearchParams({
  latitude: EDINBURGH.latitude,
  longitude: EDINBURGH.longitude,
  timezone: "Europe/London",
  forecast_days: "2",
  current: "temperature_2m,weathercode,wind_speed_10m,precipitation",
  hourly: "temperature_2m,precipitation_probability,weathercode,windspeed_10m",
});

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

function renderForecastTable(data) {
  const { time, temperature_2m, precipitation_probability, weathercode, windspeed_10m } = data.hourly;
  const nowIndex = time.findIndex((t) => new Date(t) >= new Date(data.current.time));
  const start = nowIndex === -1 ? 0 : nowIndex;
  const rows = [];

  for (let i = start; i < Math.min(start + 24, time.length); i++) {
    const [desc, icon] = describeCode(weathercode[i]);
    rows.push(`
      <tr>
        <td>${formatHour(time[i])}</td>
        <td>${icon} ${desc}</td>
        <td>${Math.round(temperature_2m[i])}&deg;C</td>
        <td>${precipitation_probability[i]}%</td>
        <td>${Math.round(windspeed_10m[i])} km/h</td>
      </tr>
    `);
  }

  document.getElementById("forecast-body").innerHTML = rows.join("");
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

    renderRaw(data);
    renderCurrent(data);
    renderForecastTable(data);

    statusEl.textContent = `Updated ${new Date().toLocaleTimeString("en-GB")} — next 24h for Edinburgh (${data.latitude.toFixed(2)}, ${data.longitude.toFixed(2)})`;
  } catch (err) {
    statusEl.textContent = `Failed to load forecast: ${err.message}`;
    statusEl.classList.add("error");
  }
}

loadForecast();
