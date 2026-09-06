// Mutable, not a constant -- location can change at runtime (see the
// location-picker section near the bottom of this file). isUK gates the
// UKV model pin below: UKV only covers the UK domain, so a location
// outside it needs best_match instead, or every field would just come
// back null the way precipitation_probability does under UKV.
let LOCATION = { latitude: 55.9533, longitude: -3.1883, name: "Edinburgh", isUK: true };

// Rebuilt fresh on every fetch (not a fixed constant) since LOCATION can
// change. timezone=auto rather than a hardcoded "Europe/London" -- checked
// against a real request, resolves correctly per-coordinate (confirmed
// Europe/London for Edinburgh, Europe/Paris for Paris), so it generalises
// safely rather than showing UK local time for a non-UK location.
function buildForecastUrl(location) {
  const url = new URL("https://api.open-meteo.com/v1/forecast");
  const params = {
    latitude: location.latitude,
    longitude: location.longitude,
    timezone: "auto",
    forecast_days: "2",
    // Extends minutely_15/hourly backward by a full day at the same
    // resolution as the forward data (confirmed: still genuinely 15-min
    // throughout, not a downgraded or repeated series) -- used for the
    // recent-past trailing context on the chart, a few hours of it, not
    // the whole day.
    past_days: "1",
    // UK convention for wind speed (Met Office forecasts, broadcast
    // weather) is mph, not km/h -- converted server-side rather than
    // client-side math, so every wind_speed_10m/wind_gusts_10m value in
    // the response already arrives in mph. wind_direction_10m (degrees)
    // is unaffected. Kept as mph for every location, not just UK ones --
    // consistency across the app over per-location unit-switching.
    wind_speed_unit: "mph",
    current: "temperature_2m,apparent_temperature,weathercode,wind_speed_10m,precipitation",
    // wind_gusts_10m is a preceding-hour max (like probability/mm were) --
    // fetched hourly and shifted the same way. wind_speed_10m and
    // wind_direction_10m are instant, fetched at native 15-min resolution
    // via minutely_15 instead, no shift needed.
    hourly: "wind_gusts_10m",
    // weathercode confirmed genuinely 15-min resolution (derived
    // per-timestep from cloud_cover etc., not hourly-native) -- fetched
    // here instead of hourly so condition icons stop repeating a stale
    // value 4x per hour. apparent_temperature also confirmed genuinely
    // 15-min. is_day confirmed to flip cleanly at 15-min resolution too
    // (checked against a real sunrise: 06:15 still 0, 06:30 already 1).
    minutely_15: "temperature_2m,apparent_temperature,precipitation,wind_speed_10m,wind_direction_10m,weathercode,is_day",
    // Daily summary: UKV only has real (non-null) data 2 days out
    // (confirmed -- days 3+ came back null when tried), so this covers
    // today/tomorrow only, not a fabricated week. Deliberately not mixing
    // in a lower-resolution global model to fake more days -- that's the
    // same resolution-mismatch mistake precipitation_probability was
    // dropped over.
    daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum",
  };
  // Pinned to the explicit UK model rather than best_match for UK
  // locations: same grid cell, same values for every field that's
  // genuinely UKV, but a field UKV can't provide comes back null instead
  // of best_match silently substituting a mismatched ~27km source and it
  // being displayed as if it were local. Omitted entirely for a non-UK
  // location -- UKV has no data outside the UK domain at all, so falling
  // through to best_match is the only real option, not a lesser choice.
  if (location.isUK) params.models = "ukmo_uk_deterministic_2km";
  url.search = new URLSearchParams(params);
  return url;
}

// Below this gap, actual and feels-like are close enough that showing both
// is just visual/textual noise -- the dashed apparent-temp line only draws
// where segments exceed it, and the tooltip/current-card only mention
// "feels like" when they do too.
const APPARENT_TEMP_GAP = 2;

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
  const gap = data.current.apparent_temperature - data.current.temperature_2m;
  const feelsLike = Math.abs(gap) >= APPARENT_TEMP_GAP
    ? ` <span class="feels-like">(feels ${Math.round(data.current.apparent_temperature)}&deg;)</span>`
    : "";
  card.innerHTML = `
    <span class="temp">${icon} ${Math.round(data.current.temperature_2m)}&deg;C${feelsLike}</span>
    <span class="desc">${desc} &middot; wind ${Math.round(data.current.wind_speed_10m)} mph</span>
  `;
}

