"use client";

import dynamic from "next/dynamic";
import type { MapData } from "@/lib/types";

const MapView = dynamic(() => import("@/components/MapView"), { ssr: false });

export function MemoMap({ map, credits }: { map: MapData; credits: string[] }) {
  return <MapView map={map} credits={credits} light />;
}
