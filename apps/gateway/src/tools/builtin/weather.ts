/**
 * `weather`: current conditions + a short daily forecast from Open-Meteo
 * (free, no API key).
 */
import type { ToolDefinition } from "@open-gpt-live/core";
import { errorResult, fetchJson, stringInput, type FetchLike } from "./http.js";

const GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search";
const FORECAST_URL = "https://api.open-meteo.com/v1/forecast";

const WMO_CODES: Record<number, string> = {
  0: "clear sky", 1: "mainly clear", 2: "partly cloudy", 3: "overcast",
  45: "fog", 48: "depositing rime fog",
  51: "light drizzle", 53: "drizzle", 55: "dense drizzle", 56: "light freezing drizzle", 57: "freezing drizzle",
  61: "light rain", 63: "rain", 65: "heavy rain", 66: "light freezing rain", 67: "freezing rain",
  71: "light snow", 73: "snow", 75: "heavy snow", 77: "snow grains",
  80: "light showers", 81: "showers", 82: "violent showers", 85: "light snow showers", 86: "snow showers",
  95: "thunderstorm", 96: "thunderstorm with light hail", 99: "thunderstorm with heavy hail"
};

export const describeWeatherCode = (code: number | undefined): string =>
  code === undefined ? "unknown" : WMO_CODES[code] ?? `code ${code}`;

interface GeoResult {
  name: string;
  latitude: number;
  longitude: number;
  country?: string;
  country_code?: string;
  admin1?: string;
  timezone?: string;
}

interface ForecastResponse {
  timezone?: string;
  current?: Record<string, number | string>;
  current_units?: Record<string, string>;
  daily?: Record<string, Array<number | string | null>>;
  daily_units?: Record<string, string>;
}

export interface WeatherInput {
  location?: string;
  latitude?: number;
  longitude?: number;
  days?: number;
  units?: "metric" | "imperial";
}

export interface WeatherData {
  place: { name: string; latitude: number; longitude: number; country?: string; region?: string; timezone?: string };
  units: "metric" | "imperial";
  current?: {
    time?: string;
    temperature?: number;
    feelsLike?: number;
    humidity?: number;
    windSpeed?: number;
    precipitation?: number;
    condition: string;
    isDay?: boolean;
  };
  daily: Array<{
    date: string;
    condition: string;
    min?: number;
    max?: number;
    precipitationProbability?: number;
    precipitation?: number;
  }>;
}

async function geocode(fetchImpl: FetchLike, query: string, signal: AbortSignal): Promise<GeoResult | undefined> {
  const [name, ...qualifiers] = query.split(",").map((part) => part.trim()).filter(Boolean);
  const url = `${GEOCODING_URL}?${new URLSearchParams({ name: name ?? query, count: "10", language: "en", format: "json" })}`;
  const body = await fetchJson<{ results?: GeoResult[] }>(fetchImpl, url, { signal });
  const results = body?.results ?? [];
  if (qualifiers.length > 0) {
    const wanted = qualifiers.map((q) => q.toLowerCase());
    const match = results.find((result) =>
      wanted.every((q) =>
        [result.country, result.country_code, result.admin1].some((field) => field?.toLowerCase() === q || field?.toLowerCase().startsWith(q))
      )
    );
    if (match) return match;
  }
  return results[0];
}

const num = (value: unknown): number | undefined => (typeof value === "number" && Number.isFinite(value) ? value : undefined);

