"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { Coverage } from "@/lib/coverage";

const n = (v: number) => v.toLocaleString("en-US");
/** 80,132,032 -> "about 80 million"; 2,535,335 -> "about 2.5 million" (row counts here are planner estimates, so round them). */
const approx = (v: number) => (v >= 10_000_000 ? `about ${Math.round(v / 1_000_000)} million` : v >= 1_000_000 ? `about ${(Math.round(v / 100_000) / 10).toLocaleString("en-US")} million` : n(v));
const monthName = (ym: string) => new Date(ym + "-15").toLocaleDateString("en-GB", { month: "long", year: "numeric" });

type Tile = { title: string; figure: string; detail: string };

function tiles(c: Coverage | null): Tile[] {
  return [
    {
      title: "Deposits and occurrences",
      figure: c ? n(c.occurrences) : "Hundreds of thousands",
      detail: `mineral sites${c ? ` in ${c.occurrenceCountries} countries` : ""}, from national and regional geological survey catalogues, including seabed sites in European waters.`,
    },
    {
      title: "Rock and sediment chemistry",
      figure: c ? `${n(c.samples)} samples` : "Millions of samples",
      detail: `${c && c.analyses ? `${approx(c.analyses).replace(/^about/, "About")} analyses` : "Tens of millions of analyses"}${c && c.sampleSurveys ? ` from ${c.sampleSurveys} survey collections` : ""}: Canada (Québec, Saskatchewan, federal surveys), the USA, Australia (Tasmania, Victoria), Sweden, Spain, Finland, Greenland, Argentina and Germany.`,
    },
    {
      title: "Drill holes",
      figure: c && c.drillHoles ? `${approx(c.drillHoles)} holes` : "Drill holes",
      detail: "Collars, downhole assays and reported intercepts, mainly from Québec, Tasmania, Saskatchewan (Athabasca) and Sweden; ranked intercepts on the Drill intercepts page.",
    },
    {
      title: "Mines, smelters and refineries",
      figure: c && c.facilitySites ? `${n(c.facilitySites)} facility sites` : "Mineral facilities",
      detail: `${c && c.facilityCountries ? `In ${c.facilityCountries} countries, w` : "W"}ith capacities from the U.S. Geological Survey (2024 Minerals Yearbook and regional compilations), newest figure per facility.`,
    },
    {
      title: "Supply chain and trade",
      figure: c && c.tradeFlows ? `${approx(c.tradeFlows).replace(/^about/, "About")} trade flows` : "Trade and supply data",
      detail: `Mineral and metal trade 2012-2024 (CEPII BACI)${c && c.exportRestrictionCountries ? `, export restrictions in ${c.exportRestrictionCountries} countries (OECD)` : ", export restrictions (OECD)"}, EU import reliance${c && c.rmisMaterials ? ` for ${c.rmisMaterials} materials` : ""} (JRC), production concentration (USGS) and${c && c.eitiCountries ? ` payments to governments in ${c.eitiCountries} countries` : " payments to governments"} (EITI).`,
    },
    {
      title: "Research and policy library",
      figure: c ? `${n(c.documents)} documents` : "Hundreds of documents",
      detail: "Research papers, government and industry reports, and internal notes. Answers name the document and, where known, the page.",
    },
    {
      title: "Company financials",
      figure: c ? `${c.companies} companies` : "Selected miners",
      detail: c
        ? `Annual statements ${c.firstFiscalYear ?? ""}${c.lastFiscalYear ? `–${c.lastFiscalYear}` : ""}; ${c.companiesMultiYear} have three or more years, enough for trends and price-sensitivity tests.`
        : "Annual statements, with ten years for most.",
    },
    {
      title: "Commodity prices",
      figure: c ? `${c.priceSeries} series` : "Hundreds of series",
      detail: `Monthly prices from the IMF and World Bank${c?.latestMonthly ? ` to ${monthName(c.latestMonthly)}` : ""}, plus annual USGS series, and BIS exchange rates.`,
    },
    {
      title: "Projects and ownership",
      figure: c ? `${n(c.projects)} projects` : "Company projects",
      detail: c ? `Who owns what, with stakes. ${c.projectsPlaced} have a known position (some only to the nearest town), so only those can be shown on a map.` : "Who owns what, with stakes.",
    },
  ];
}