const CHART = {
  width: 800,
  padLeft: 34, // room for the temperature axis (ticks + "25°" labels)
  padRight: 78, // room for two stacked right-side axes: precip mm (inner) and wind mph (outer)
  topStripHeight: 30, // date, then hour labels
  plotHeight: 170, // condition icons + wind icons + precip wash area, all within this one region
  axisLabelHeight: 10, // small bottom buffer so icon glyphs at the very bottom of the scale don't clip against the viewBox edge
  windAxisOffset: 40, // how far right of the precip axis the wind axis lane sits
};

const CONTEXT_HOURS = 12; // the model's data window (Ask/LLM) AND the chart's forward span -- fixed forward-looking span rather than "rest of today", so it behaves the same at 8am and at 11pm. Deliberately forward-only for Ask, per the recent-past scoping note: that's a later addition, not this one.
const PAST_HOURS = 3; // chart-only: recent-past trailing context, shorter than the forward span so it reads as context for "now" rather than a second co-equal window

function nextHoursIndices(times, now, hours) {
  const cutoff = new Date(now.getTime() + hours * 3600 * 1000);
  const idxs = [];
  times.forEach((t, i) => {
    const ts = new Date(t);
    if (ts >= now && ts < cutoff) idxs.push(i);
  });
  return idxs;
}

// Chart-only (see PAST_HOURS above) -- symmetric version of nextHoursIndices
// that also looks backward. Kept separate from nextHoursIndices rather than
// adding a pastHours param to it, so the Ask/LLM lookup path (which uses
// nextHoursIndices directly) can't accidentally start seeing past data it
// was never scoped to handle.
function windowIndices(times, now, pastHours, futureHours) {
  const start = new Date(now.getTime() - pastHours * 3600 * 1000);
  const cutoff = new Date(now.getTime() + futureHours * 3600 * 1000);
  const idxs = [];
  times.forEach((t, i) => {
    const ts = new Date(t);
    if (ts >= start && ts < cutoff) idxs.push(i);
  });
  return idxs;
}

