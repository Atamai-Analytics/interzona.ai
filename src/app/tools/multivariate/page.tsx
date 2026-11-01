import type { Metadata } from "next";
import { MultivariateApp } from "@/components/multivariate/MultivariateApp";

export const metadata: Metadata = { title: "Multivariate tools | Interzona", robots: { index: false, follow: false } };

export default function MultivariatePage() {
  return <MultivariateApp />;
}
