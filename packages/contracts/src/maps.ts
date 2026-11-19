/**
 * Google Maps links without an API key: the Maps URLs search format opens the
 * app on phones and the website on desktops.
 * https://developers.google.com/maps/documentation/urls/get-started
 */
export function googleMapsUrl(place: { query?: string | null; name?: string; near?: string | null; lat?: number | null; lon?: number | null }): string {
  const text = place.query?.trim() || [place.name, place.near].filter(Boolean).join(", ");
  const query = text || (place.lat != null && place.lon != null ? `${place.lat},${place.lon}` : "");
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(query)}`;
}
