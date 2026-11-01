import { redirect } from "next/navigation";

// The Dimension Reduction page became the UMAP and t-SNE tabs of Multivariate tools; old links still work.
export default function DimensionReductionPage() {
  redirect("/tools/multivariate");
}
