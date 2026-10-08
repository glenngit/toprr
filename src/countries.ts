import * as streamingAvailability from "streaming-availability";
import { quotaFetch } from "./quota.js";

export interface ServiceOption {
  id: string;
  name: string;
  /** Dark-theme logo URL from the API media CDN (SVG), if available. */
  darkThemeImage?: string;
}

export interface CountryOption {
  code: string;
  name: string;
  services: ServiceOption[];
}

/**
 * Discover the countries and streaming services supported for a given API key,
 * via the Streaming Availability API's /countries endpoint.
 *
 * The web GUI uses this to populate the country dropdown and, per country, the
 * list of selectable streaming services (with real display names). The API key
 * is used server-side only.
 */
export async function discoverCountries(
  apiKey: string,
): Promise<CountryOption[]> {
  const client = new streamingAvailability.Client(
    new streamingAvailability.Configuration({ apiKey, fetchApi: quotaFetch }),
  );
  const countries = await client.countriesApi.getCountries();

  return Object.values(countries)
    .map((c) => ({
      code: c.countryCode,
      name: c.name,
      services: (c.services ?? [])
        .map((s) => ({
          id: s.id,
          name: s.name,
          darkThemeImage: s.imageSet?.darkThemeImage,
        }))
        .sort((a, b) => a.name.localeCompare(b.name)),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}
