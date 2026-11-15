import type { Metadata } from "next";
import { CoverageApp } from "@/components/coverage/CoverageApp";

export const metadata: Metadata = { title: "World coverage | Interzona", robots: { index: false, follow: false } };

export default function CoveragePage() {
  return <CoverageApp />;
}