export function createWeatherTool(fetchImpl: FetchLike): ToolDefinition<WeatherInput, WeatherData> {
  return {
    name: "weather",
    title: "Weather",
    description:
      "Current weather and a daily forecast (up to 7 days) for a place, from Open-Meteo. " +
      "Give a city name (optionally \"City, Country\") or latitude/longitude. Metric units (°C, km/h, mm) by default; " +
      "pass units \"imperial\" for °F, mph, inches.",
    inputSchema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Place name, e.g. \"Lisbon\" or \"Springfield, Illinois\"." },
        latitude: { type: "number", minimum: -90, maximum: 90 },
        longitude: { type: "number", minimum: -180, maximum: 180 },
        days: { type: "integer", minimum: 1, maximum: 7, description: "Forecast days including today (default 4)." },
        units: { type: "string", enum: ["metric", "imperial"], description: "Default metric." }
      },
      additionalProperties: false
    },
    effect: "read",
    source: "builtin",
    async run(input, context) {
      const units = input?.units === "imperial" ? "imperial" : "metric";
      const days = Math.min(7, Math.max(1, Math.round(Number(input?.days) || 4)));
      try {
        let place: WeatherData["place"];
        const location = stringInput(input?.location);
        if (typeof input?.latitude === "number" && typeof input?.longitude === "number") {
          place = { name: location ?? `${input.latitude.toFixed(3)}, ${input.longitude.toFixed(3)}`, latitude: input.latitude, longitude: input.longitude };
        } else if (location) {
          const found = await geocode(fetchImpl, location, context.signal);
          if (!found) return { content: `Weather: no place found for "${location}". Try a larger nearby city or add the country.`, isError: true };
          place = {
            name: found.name,
            latitude: found.latitude,
            longitude: found.longitude,
            country: found.country,
            region: found.admin1,
            timezone: found.timezone
          };
        } else {
          return { content: "Weather failed: give a location or latitude/longitude.", isError: true };
        }

        const params = new URLSearchParams({
          latitude: String(place.latitude),
          longitude: String(place.longitude),
          current: "temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,is_day",
          daily: "weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,precipitation_sum",
          timezone: "auto",
          forecast_days: String(days)
        });
        if (units === "imperial") {
          params.set("temperature_unit", "fahrenheit");
          params.set("wind_speed_unit", "mph");
          params.set("precipitation_unit", "inch");
        }
        const forecast = await fetchJson<ForecastResponse>(fetchImpl, `${FORECAST_URL}?${params}`, { signal: context.signal });
        place.timezone = forecast.timezone ?? place.timezone;

        const c = forecast.current ?? {};
        const current: WeatherData["current"] = forecast.current
          ? {
              time: typeof c.time === "string" ? c.time : undefined,
              temperature: num(c.temperature_2m),
              feelsLike: num(c.apparent_temperature),
              humidity: num(c.relative_humidity_2m),
              windSpeed: num(c.wind_speed_10m),
              precipitation: num(c.precipitation),
              condition: describeWeatherCode(num(c.weather_code)),
              isDay: c.is_day === undefined ? undefined : Number(c.is_day) === 1
            }
          : undefined;
        const d = forecast.daily ?? {};
        const dates = (d.time ?? []) as string[];
        const daily: WeatherData["daily"] = dates.map((date, i) => ({
          date,
          condition: describeWeatherCode(num(d.weather_code?.[i])),
          min: num(d.temperature_2m_min?.[i]),
          max: num(d.temperature_2m_max?.[i]),
          precipitationProbability: num(d.precipitation_probability_max?.[i]),
          precipitation: num(d.precipitation_sum?.[i])
        }));

        const t = units === "imperial" ? "°F" : "°C";
        const wind = units === "imperial" ? "mph" : "km/h";
        const rain = units === "imperial" ? "in" : "mm";
        const where = [place.name, place.region, place.country].filter(Boolean).join(", ");
        const lines = [`Weather for ${where}${place.timezone ? ` (${place.timezone})` : ""}:`];
        if (current) {
          lines.push(
            `Now: ${current.condition}, ${fmt(current.temperature)}${t} (feels ${fmt(current.feelsLike)}${t}), ` +
              `humidity ${fmt(current.humidity)}%, wind ${fmt(current.windSpeed)} ${wind}` +
              (current.precipitation ? `, precipitation ${fmt(current.precipitation)} ${rain}` : "")
          );
        }
        for (const day of daily) {
          lines.push(
            `${day.date}: ${day.condition}, ${fmt(day.min)}–${fmt(day.max)}${t}` +
              (day.precipitationProbability !== undefined ? `, ${day.precipitationProbability}% chance of precipitation` : "") +
              (day.precipitation ? ` (${fmt(day.precipitation)} ${rain})` : "")
          );
        }
        return { content: lines.join("\n"), data: { place, units, current, daily } };
      } catch (error) {
        return errorResult("Weather lookup failed", error, context.signal);
      }
    }
  };
}

const fmt = (value: number | undefined): string => (value === undefined ? "?" : String(Math.round(value * 10) / 10));
