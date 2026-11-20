import type { Metadata } from "next";
import { RiskApp } from "@/components/risk/RiskApp";

export const metadata: Metadata = { title: "Supply risk | Interzona", robots: { index: false, follow: false } };

export default function RiskPage() {
  return <RiskApp />;
}
