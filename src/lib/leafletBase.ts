// The base map every Leaflet map in the app uses: the configured tile layer (see mapTiles.ts) and, for Mapbox tiles, the logo and
// "Improve this map" link Mapbox requires.
import type * as Leaflet from "leaflet";
import { tileConfig } from "@/lib/mapTiles";

export function addBaseLayer(L: typeof Leaflet, instance: Leaflet.Map) {
  const tiles = tileConfig();
  L.tileLayer(tiles.url, {
    maxZoom: tiles.maxZoom,
    tileSize: tiles.tileSize,
    zoomOffset: tiles.zoomOffset,
    attribution: tiles.attribution,
  }).addTo(instance);
  if (tiles.mapboxLogoPath) {
    // Mapbox requires its logo on any map built from its tiles, at least 30 px high, unmodified, bottom left, plus the credit text
    // (added by the tile layer attribution above). Its "Improve this map" link carries the current position and zoom.
    const path = tiles.mapboxLogoPath;
    const LogoControl = L.Control.extend({
      onAdd() {
        const a = L.DomUtil.create("a", "leaflet-control");
        a.href = "https://www.mapbox.com/";
        a.target = "_blank";
        a.rel = "noopener";
        a.style.display = "block";
        const img = document.createElement("img");
        img.src = path;
        img.alt = "Mapbox";
        img.style.height = "30px";
        img.style.width = "auto";
        img.style.display = "block";
        img.onerror = () => console.error(`The Mapbox logo file ${path} is missing: Mapbox tiles must not be used without it (see src/lib/mapTiles.ts).`);
        a.appendChild(img);
        L.DomEvent.disableClickPropagation(a);
        return a;
      },
    });
    new LogoControl({ position: "bottomleft" }).addTo(instance);
    // The link's address is set at the moment it is clicked (capture phase, before the browser follows it), so it is always current.
    instance.getContainer().addEventListener(
      "click",
      (e) => {
        const link = (e.target as Element | null)?.closest?.("a.mb-improve") as HTMLAnchorElement | null;
        if (!link) return;
        const c = instance.getCenter();
        link.href = `https://apps.mapbox.com/feedback/#/${c.lng.toFixed(5)}/${c.lat.toFixed(5)}/${Math.round(instance.getZoom())}`;
      },
      true
    );
  }
}
