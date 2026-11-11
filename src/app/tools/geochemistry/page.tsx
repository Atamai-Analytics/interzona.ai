import type { Metadata } from "next";
import { GeochemApp } from "@/components/geochemistry/GeochemApp";

export const metadata: Metadata = { title: "Geochemistry | Interzona", robots: { index: false, follow: false } };

export default function GeochemistryPage() {
  return <GeochemApp />;
}