function renderTodayChart(data) {
  const wrap = document.getElementById("today-chart");
  const now = new Date(data.current.time);
  const windowStart = new Date(now.getTime() - PAST_HOURS * 3600 * 1000);
  const spanMs = (PAST_HOURS + CONTEXT_HOURS) * 3600 * 1000;

  const tempIdxs = windowIndices(data.minutely_15.time, now, PAST_HOURS, CONTEXT_HOURS);
  const precipIdxs = windowIndices(data.hourly.time, now, PAST_HOURS, CONTEXT_HOURS);

  if (tempIdxs.length < 2) {
    wrap.innerHTML = `<p class="chart-empty">Not enough forecast data to chart the next ${CONTEXT_HOURS} hours.</p>`;
    return;
  }

  const { width, padLeft, padRight, topStripHeight, plotHeight, axisLabelHeight, windAxisOffset } = CHART;
  const plotWidth = width - padLeft - padRight;
  const plotTop = topStripHeight;
  const height = topStripHeight + plotHeight + axisLabelHeight;

  // Lines-as-icons version: no plotted lines at all, just the condition
  // icon and a rotated wind arrow riding at their own height, so the icon's
  // extra info (condition variety, wind direction) sits directly on the
  // value it represents instead of a separate row/line. Both icon strings
  // share ONE fixed 0-25 scale (temp in C, wind in mph) rather than each
  // getting its own calibrated range -- deliberately simple for this
  // version, at the cost of clamping anything outside 0-25 to the edge
  // (fine for Edinburgh's typical range, not built to handle a heatwave or
  // a hard frost).
  const ICON_SCALE_MAX = 25;
  const iconY = (v) => plotTop + plotHeight - (Math.max(0, Math.min(v, ICON_SCALE_MAX)) / ICON_SCALE_MAX) * plotHeight;

  // Temperature (15-min) and precipitation (hourly) are different native
  // resolutions, so they're placed on one shared axis by actual elapsed
  // time rather than by array index -- that's what keeps a 14:15 point on
  // the line lining up under the right third of the 14:00-15:00 bar.
  // Offset from windowStart (not now) since the window now extends
  // PAST_HOURS behind "now" as well as CONTEXT_HOURS ahead of it.
  const xForTime = (t) => padLeft + ((t - windowStart) / spanMs) * plotWidth;
  const nowX = xForTime(now);

  // precipitation (mm) at 15-min resolution also describes the *preceding*
  // interval (confirmed against the docs, same convention as the hourly
  // probability field) -- so the reading at minutely_15 index (idx+1) is
  // the one actually in force during this bar's slot, not index idx.
  const mmAt = (idx) => data.minutely_15.precipitation[idx + 1] ?? 0;

  const points = tempIdxs.map((idx) => {
    const time = data.minutely_15.time[idx];
    return {
      idx,
      x: xForTime(new Date(time)),
      yTemp: iconY(data.minutely_15.temperature_2m[idx]),
      temp: data.minutely_15.temperature_2m[idx],
      apparentTemp: data.minutely_15.apparent_temperature[idx],
      time,
      isPast: new Date(time) < now, // recent-past trailing context -- rendered de-emphasised, not mistaken for more forecast
      mm: mmAt(idx),
      windSpeed: data.minutely_15.wind_speed_10m[idx], // mph, see wind_speed_unit in the fetch config
      yWind: iconY(data.minutely_15.wind_speed_10m[idx]),
      windDir: data.minutely_15.wind_direction_10m[idx],
      code: data.minutely_15.weathercode[idx],
    };
  });

  // Hour-mark positions for the bottom axis labels -- just time/x, no
  // probability attached (that field is gone; see the fetch config note).
  const precipPoints = precipIdxs.map((idx) => {
    const time = data.hourly.time[idx];
    return { x: xForTime(new Date(time)), time, isPast: new Date(time) < now };
  });

  // Night band: a shaded background for is_day === 0 stretches, drawn
  // first so it paints behind the precip wash and both icon rows -- pure
  // background context, not a data series competing for attention.
  // Band edges sit at the midpoint between the last/first samples either
  // side of a transition rather than snapping to a sample point, since
  // is_day flips somewhere between two 15-min readings, not exactly on one.
  const nightBands = [];
  let nightStart = null;
  points.forEach((p, i) => {
    const isNight = data.minutely_15.is_day[p.idx] === 0;
    if (isNight && nightStart === null) {
      nightStart = i === 0 ? p.x : (points[i - 1].x + p.x) / 2;
    } else if (!isNight && nightStart !== null) {
      nightBands.push([nightStart, (points[i - 1].x + p.x) / 2]);
      nightStart = null;
    }
  });
  if (nightStart !== null) nightBands.push([nightStart, padLeft + plotWidth]);
  const nightRects = nightBands
    .map(([x1, x2]) => `<rect x="${x1.toFixed(1)}" y="${plotTop}" width="${(x2 - x1).toFixed(1)}" height="${plotHeight}" class="chart-night-band" />`)
    .join("");

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
  const barFor = (p) => {
    const family = precipFamily(p.code);
    const barHeight = Math.min(p.mm / HEIGHT_MAX_MM, 1) * plotHeight;
    const y = plotTop + plotHeight - barHeight;
    return `<rect x="${(p.x - barWidth / 2).toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barHeight.toFixed(1)}" rx="1.5" class="precip-bar precip-${family}"><title>${formatHour(p.time)} — ${p.mm.toFixed(1)}mm, ${describeCode(p.code)[0].toLowerCase()}</title></rect>`;
  };
  // Past bars wrapped in their own <g> rather than adding a .chart-past
  // class straight onto each rect -- .precip-bar already sets its own
  // opacity per type (rain/snow/storm), and stacking a second opacity class
  // on the *same* element would just override that via the CSS cascade,
  // losing the type distinction (the same presentation-attribute-vs-class
  // precedence issue this project hit once before with the wind icons).
  // Group opacity on a *parent* element compounds with a child's own
  // opacity instead of colliding with it.
  const bars =
    `<g class="chart-past">${points.filter((p) => p.isPast).map(barFor).join("")}</g>` +
    points.filter((p) => !p.isPast).map(barFor).join("");

  // Hour labels: moved to the top, matching the usual chart convention
  // (time axis reads top-to-bottom-then-across, not buried at the bottom).
  // Date shown on its own line above -- printed once at the start, and
  // again at whichever tick crosses into a new calendar day, since a fixed
  // 12h window (unlike the old "rest of today" one) can span midnight.
  let lastDate = null;
  const dateLabel = precipPoints
    .map((p, i) => {
      const label = formatDayMonth(p.time);
      if (label === lastDate) return "";
      lastDate = label;
      const anchor = i === 0 ? "start" : "middle";
      const x = i === 0 ? padLeft : p.x;
      return `<text x="${x.toFixed(1)}" y="10" class="chart-axis-label" text-anchor="${anchor}">${label}</text>`;
    })
    .join("");
  const hourLabels = precipPoints
    .map((p) => `<text x="${p.x.toFixed(1)}" y="22" class="chart-axis-label" text-anchor="middle">${formatHour(p.time)}</text>`)
    .join("");

  // Condition icons: no line to ride above any more, so positioned to
  // visually centre the glyph on its actual value height (a small -4
  // offset, roughly font-size/3, rather than the old -12 that existed
  // purely to clear the now-removed line).
  const conditionIcons = points
    .map((p) => {
      const icon = describeCode(p.code)[1];
      const y = Math.max(p.yTemp - 4, 10);
      const pastClass = p.isPast ? " chart-past" : "";
      return `<text x="${p.x.toFixed(1)}" y="${y.toFixed(1)}" class="chart-icon-label${pastClass}" text-anchor="middle">${icon}</text>`;
    })
    .join("");

  // Wind icons: a rotated arrow riding at the wind-speed height on the
  // shared 0-25 scale, replacing both the old fixed-height arrow+number row
  // and the dashed wind line -- direction is the icon's own "extra info"
  // (via rotation), speed is read from its height against the wind axis,
  // same relationship the condition icons have with the temperature axis.
  // Arrow points in the direction wind is blowing *toward* (direction+180,
  // since wind_direction_10m is meteorological convention -- the direction
  // it's blowing *from*).
  const windIcons = points
    .map((p) => {
      const rotation = (p.windDir + 180) % 360;
      const y = Math.max(p.yWind - 4, 10);
      const pastClass = p.isPast ? " chart-past" : "";
      return `<text x="${p.x.toFixed(1)}" y="${y.toFixed(1)}" class="chart-wind-arrow${pastClass}" text-anchor="middle" transform="rotate(${rotation.toFixed(0)}, ${p.x.toFixed(1)}, ${(y - 3).toFixed(1)})">&uarr;</text>`;
    })
    .join("");

  // "Now" marker: with a past window as well as a forward one, now is no
  // longer always the left edge, so it needs its own always-visible line --
  // the existing hover-guide only appears on interaction, which isn't the
  // same thing.
  const nowMarker = `<line x1="${nowX.toFixed(1)}" x2="${nowX.toFixed(1)}" y1="${plotTop}" y2="${plotTop + plotHeight}" class="chart-now-marker" /><text x="${nowX.toFixed(1)}" y="${(plotTop + 9).toFixed(1)}" class="chart-now-label" text-anchor="middle">now</text>`;

  // Temperature axis (left) and wind axis (right, outer lane): both read
  // off the same fixed 0-25 scale as the icons themselves, in their own
  // units (C / mph) -- a tick at the same height means "25" on both sides,
  // just two different quantities sharing one physical scale for this
  // version. Precip axis (inner right lane) is unrelated and keeps its own
  // fixed mm ticks matching HEIGHT_MAX_MM, since that's what bar height
  // encodes.
  const ICON_AXIS_TICKS = [0, 5, 10, 15, 20, 25];
  const tempAxis = ICON_AXIS_TICKS
    .map((tv) => {
      const ty = iconY(tv);
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

  // Wind axis: a second, further-out right-side lane, coloured to match the
  // wind icons so it reads as "this axis belongs to those" rather than just
  // more numbers next to the precip ones.
  const windAxis = ICON_AXIS_TICKS
    .map((tv) => {
      const ty = iconY(tv);
      const xWind = padLeft + plotWidth + windAxisOffset;
      return (
        `<line x1="${xWind}" x2="${(xWind + 4).toFixed(1)}" y1="${ty.toFixed(1)}" y2="${ty.toFixed(1)}" class="axis-tick-wind" />` +
        `<text x="${(xWind + 7).toFixed(1)}" y="${(ty + 3).toFixed(1)}" class="axis-tick-label-wind" text-anchor="start">${tv}mph</text>`
      );
    })
    .join("");

  wrap.innerHTML = `
    <svg viewBox="0 0 ${width} ${height}" class="chart-svg" role="img" aria-label="Temperature and wind speed as icons, plus rainfall, for the last ${PAST_HOURS} hours and the next ${CONTEXT_HOURS} hours">
      ${nightRects}
      <g class="precip-band">${bars}</g>
      ${conditionIcons}
      ${windIcons}
      ${nowMarker}
      ${dateLabel}
      ${hourLabels}
      ${tempAxis}
      ${precipAxis}
      ${windAxis}
      <line class="hover-guide" x1="0" x2="0" y1="${plotTop}" y2="${plotTop + plotHeight}" />
      <circle class="hover-dot" r="5" cx="0" cy="0" />
      <rect class="chart-hit-area" x="${padLeft}" y="${plotTop}" width="${plotWidth}" height="${plotHeight}" fill="transparent" />
    </svg>
  `;

  attachChartHover(wrap, points);
  renderDominantFactor(points);
}

// v1 heuristic, deliberately not a settled design (this was raised as the
// open-ended "relative importance of variables" question, with no concrete
// design yet) -- picks ONE dominant factor from a fixed priority list based
// on simple thresholds, using only the forward-looking portion of the
// window (recent-past trailing context isn't "what's coming", so it's
// excluded here). A real version of this would need actual thought about
// what threshold values matter and how they interact, not arbitrary
// round numbers picked without testing against how people actually judge
// a day's weather.
function computeDominantFactor(points) {
  const forward = points.filter((p) => !p.isPast);
  if (!forward.length) return null;

  const maxWind = Math.max(...forward.map((p) => p.windSpeed));
  const maxTemp = Math.max(...forward.map((p) => p.temp));
  const minTemp = Math.min(...forward.map((p) => p.temp));
  const maxApparentGap = Math.max(...forward.map((p) => Math.abs(p.apparentTemp - p.temp)));
  const maxRainSlot = Math.max(...forward.map((p) => p.mm));
  const totalRain = forward.reduce((sum, p) => sum + p.mm, 0);

  if (maxWind >= 20) return `&#128168; Wind looks like the main factor today &mdash; up to ${Math.round(maxWind)}mph.`;
  if (maxTemp >= 25) return `&#129395; Heat looks like the main factor today &mdash; up to ${Math.round(maxTemp)}&deg;C.`;
  if (minTemp <= 2) return `&#129398; Cold looks like the main factor today &mdash; down to ${Math.round(minTemp)}&deg;C.`;
  if (maxApparentGap >= 4) return `&#127788;&#65039; Wind chill looks like the main factor today &mdash; feels up to ${Math.round(maxApparentGap)}&deg; different from the actual temperature.`;
  if (maxRainSlot >= 1 || totalRain >= 3) return `&#127783;&#65039; Rain looks like the main factor today &mdash; ${totalRain.toFixed(1)}mm expected.`;
  return `&#128522; Nothing stands out &mdash; conditions look calm.`;
}

function renderDominantFactor(points) {
  const el = document.getElementById("dominant-factor");
  el.innerHTML = computeDominantFactor(points) ?? "";
}

let dismissTouchTooltip = null; // tracked across renders so re-running attachChartHover (e.g. after a location change) replaces the previous document-level listener instead of stacking another one

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

    const feelsLike = Math.abs(p.apparentTemp - p.temp) >= APPARENT_TEMP_GAP
      ? ` (feels ${Math.round(p.apparentTemp)}&deg;)`
      : "";
    const timeWord = p.isPast ? "was" : "at";
    tooltip.innerHTML = `<strong>${Math.round(p.temp * 10) / 10}&deg;C</strong>${feelsLike} ${timeWord} ${formatHour(p.time)}<br>${p.mm.toFixed(1)}mm &middot; ${icon} ${desc.toLowerCase()}<br>${Math.round(p.windSpeed)}mph from ${compassLabel(p.windDir)}`;
    tooltip.classList.add("visible");

    const screenX = rect.left + p.x / scale;
    const screenY = rect.top + p.yTemp / scale;
    tooltip.style.left = `${screenX}px`;
    tooltip.style.top = `${screenY - 10}px`;
  }

  function hide() {
    guide.classList.remove("visible");
    hoverDot.classList.remove("visible");
    tooltip.classList.remove("visible");
  }

  // Touch has no hover state -- pointerleave fires the instant a finger
  // lifts, which would make the tooltip flash and vanish before it's
  // readable. So a touch pointer is left visible after the tap (ignored
  // here) and dismissed instead by a tap anywhere outside the chart,
  // matching a common mobile tap-to-reveal pattern rather than a hover one.
  function onLeave(evt) {
    if (evt?.pointerType === "touch") return;
    hide();
  }

  hitArea.addEventListener("pointerdown", onMove);
  hitArea.addEventListener("pointermove", onMove);
  hitArea.addEventListener("pointerleave", onLeave);

  if (dismissTouchTooltip) document.removeEventListener("pointerdown", dismissTouchTooltip);
  dismissTouchTooltip = (evt) => {
    if (evt.pointerType === "touch" && !hitArea.contains(evt.target)) hide();
  };
  document.addEventListener("pointerdown", dismissTouchTooltip);
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

// Only today/tomorrow: UKV comes back null past day 2 (confirmed via a
// real request, not assumed), so a day with no weather_code is skipped
// rather than shown as a blank/broken card.
function renderDailySummary(data) {
  const container = document.getElementById("daily-summary");
  // Located by matching today's actual date, not assumed to be index 0 --
  // past_days (added for the chart's recent-past context) prepends a day
  // to every series including this one, so index 0 is yesterday whenever
  // past_days is set. Slicing from the matched index keeps this correct
  // regardless of that setting.
  const todayStr = data.current.time.slice(0, 10);
  const todayIdx = Math.max(0, data.daily.time.indexOf(todayStr));
  const labels = ["Today", "Tomorrow"];
  const cards = data.daily.time
    .slice(todayIdx)
    .map((date, i) => {
      const j = todayIdx + i;
      if (data.daily.weather_code[j] == null) return "";
      const [desc, icon] = describeCode(data.daily.weather_code[j]);
      const hi = Math.round(data.daily.temperature_2m_max[j]);
      const lo = Math.round(data.daily.temperature_2m_min[j]);
      const rain = data.daily.precipitation_sum[j];
      const rainNote = rain >= 0.1 ? `<div class="daily-rain">${rain.toFixed(1)}mm</div>` : "";
      return `
        <div class="daily-card">
          <div class="daily-label">${labels[i] ?? formatDayMonth(date)}</div>
          <div class="daily-icon">${icon}</div>
          <div class="daily-range"><strong>${hi}&deg;</strong> / ${lo}&deg;</div>
          <div class="daily-desc">${desc}</div>
          ${rainNote}
        </div>`;
    })
    .join("");
  container.innerHTML = cards || `<p class="chart-empty">No further-day data available right now.</p>`;
}

function renderRaw(data) {
  document.getElementById("raw-output").textContent = JSON.stringify(data, null, 2);
}

// Nominatim (OpenStreetMap) -- free, no key, matching the no-signup
// philosophy the rest of the app has kept to everywhere else. addressdetails
// gets a country_code, needed to decide whether UKV (UK-only) or best_match
// is the right model for the result -- confirmed the response shape (name,
// address.country_code) against real queries for both a UK and a non-UK
// location before relying on it.
async function geocodeLocation(query) {
  const url = new URL("https://nominatim.openstreetmap.org/search");
  url.search = new URLSearchParams({ q: query, format: "json", limit: "1", addressdetails: "1" });
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Geocoding failed (${res.status})`);
  const results = await res.json();
  if (!results.length) throw new Error(`Couldn't find "${query}"`);
  const r = results[0];
  return {
    latitude: parseFloat(r.lat),
    longitude: parseFloat(r.lon),
    name: r.name || r.display_name.split(",")[0],
    isUK: r.address?.country_code === "gb",
  };
}

function setLocationCopy() {
  document.getElementById("subtitle").textContent = `Short-term forecast for ${LOCATION.name}, pulled straight from Open-Meteo.`;
  document.getElementById("daily-note").innerHTML = LOCATION.isUK
    ? `UKV (the 2km model everything else on this page uses) only forecasts about 2 days out &mdash; further than that would mean mixing in a lower-resolution global model, the same resolution mismatch this project already dropped <code>precipitation_probability</code> over. So: today and tomorrow, not a fabricated week.`
    : `${LOCATION.name} is outside the UK, so this uses Open-Meteo's <code>best_match</code> model rather than the UK-specific 2km UKV model this page uses for UK locations &mdash; a coarser global model, not the same resolution or quality guarantee.`;
}

function setupLocationPicker() {
  const form = document.getElementById("location-form");
  const input = document.getElementById("location-input");
  const submitBtn = document.getElementById("location-submit");
  const statusEl = document.getElementById("location-status");

  form.addEventListener("submit", async (e) => {
    e.preventDefault();
    const query = input.value.trim();
    if (!query) return;

    submitBtn.disabled = true;
    statusEl.textContent = "Looking up…";
    statusEl.classList.remove("error");

    try {
      LOCATION = await geocodeLocation(query);
      setLocationCopy();
      input.value = "";
      statusEl.textContent = "";

      // The existing Ask session's system prompt names the old location --
      // reset rather than let it silently keep answering as if still
      // there. askedBefore reset too, so the next question gets the full
      // staged pipeline again rather than skipping straight to a direct
      // answer against a session that no longer exists.
      chatSession = null;
      askedBefore = false;

      forecastPromise = loadForecast();
      await forecastPromise;
    } catch (err) {
      statusEl.textContent = err.message;
      statusEl.classList.add("error");
    } finally {
      submitBtn.disabled = false;
    }
  });
}

async function loadForecast() {
  const statusEl = document.getElementById("status");
  try {
    const res = await fetch(buildForecastUrl(LOCATION));
    if (!res.ok) throw new Error(`Open-Meteo responded ${res.status}`);
    const data = await res.json();
    latestData = data;

    renderRaw(data);
    renderCurrent(data);
    renderTodayChart(data);
    renderDailySummary(data);

    statusEl.textContent = `Updated ${new Date().toLocaleTimeString("en-GB")} — ${LOCATION.name} (${data.latitude.toFixed(2)}, ${data.longitude.toFixed(2)})`;
    return data;
  } catch (err) {
    statusEl.textContent = `Failed to load forecast: ${err.message}`;
    statusEl.classList.add("error");
    throw err;
  }
}

// System prompt deliberately describes what data exists rather than
// containing the data itself -- a small on-device model reasons far worse
// once its context is full of raw numbers than when it's asked to work in
// stages. Real numbers only enter context per-question, and only the
// categories that question actually needs (see the staged Ask flow below).
// A function, not a constant string -- LOCATION.name can change at
// runtime, and this needs re-evaluating fresh at session-creation time
// rather than being baked in once at module load.
function buildSystemPrompt() {
  return `Weather assistant for ${LOCATION.name}, covering only the next ${CONTEXT_HOURS} hours from now (no other days, no rain-probability figure -- deliberately not provided, the available one wasn't locally reliable). You don't have any weather numbers yet: for each question, you'll first be asked to restate what the person actually wants to know, then which data categories would help, then you'll be given only that data to answer with. Keep every answer to 1-2 sentences, and say so plainly if the data you're given isn't enough to answer confidently -- don't guess.`;
}

function withTimeout(promise, ms) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("timed out")), ms)),
  ]);
}

