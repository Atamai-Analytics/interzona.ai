import type { Metadata } from "next";
import { GeostatApp } from "@/components/geostatistics/GeostatApp";

export const metadata: Metadata = { title: "Geostatistics | Interzona", robots: { index: false, follow: false } };

export default function GeostatisticsPage() {
  return <GeostatApp />;
}
