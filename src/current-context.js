import fs from "node:fs/promises";
import { execFile } from "node:child_process";

const DEFAULT_TIME_ZONE = "Europe/Stockholm";
const DEFAULT_TOKEN_PATH = "";
const DEFAULT_REFRESH_URL = "http://127.0.0.1:43123/refresh";
const DEFAULT_CURRENT_URL = "http://127.0.0.1:43123/current";
const DEFAULT_TIMEOUT_MS = 35_000;
const DEFAULT_STOP_BIN = "";
const DEFAULT_TIME_ZONE_DB_PATH = "/usr/share/zoneinfo/zone.tab";

export async function buildCurrentContext({
  now = null,
  config = {},
  fetchImpl = fetch,
  execFileImpl = execFile,
  readFileImpl = fs.readFile,
} = {}) {
  const startedAt = now || new Date();
  const location = config.currentLocationEnabled === false
    ? disabledLocation()
    : await fetchFindMyLocation({
        now: startedAt,
        config,
        fetchImpl,
        execFileImpl,
        readFileImpl,
      });
  const timeZone = await resolveTimeZoneForLocation(location, { config, readFileImpl });
  const timeNow = now || new Date();
  const time = {
    iso: timeNow.toISOString(),
    timeZone,
    local: formatLocalTime(timeNow, timeZone),
  };
  return { time, location };
}

export function formatCurrentContext(currentContext) {
  if (!currentContext) return null;
  const time = currentContext.time || {};
  const location = currentContext.location || {};
  return [
    "# Current Context",
    `Current time: ${time.local || time.iso || "unknown"}`,
    `Current time ISO: ${time.iso || "unknown"}`,
    `User timezone: ${time.timeZone || "unknown"}`,
    `Current location: ${formatLocation(location)}`,
    `Location source: ${location.source || "unknown"}`,
    `Location fetched_at: ${location.fetchedAt || "unknown"}`,
    `Location freshness/confidence: ${location.freshness || "unknown"}`,
  ].join("\n");
}

async function fetchFindMyLocation({
  now,
  config,
  fetchImpl,
  execFileImpl,
  readFileImpl,
}) {
  const startedAt = now || new Date();
  const tokenPath = config.currentLocationTokenPath || DEFAULT_TOKEN_PATH;
  if (!tokenPath) return failedLocation("token_unconfigured", null, startedAt);
  const timeoutMs = Number(config.currentLocationTimeoutMs || DEFAULT_TIMEOUT_MS);
  let token;
  try {
    token = String(await readFileImpl(tokenPath, "utf8")).trim();
  } catch (error) {
    return failedLocation("token_unavailable", error, startedAt);
  }
  if (!token) return failedLocation("token_empty", null, startedAt);

  const refreshUrl = config.currentLocationRefreshUrl || DEFAULT_REFRESH_URL;
  const currentUrl = config.currentLocationCurrentUrl || currentUrlFromRefreshUrl(refreshUrl);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), Math.max(1, timeoutMs));
  try {
    const response = await fetchImpl(refreshUrl, {
      method: "POST",
      headers: { authorization: `Bearer ${token}` },
      signal: controller.signal,
    });
    const text = await response.text();
    let payload = null;
    try {
      payload = JSON.parse(text);
    } catch {
      // Keep the HTTP status in the error path below.
    }
    if (!response.ok) {
      return await fetchCurrentLocationFallback({
        token,
        currentUrl,
        startedAt,
        reason: `http_${response.status}`,
        error: text,
        fetchImpl,
        signal: controller.signal,
      });
    }
    const location = normalizeFindMyPayload(payload, startedAt, {
      source: "FindMy localhost /refresh",
    });
    if (location.ok) return location;
    return await fetchCurrentLocationFallback({
      token,
      currentUrl,
      startedAt,
      reason: "refresh_empty",
      error: text,
      fetchImpl,
      signal: controller.signal,
    });
  } catch (error) {
    return await fetchCurrentLocationFallback({
      token,
      currentUrl,
      startedAt,
      reason: "refresh_failed",
      error,
      fetchImpl,
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timer);
    cleanupFindMy({ config, execFileImpl });
  }
}