const LIMITS = [
  "Prices are monthly or annual averages, not live quotes, and the company financials are annual statements.",
  "Positions are as catalogued by the source. Some are only accurate to tens of kilometres, and not every asset can be placed on a map.",
  "Most geochemistry here is regional survey data: it points to anomalies worth a look. Drill-hole assays and intercepts are as reported or calculated from the assays; none of it is a resource estimate.",
  "Statistical links between prices and results rest on 8 to 10 annual points. They describe the past and are not forecasts.",
  "Answers are written by AI from this data and show the sources they used. Please check anything you will rely on. Nothing here is investment advice.",
];

export function IntroPanel() {
  const [cov, setCov] = useState<Coverage | null>(null);
  useEffect(() => {
    let live = true;
    fetch("/api/coverage")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && !d.error && setCov(d as Coverage))
      .catch(() => undefined);
    return () => {
      live = false;
    };
  }, []);

  return (
    <div className="mx-auto max-w-3xl space-y-6 py-2 text-sm text-gray-300">
      <div>
        <h2 className="text-lg font-semibold text-gray-100">Ask a question about critical minerals, in plain English</h2>
        <p className="mt-1 text-gray-400">
          The assistant looks things up in the database, runs the analysis, searches the document library and shows what it used. It can draw charts and maps, and compare companies
          against commodity prices. Start with one of the examples (the panel on the left, or the &quot;Examples &amp; history&quot; tab on a phone), or type your own question below.
        </p>
      </div>

      <div className="rounded-lg border border-emerald-700 bg-emerald-950/40 p-4">
        <p className="text-xs font-semibold uppercase tracking-wide text-emerald-400">Explore the data yourself</p>
        <div className="mt-2 grid gap-3 sm:grid-cols-3">
          {[
            { href: "/tools/geochemistry", title: "Geochemistry", text: "Pick samples and run classification, alteration, fertility and rare-earth diagrams, with an AI reading of each chart." },
            { href: "/tools/intercepts", title: "Drill intercepts", text: "Rank reported and calculated drill intercepts by element, grade and length, on a map." },
            { href: "/tools/multivariate", title: "Multivariate", text: "Correlation, PCA, clustering, UMAP and t-SNE on database samples or your own CSV, with CLR transforms and downloads." },
          ].map((t) => (
            <Link key={t.href} href={t.href} className="group block rounded-md border border-emerald-800/60 p-3 hover:border-emerald-500 hover:bg-emerald-900/40">
              <p className="text-sm font-semibold text-gray-100">{t.title} <span className="inline-block text-emerald-400 transition-transform group-hover:translate-x-0.5">→</span></p>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">{t.text}</p>
            </Link>
          ))}
        </div>
      </div>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">What it can draw on</h3>
        <div className="grid gap-3 sm:grid-cols-2">
          {tiles(cov).map((t) => (
            <div key={t.title} className="rounded-lg border border-gray-800 bg-gray-900/60 p-3">
              <p className="text-xs text-gray-500">{t.title}</p>
              <p className="mt-0.5 text-base font-semibold text-gray-100">{t.figure}</p>
              <p className="mt-1 text-xs leading-relaxed text-gray-400">{t.detail}</p>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-gray-500">Good to know</h3>
        <ul className="list-disc space-y-1.5 pl-5 text-xs leading-relaxed text-gray-400">
          {LIMITS.map((l) => (
            <li key={l}>{l}</li>
          ))}
          <li>The demo flows open a saved, dated answer straight away. Asking in your own words runs live on the current data and usually takes 10 to 30 seconds.</li>
        </ul>
      </section>
    </div>
  );
}