// Fixed vocabulary the "what data is needed" step picks from -- a closed
// set rather than free text is what makes the following lookup step a
// genuine simple lookup instead of another fuzzy-parsing problem.
const CATEGORY_MATCHERS = [
  ["temperature", /temp/i],
  ["apparent_temperature", /apparent|feels? ?like|wind ?chill|heat index/i],
  ["rain", /rain|precip/i],
  ["wind", /\bwind\b/i],
  ["gusts", /gust/i],
  ["conditions", /condition|cloud|sky|overcast|storm|snow|fog/i],
];
const DEFAULT_CATEGORIES = ["temperature", "rain", "conditions"];

function matchCategories(text) {
  const found = CATEGORY_MATCHERS.filter(([, re]) => re.test(text)).map(([name]) => name);
  return found.length ? found : DEFAULT_CATEGORIES;
}

// The "simple lookup" step: plain deterministic code, no model involved.
// Pulls only the requested categories, only for the next CONTEXT_HOURS --
// this is what keeps each question's numeric payload small regardless of
// how much data the app actually has on hand.
function lookupWeatherData(data, categories) {
  const now = new Date(data.current.time);
  const [desc] = describeCode(data.current.weathercode);
  const idxs15 = nextHoursIndices(data.minutely_15.time, now, CONTEXT_HOURS);
  const idxsHourly = nextHoursIndices(data.hourly.time, now, CONTEXT_HOURS);

  const builders = {
    // Same preceding-interval shift as the chart: the reading at index i+1
    // is the one actually in force during the slot at index i.
    temperature: () => `Temperature next ${CONTEXT_HOURS}h (15-min, HH:MM=C): ${idxs15.map((i) => `${formatHour(data.minutely_15.time[i])}=${data.minutely_15.temperature_2m[i].toFixed(1)}`).join(",")}`,
    apparent_temperature: () => `Feels-like temperature (wind chill/heat index combined) next ${CONTEXT_HOURS}h (15-min, HH:MM=C): ${idxs15.map((i) => `${formatHour(data.minutely_15.time[i])}=${data.minutely_15.apparent_temperature[i].toFixed(1)}`).join(",")}`,
    rain: () => `Rain amount next ${CONTEXT_HOURS}h (15-min mm, HH:MM=mm): ${idxs15.map((i) => `${formatHour(data.minutely_15.time[i])}=${(data.minutely_15.precipitation[i + 1] ?? 0).toFixed(1)}`).join(",")}`,
    wind: () => `Wind next ${CONTEXT_HOURS}h (15-min, HH:MM=mph+direction): ${idxs15.map((i) => `${formatHour(data.minutely_15.time[i])}=${Math.round(data.minutely_15.wind_speed_10m[i])}${compassLabel(data.minutely_15.wind_direction_10m[i])}`).join(",")}`,
    // wind_gusts_10m is a preceding-hour max, same convention precipitation_
    // probability had -- shifted back one position so the reading lines up
    // with the hour it's actually in force for, not the hour it's filed under.
    gusts: () => `Wind gusts next ${CONTEXT_HOURS}h (hourly peak mph, HH:MM=mph): ${idxsHourly.map((i) => `${formatHour(data.hourly.time[i])}=${Math.round(data.hourly.wind_gusts_10m[i + 1])}`).join(",")}`,
    // weathercode lives on minutely_15 (see fetch config) -- kept at hourly
    // cadence here to match the on-the-hour marks the other hourly field uses.
    conditions: () => `Conditions next ${CONTEXT_HOURS}h (hourly, HH:MM=type): ${idxsHourly.map((i) => { const mIdx = data.minutely_15.time.indexOf(data.hourly.time[i]); return `${formatHour(data.hourly.time[i])}=${conditionLabel(data.minutely_15.weathercode[mIdx])}`; }).join(",")}`,
  };

  const currentGap = data.current.apparent_temperature - data.current.temperature_2m;
  const feelsLikeNote = Math.abs(currentGap) >= APPARENT_TEMP_GAP ? ` (feels ${data.current.apparent_temperature.toFixed(1)}C)` : "";
  const lines = [`Current: ${data.current.temperature_2m.toFixed(1)}C${feelsLikeNote}, ${desc.toLowerCase()}, wind ${Math.round(data.current.wind_speed_10m)}mph.`];
  categories.forEach((c) => { if (builders[c]) lines.push(builders[c]()); });
  return lines.join("\n");
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
// Module-level (not local to setupAsk) so a location change can reset it
// alongside chatSession -- see resetChatSessionForNewLocation below. First
// question in a session gets the full staged pipeline; follow-ups just
// answer directly against the context already built up.
let askedBefore = false;

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

    const session = await LanguageModel.create({
      initialPrompts: [{ role: "system", content: buildSystemPrompt() }],
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

// Staged rather than one-shot: a model this small gets lost combining
// several raw data series into a judgment in a single pass. Splitting
// "what do they actually want" from "what data answers that" from "here's
// just that data" keeps each turn's job small, and surfaces each stage in
// the log so a wrong final answer can be traced back to whichever step
// actually went wrong, rather than being a black box. Runs only for the
// first question of a session -- see askedBefore in setupAsk.
async function runStagedAsk(session, question, data) {
  logEntry("status", "Understanding what you're asking…");
  const goal = await session.prompt(
    `A user asked a weather assistant: "${question}". In one short sentence, restate what they actually want to know or decide -- not the data, just their underlying goal.`
  );
  logEntry("reasoning", `Goal: ${goal}`);

  logEntry("status", "Deciding what data is needed…");
  const categoriesRaw = await session.prompt(
    `Available data categories for the next ${CONTEXT_HOURS} hours: temperature, feels-like temperature (wind chill/heat index), rain amount, wind (speed+direction), wind gusts, conditions (sky/precipitation type). Given the goal "${goal}", which categories are actually needed to answer it? List just the relevant category names.`
  );
  logEntry("reasoning", `Data needed: ${categoriesRaw}`);

  const categories = matchCategories(categoriesRaw);
  if (categories === DEFAULT_CATEGORIES) {
    logEntry("status", `Couldn't parse a specific data need — falling back to: ${categories.join(", ")}`);
  }

  logEntry("status", `Looking up: ${categories.join(", ")}…`);
  const lookupText = lookupWeatherData(data, categories);
  logEntry("lookup", lookupText);

  logEntry("status", "Answering…");
  return session.prompt(
    `Goal: ${goal}\nRelevant data only:\n${lookupText}\n\nAnswer the original question ("${question}") in 1-2 sentences using only this data.`
  );
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

      if (!askedBefore) {
        const data = latestData ?? (await forecastPromise);
        const answer = await runStagedAsk(session, question, data);
        askedBefore = true;
        logEntry("answer", answer);
        // The box above is reusable for follow-ups -- nothing else in the
        // UI signals that, so said explicitly once, right when it first
        // becomes relevant.
        logEntry("status", "You can ask a follow-up in the box above — it'll answer directly using what it already knows, no need to repeat context.");
      } else {
        logEntry("status", "Answering…");
        const answer = await session.prompt(question);
        logEntry("answer", answer);
      }
    } catch (err) {
      logEntry("error", `Error: ${err.message}`);
    } finally {
      submitBtn.disabled = !promptOk;
      // The same box handles follow-ups -- nothing else changes shape after
      // an answer, so without this it looks like there's no way to continue
      // the conversation. Placeholder + refocus make that visible.
      input.placeholder = askedBefore ? "Ask a follow-up…" : "e.g. Is it worth a BBQ this weekend?";
      input.focus();
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
setupLocationPicker();
forecastPromise = loadForecast();

setupWebcam();
checkWebcamCapability();