function currentUrlFromRefreshUrl(refreshUrl) {
  const value = String(refreshUrl || "");
  if (/\/refresh(?:[?#].*)?$/.test(value)) {
    return value.replace(/\/refresh(?=[?#]|$)/, "/current");
  }
  return DEFAULT_CURRENT_URL;
}

async function fetchCurrentLocationFallback({
  token,
  currentUrl,
  startedAt,
  reason,
  error,
  fetchImpl,
  signal,
}) {
  try {
    const response = await fetchImpl(currentUrl, {
      method: "GET",
      headers: { authorization: `Bearer ${token}` },
      signal,
    });
    const text = await response.text();
    if (!response.ok) {
      return failedLocation(reason, error, startedAt);
    }
    const payload = JSON.parse(text);
    const location = normalizeFindMyPayload(payload, startedAt, {
      source: "FindMy localhost /current fallback",
    });
    if (location.ok) return location;
  } catch {
    // Preserve the refresh failure as the user-facing reason.
  }
  return failedLocation(reason, error, startedAt);
}

function normalizeFindMyPayload(payload, startedAt, {
  source,
} = {}) {
  const current = payload?.current || payload;
  const person = current?.primaryPerson || {};
  const fetchedAt =
    current?.generatedAt ||
    payload?.generatedAt ||
    startedAt.toISOString();
  const location = {
    ok: Boolean(current?.ok && (person.address || person.latitude || person.longitude)),
    source: source || "FindMy localhost",
    fetchedAt,
    displayName: person.displayName || null,
    address: person.address || null,
    latitude: numberOrNull(person.latitude),
    longitude: numberOrNull(person.longitude),
    mapsUrl: person.mapsUrl || null,
    runtimeAuthority: current?.runtimeAuthority || payload?.runtimeAuthority || null,
    rawStatus: person.status || null,
  };
  location.freshness = location.ok ? freshnessForStatus(location.rawStatus) : "unavailable";
  return location;
}

function freshnessForStatus(status) {
  if (status === "fresh-row-coordinate-fallback") return "fresh row + fallback coords";
  return "fresh";
}

async function resolveTimeZoneForLocation(location, {
  config,
  readFileImpl,
}) {
  const fallback = fallbackTimeZone(config);
  if (!Number.isFinite(location?.latitude) || !Number.isFinite(location?.longitude)) {
    return fallback;
  }
  const timeZone = await inferTimeZoneFromCoordinates({
    latitude: location.latitude,
    longitude: location.longitude,
    zoneTabPath: config.currentLocationTimeZoneDbPath || DEFAULT_TIME_ZONE_DB_PATH,
    readFileImpl,
  });
  return timeZone || fallback;
}

function fallbackTimeZone(config) {
  return (
    config.currentContextTimeZone ||
    config.currentSystemTimeZone ||
    systemTimeZone()
  );
}

function systemTimeZone() {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || null;
  } catch {
    return null;
  }
}

async function inferTimeZoneFromCoordinates({
  latitude,
  longitude,
  zoneTabPath,
  readFileImpl,
}) {
  let text;
  try {
    text = await readFileImpl(zoneTabPath, "utf8");
  } catch {
    return null;
  }
  const zones = parseZoneTab(text);
  let best = null;
  for (const zone of zones) {
    const distance = haversineKm(latitude, longitude, zone.latitude, zone.longitude);
    if (!best || distance < best.distance) {
      best = { zone: zone.name, distance };
    }
  }
  return best?.zone || null;
}

function parseZoneTab(text) {
  const zones = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    if (!line || line.startsWith("#")) continue;
    const fields = line.split("\t");
    if (fields.length < 3) continue;
    const coordinates = parseZoneCoordinates(fields[1]);
    if (!coordinates) continue;
    zones.push({
      name: fields[2],
      latitude: coordinates.latitude,
      longitude: coordinates.longitude,
    });
  }
  return zones;
}

function parseZoneCoordinates(value) {
  const match = String(value || "").match(/^([+-]\d{4,6})([+-]\d{5,7})$/);
  if (!match) return null;
  const latitude = parseZoneCoordinateComponent(match[1], 2);
  const longitude = parseZoneCoordinateComponent(match[2], 3);
  if (!Number.isFinite(latitude) || !Number.isFinite(longitude)) return null;
  return { latitude, longitude };
}

function parseZoneCoordinateComponent(value, degreeDigits) {
  const sign = value.startsWith("-") ? -1 : 1;
  const digits = value.slice(1);
  const degrees = Number(digits.slice(0, degreeDigits));
  const minutes = Number(digits.slice(degreeDigits, degreeDigits + 2) || 0);
  const seconds = Number(digits.slice(degreeDigits + 2, degreeDigits + 4) || 0);
  if (![degrees, minutes, seconds].every(Number.isFinite)) return null;
  return sign * (degrees + minutes / 60 + seconds / 3600);
}

function haversineKm(lat1, lon1, lat2, lon2) {
  const radiusKm = 6371;
  const dLat = toRadians(lat2 - lat1);
  const dLon = toRadians(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRadians(lat1)) *
      Math.cos(toRadians(lat2)) *
      Math.sin(dLon / 2) ** 2;
  return 2 * radiusKm * Math.asin(Math.sqrt(a));
}

function toRadians(degrees) {
  return (degrees * Math.PI) / 180;
}

function cleanupFindMy({ config, execFileImpl }) {
  const stopBin = config.currentLocationStopBin || DEFAULT_STOP_BIN;
  execFileImpl("/usr/bin/sudo", ["-n", stopBin], { timeout: 5_000 }, () => {});
}

function disabledLocation() {
  return {
    ok: false,
    source: "disabled",
    fetchedAt: new Date().toISOString(),
    freshness: "disabled",
  };
}

function failedLocation(reason, error, startedAt) {
  return {
    ok: false,
    source: "FindMy localhost /refresh",
    fetchedAt: startedAt.toISOString(),
    freshness: `unavailable: ${reason}${error ? ` (${briefError(error)})` : ""}`,
  };
}

function formatLocation(location) {
  if (!location?.ok) return "unavailable";
  const parts = [];
  if (location.displayName) parts.push(location.displayName);
  if (location.address) parts.push(location.address);
  if (Number.isFinite(location.latitude) && Number.isFinite(location.longitude)) {
    parts.push(`${location.latitude},${location.longitude}`);
  }
  if (location.mapsUrl) parts.push(location.mapsUrl);
  return parts.join(" | ") || "available";
}

function formatLocalTime(date, timeZone) {
  if (!timeZone) return date.toISOString();
  try {
    const offset = offsetForTimeZone(date, timeZone);
    return `${formatDateTimeParts(date, timeZone)} ${timeZone} (${offset})`;
  } catch {
    return date.toISOString();
  }
}

function formatDateTimeParts(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("sv-SE", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  return formatter.format(date).replace(" ", "T");
}

function offsetForTimeZone(date, timeZone) {
  const formatter = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  });
  const part = formatter
    .formatToParts(date)
    .find((item) => item.type === "timeZoneName")?.value;
  return part?.replace("GMT", "UTC") || "UTC";
}

function numberOrNull(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function briefError(error) {
  if (typeof error === "string") return error.slice(0, 160);
  return String(error?.message || error).slice(0, 160);
}
