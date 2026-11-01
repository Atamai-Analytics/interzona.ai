// Which tile server the map uses. Set NEXT_PUBLIC_MAP_TILE_URL (and, if the provider needs it, the attribution and tile size) in the environment to
// switch to a hosted provider; with nothing set the map uses OpenStreetMap's free public tiles, which are fine for a demo but not for heavy use.
//
// Examples (the key is part of the URL; these values are public in the browser by design, so restrict the key to the app's domain at the provider):
//   MapTiler  NEXT_PUBLIC_MAP_TILE_URL=https://api.maptiler.com/maps/streets-v2/{z}/{x}/{y}.png?key=YOUR_KEY
//             NEXT_PUBLIC_MAP_TILE_ATTRIBUTION=<a href="https://www.maptiler.com/copyright/">&copy; MapTiler</a> <a href="https://www.openstreetmap.org/copyright">&copy; OpenStreetMap contributors</a>
//   Stadia    NEXT_PUBLIC_MAP_TILE_URL=https://tiles.stadiamaps.com/tiles/alidade_smooth/{z}/{x}/{y}{r}.png?api_key=YOUR_KEY
//   Mapbox    NEXT_PUBLIC_MAP_TILE_URL=https://api.mapbox.com/styles/v1/mapbox/outdoors-v12/tiles/512/{z}/{x}/{y}?access_token=YOUR_PUBLIC_TOKEN
//             NEXT_PUBLIC_MAP_TILE_SIZE=512   (Mapbox style tiles are 512 px; the map then requests them at zoom offset -1; 256 px tiles cost 4x the requests)
//             Use a PUBLIC token (pk.), restricted to this app's URL. With a Mapbox URL the map automatically shows Mapbox's required text credit
//             (Mapbox, OpenStreetMap, Improve this map) and its logo. The logo file is NOT in the repository: download it from Mapbox's Press page
//             (https://www.mapbox.com/about/press/brand-guidelines) and save the black version, wordmark and icon together, unmodified, as
//             public/mapbox-logo.svg (or set NEXT_PUBLIC_MAPBOX_LOGO_PATH to another file under public/). Do not deploy a Mapbox URL without it.

const OSM_URL = "https://tile.openstreetmap.org/{z}/{x}/{y}.png";
const OSM_ATTRIBUTION = '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors';
// Mapbox's own Leaflet wording: the Improve this map link is updated with the current position by the map component (class mb-improve).
const MAPBOX_ATTRIBUTION =
  '&copy; <a href="https://www.mapbox.com/about/maps" target="_blank" rel="noopener">Mapbox</a> ' +
  '&copy; <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noopener">OpenStreetMap</a> ' +
  '<strong><a class="mb-improve" href="https://apps.mapbox.com/feedback/" target="_blank" rel="noopener">Improve this map</a></strong>';

export type TileConfig = {
  url: string;
  attribution: string;
  maxZoom: number;
  tileSize: number;
  zoomOffset: number;
  hosted: boolean;
  /** Set when the tiles come from Mapbox: its logo and credit are then required on the map. */
  mapboxLogoPath: string | null;
};

// process.env.NEXT_PUBLIC_* must be written out in full so Next can inline the values into the browser bundle.
export function tileConfig(): TileConfig {
  const url = (process.env.NEXT_PUBLIC_MAP_TILE_URL ?? "").trim();
  const valid = /^https:\/\//.test(url) && url.includes("{z}") && url.includes("{x}") && url.includes("{y}");
  if (!valid) {
    if (url) console.warn("NEXT_PUBLIC_MAP_TILE_URL must be an https URL containing {z}, {x} and {y}; using OpenStreetMap instead.");
    return { url: OSM_URL, attribution: OSM_ATTRIBUTION, maxZoom: 12, tileSize: 256, zoomOffset: 0, hosted: false, mapboxLogoPath: null };
  }
  let host = "";
  try {
    host = new URL(url.replace(/\{[a-z]+\}/g, "0")).hostname;
  } catch {
    host = "";
  }
  const isMapbox = host === "api.mapbox.com" || host.endsWith(".tiles.mapbox.com");
  const size = Number(process.env.NEXT_PUBLIC_MAP_TILE_SIZE) === 512 ? 512 : 256;
  const maxZoom = Math.min(Math.max(Math.floor(Number(process.env.NEXT_PUBLIC_MAP_MAX_ZOOM) || 16), 3), 20);
  const custom = (process.env.NEXT_PUBLIC_MAP_TILE_ATTRIBUTION ?? "").trim();
  return {
    url,
    attribution: custom || (isMapbox ? MAPBOX_ATTRIBUTION : OSM_ATTRIBUTION),
    maxZoom: size === 512 ? maxZoom - 1 : maxZoom,
    tileSize: size,
    zoomOffset: size === 512 ? -1 : 0,
    hosted: true,
    mapboxLogoPath: isMapbox ? (process.env.NEXT_PUBLIC_MAPBOX_LOGO_PATH ?? "").trim() || "/mapbox-logo.svg" : null,
  };
}
