// Web worker for the Multivariate tools page: runs UMAP, t-SNE and clustering off the main thread.
import { UMAP } from "umap-js";
import { centroids, gmm, kmeans, rng, tsne, type GmmModel, type TsneParams } from "./math";

export type UmapParams = {
  nNeighbors: number;
  minDist: number;
  spread: number;
  nEpochs: number;
  metric: "euclidean" | "manhattan";
  learningRate: number;
  repulsionStrength: number;
  negativeSampleRate: number;
  setOpMixRatio: number;
  localConnectivity: number;
};

export type ClusterParams =
  | { kind: "kmeans"; k: number; iterMax: number; nstart: number }
  | { kind: "gmm"; G: number | "auto"; models: GmmModel[] | "all" };

export type Job =
  | { method: "umap"; X: number[][]; params: UmapParams; cluster: ClusterParams; seed: number }
  | { method: "tsne"; X: number[][]; params: TsneParams; cluster: ClusterParams; seed: number }
  | { method: "cluster"; X: number[][]; cluster: ClusterParams; seed: number }; // cluster X as given (e.g. PCA scores)

export type JobResult =
  | { type: "progress"; done: number; total: number }
  | { type: "result"; embedding: number[][]; clusters: number[]; centres: { cluster: number; x: number; y: number }[]; note: string; ms: number }
  | { type: "error"; message: string };

const post = (m: JobResult) => (self as unknown as Worker).postMessage(m);

self.onmessage = (e: MessageEvent<Job>) => {
  const job = e.data;
  const t0 = performance.now();
  try {
    const n = job.X.length;
    if (n < 5) throw new Error("At least 5 rows are needed.");
    if (job.X.some((r) => r.some((v) => !Number.isFinite(v)))) throw new Error("Some selected values are missing or not finite. Choose a Missing Values option on the Data tab, or remove the column.");
    let Y: number[][];
    if (job.method === "umap") {
      const p = job.params;
      if (p.nNeighbors >= n) throw new Error(`Nearest neighbours must be less than the number of rows (${n}).`);
      const umap = new UMAP({
        nComponents: 2,
        nNeighbors: p.nNeighbors,
        minDist: p.minDist,
        spread: p.spread,
        nEpochs: p.nEpochs,
        learningRate: p.learningRate,
        repulsionStrength: p.repulsionStrength,
        negativeSampleRate: p.negativeSampleRate,
        setOpMixRatio: p.setOpMixRatio,
        localConnectivity: p.localConnectivity,
        random: rng(job.seed),
        distanceFn: p.metric === "manhattan" ? (a, b) => a.reduce((s, v, i) => s + Math.abs(v - b[i]), 0) : undefined,
      });
      const epochs = umap.initializeFit(job.X);
      for (let i = 0; i < epochs; i++) {
        umap.step();
        if (i % 10 === 0) post({ type: "progress", done: i, total: epochs });
      }
      Y = umap.getEmbedding();
    } else if (job.method === "tsne") {
      Y = tsne(job.X, job.params, job.seed, (i) => post({ type: "progress", done: i, total: job.params.maxIter }));
    } else {
      Y = job.X;
    }

    let clusters: number[], note: string;
    const c = job.cluster;
    if (c.kind === "kmeans") {
      clusters = kmeans(Y, c.k, c.iterMax, c.nstart, job.seed);
      note = `K-means, ${c.k} clusters`;
    } else {
      const g = gmm(Y, c.G, c.models, job.seed);
      clusters = g.labels;
      note = `Gaussian mixture: ${g.G} cluster${g.G === 1 ? "" : "s"}, model ${g.model}, BIC ${g.bic.toFixed(1)}`;
    }
    post({ type: "result", embedding: Y, clusters, centres: centroids(Y, clusters), note, ms: performance.now() - t0 });
  } catch (err) {
    post({ type: "error", message: err instanceof Error ? err.message : String(err) });
  }
};
