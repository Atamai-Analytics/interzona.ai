import type { Metadata } from "next";
import { InterceptsApp } from "@/components/intercepts/InterceptsApp";

export const metadata: Metadata = { title: "Drill intercepts | Interzona", robots: { index: false, follow: false } };

export default function InterceptsPage() {
  return <InterceptsApp />;
}
