import { Sandbox } from "@e2b/code-interpreter";
import fs from "fs";
import path from "path";

type ScriptEntry = {
  file: string;
  description: string;
  /** "json": plain script run via CLI, stdout parsed as JSON.
   *  "plot": run as a code cell (runCode) so a matplotlib figure is captured as an image;
   *  the script must define a function named by `entryPoint` that renders/shows a figure. */
  outputType: "json" | "plot";
  entryPoint?: string;
  /** "sample_ids": the geochemistry scripts — take an arbitrary set of sample_ids (one occurrence,
   *  many occurrences, a whole region, whatever the caller already resolved via run_sql). Not
   *  bound to a single occurrence.
   *  "occurrence_id": the lineament scripts — fundamentally need ONE center point + radius to
   *  search around (structural geology around a location, not a property of a sample set), so
   *  they keep the occurrence-centric interface rather than being forced into the sample_ids shape.
   *  "financial_assumptions": the project-economics scripts — take a caller-supplied JSON object
   *  of annual assumptions (no DB lookup at all; this schema has no mine-plan/capex/opex data).
   *  "sample_ids_or_filter": like "sample_ids", but the script can also select the samples itself (dataset, lithology,
   *  bounding box) from keyword options, for regional runs where listing thousands of sample_ids is not workable. */
  selection: "sample_ids" | "sample_ids_or_filter" | "occurrence_id" | "financial_assumptions";
  /** Which tool surfaces this script: geochem scripts are advertised in run_geochem_analysis's
   *  tool description, financial scripts in run_financial_model's — kept separate so each tool's
   *  description only lists scripts that actually fit its input shape. */
  category: "geochem" | "financial";
  /** Optional smaller requirements file in analytics-scripts/ (default requirements.txt, which installs every
   *  script's dependencies -- pyrolite from GitHub, geopandas, fractopo -- on every call). */
  requirements?: string;
};

/**
 * Curated registry of vetted analytics scripts the agent may invoke — deliberately NOT
 * "clone and run whatever GitHub repo the model names." Each entry here has been reviewed,
 * tested against real data, and knows what this database's schema actually looks like.
 * Adding a new script means adding an entry here, not exposing a generic git-clone tool.
 */
const SCRIPT_REGISTRY: Record<string, ScriptEntry> = {
  ree_pattern_analysis: {
    file: "ree_pattern_analysis.py",
    description:
      "Chondrite-normalized REE pattern analysis for an arbitrary set of sample_ids: La/Yb ratio, Eu anomaly, lambda-tau pattern coefficients, computed across whatever samples you pass in (one occurrence, many occurrences, a whole region). Returns numbers, not a plot.",
    outputType: "json",
    selection: "sample_ids",
    category: "geochem",
  },
  ree_spider_plot: {
    file: "ree_spider_plot.py",
    description:
      "Generates a chondrite-normalized REE spider diagram (log-scale multi-element pattern plot) for an arbitrary set of sample_ids — every sample's pattern is plotted together, so this works equally well for one occurrence or a combined selection across many. Returns an image, not numbers.",
    outputType: "plot",
    entryPoint: "generate_spider_plot",
    selection: "sample_ids",
    category: "geochem",
  },
  extended_spider_plot: {
    file: "extended_spider_plot.py",
    description:
      "Generates a primitive-mantle-normalized EXTENDED multi-element spider diagram (LILE+HFSE+REE, up to 20 elements) for an arbitrary set of sample_ids — broader and generally more informative than the REE-only plot. Returns an image, not numbers.",
    outputType: "plot",
    entryPoint: "generate_extended_spider_plot",
    selection: "sample_ids",
    category: "geochem",
  },
  lineament_network_stats: {
    file: "lineament_network_stats.py",
    requirements: "requirements-lineament.txt",
    description:
      "Structural analysis of fault/fold lineaments within a radius (default 50km, param radius_km) of an occurrence, using fractopo: trace count/length statistics, orientation-set counts, and a power-law/lognormal/exponential length-distribution fit. Returns numbers, not a plot. NOTE: unlike the geochemistry scripts, this one still takes a single occurrence_id — it searches a radius around one point, which isn't a property of a sample set.",
    outputType: "json",
    selection: "occurrence_id",
    category: "geochem",
  },
  lineament_rose_diagram: {
    file: "lineament_rose_diagram.py",
    requirements: "requirements-lineament.txt",
    description:
      "Generates a length-weighted rose diagram (orientation frequency) of fault/fold lineaments within a radius (default 50km, param radius_km) of an occurrence, using fractopo. Returns an image, not numbers. Same single-occurrence_id interface as lineament_network_stats, for the same reason (radius search around one point).",
    outputType: "plot",
    entryPoint: "generate_rose_diagram",
    selection: "occurrence_id",
    category: "geochem",
  },
  pearce_discrimination_plot: {
    file: "pearce_discrimination_plot.py",
    description:
      "Pearce (2008) Th/Yb vs Nb/Yb tectonic discrimination diagram for an arbitrary set of sample_ids (magma source/tectonic setting fingerprinting). Requires Th+Nb+Yb data — only ~169 of ~1,320 occurrences have Nb analysed, so check coverage with run_sql first. Returns an image, not numbers.",
    outputType: "plot",
    entryPoint: "generate_pearce_plot",
    selection: "sample_ids",
    category: "geochem",
  },
  pearce_ti_discrimination_plot: {
    file: "pearce_ti_discrimination_plot.py",
    description:
      "Pearce (2008) TiO2/Yb vs Nb/Yb tectonic discrimination diagram for an arbitrary set of sample_ids — a companion check to pearce_discrimination_plot using Ti instead of Th (different geochemical behavior, useful as an independent cross-check). Requires Ti+Nb+Yb data — same Nb bottleneck, check coverage with run_sql first. Returns an image, not numbers.",
    outputType: "plot",
    entryPoint: "generate_pearce_ti_plot",
    selection: "sample_ids",
    category: "geochem",
  },
  alteration_box_plot: {
    file: "alteration_box_plot.py",
    description:
      "Large et al. (1998) hydrothermal alteration box plot (CCPI vs. Ishikawa Alteration Index) for an arbitrary set of sample_ids — the standard VMS/epithermal exploration tool for distinguishing barren host rock from ore-proximal alteration. Requires major-oxide data (SiO2/Al2O3/CaO/Na2O/K2O/MgO + an iron oxide measure) — total-basis oxides with an iron measure exist for about 6,100 Greenland, 6,250 Finnish, 11,700 Swedish and 68,000 USGS samples; Argentina (SEGEMAR) and Victoria (GSV) have none. Check coverage with run_sql first if unsure. Returns an image, not numbers.",
    outputType: "plot",
    entryPoint: "generate_alteration_box_plot",
    selection: "sample_ids",
    category: "geochem",
  },
  ree_lambda_shape_plot: {
    file: "ree_lambda_shape_plot.py",
    description:
      "Per-sample REE pattern 'shape space' scatter plot (lambda-tau orthogonal polynomial coefficients, O'Neill 2016) for an arbitrary set of sample_ids — unlike ree_pattern_analysis (which averages a whole selection into one number), this fits lambda0-lambda3 PER SAMPLE and plots lambda1 vs lambda2 so you can see at a glance whether a discovered set of samples/occurrences shares one REE pattern shape or splits into distinct groups. Samples with too few REE elements analysed are dropped and reported, not silently ignored. Returns an image, not numbers.",
    outputType: "plot",
    entryPoint: "generate_lambda_shape_plot",
    selection: "sample_ids",
    category: "geochem",
  },
  tas_classification_plot: {
    file: "tas_classification_plot.py",
    description:
      "TAS (Total Alkali-Silica) igneous rock classification diagram (Middlemost 1994 / Le Bas et al. 1992) for an arbitrary set of sample_ids — classifies whole-rock major-oxide analyses into standard rock names (basalt, andesite, rhyolite, trachyte, etc. / their plutonic equivalents). Needs only SiO2+Na2O+K2O (broader coverage than alteration_box_plot's 6-oxide requirement) — Oxide coverage (total-basis SiO2+Na2O+K2O): about 6,100 Greenland, 6,400 Finnish, 18,500 Swedish and 70,000 USGS samples; Argentina (SEGEMAR) and Victoria (GSV) have none. CAVEAT: Na2O/K2O are alteration-mobile, so classification is unreliable for samples also flagged as altered. Returns an image, not numbers.",
    outputType: "plot",
    entryPoint: "generate_tas_plot",
    selection: "sample_ids",
    category: "geochem",
  },
  clr_correlation_analysis: {
    file: "clr_correlation_analysis.py",
    requirements: "requirements-clr.txt",
    description:
      "CLR (centred log-ratio) transformed element correlation analysis for an arbitrary set of sample_ids — the statistically correct way to find real element associations in compositional (closed-sum) geochemical data, reported alongside the naive raw-ppm correlation for comparison. Returns numbers, not a plot.",
    outputType: "json",
    selection: "sample_ids",
    category: "geochem",
  },
  halley_plots: {
    file: "halley_plots.py",
    description:
      "Halley (2020) rock-composition and alteration chart workflow, ONE figure per call (parameter `figure`): sc_vs (Sc versus Th, Ti, V, Nb with density contours), v_sc (V/Sc versus Sc: magnetite versus amphibole/pyroxene fractionation), sr_y (Sr/Y versus Y: high-pressure hydrous melting; the paper's reference fields are not drawn), sc_ni_cu (Sc versus Ni and Cu: sulfide saturation or leaching), hf_zr (zircon fractionation), ti_nb, ta_nb_ti (biotite fractionation), k_al_na_al (K/Al versus Na/Al molar, alteration mineralogy with end-member minerals), the element wt % ternaries ca_k_na (hydrothermal feldspar, sericite, carbonate), al_k_mg (sericite, chlorite, advanced argillic clays) and ca_fe_mg (carbonate and pyrite) and ca_fe_s (anhydrite versus pyrite), and rb_k, ca_mg (dolomite line) and fe_s (pyrite line). Unlike the other scripts it can select the samples itself, so use it for regions: give source_system (a dataset code such as FINLAND_GTK_ROCK) and optionally lithology_category or a bounding box (min_lon, min_lat, max_lon, max_lat) INSTEAD of sample_ids; sample_ids also work. TOTAL-basis analyses only (partial digestions are never used), so Argentina (SEGEMAR) and Victoria (GSV) have nothing it can use, Sweden lacks Ti and Nb, and Finland, Greenland and the USGS data are the best. No SWIR information exists and none is used: points are coloured by logged lithology. Returns an image plus a numeric summary (counts, correlations, quartiles).",
    outputType: "plot",
    entryPoint: "generate_halley_plot",
    selection: "sample_ids_or_filter",
    category: "geochem",
  },
  project_dcf_model: {
    file: "project_dcf_model.py",
    requirements: "requirements-dcf.txt",
    description:
      "Single-commodity, single-ore-stream discounted cash flow (DCF) model — computes NPV, IRR, payback period, and a one-way sensitivity ranking from a set of ANNUAL ASSUMPTIONS YOU OR THE USER SUPPLY (recovered_units_annual, price_per_unit, operating_costs_annual, capex_annual, tax_rate, discount_rate; optional royalty_pct, refining_cost_per_unit, commodity_name, commodity_unit). This does NOT look anything up from the database — there is no mine-plan/capex/opex/project-economics data in this schema, only company-level financial statements. Never invent plausible-sounding numbers; ask the user for real assumptions or cite an external source. Returns an image (cash-flow chart + sensitivity tornado) plus the full numeric breakdown.",
    outputType: "plot",
    entryPoint: "generate_dcf_plot",
    selection: "financial_assumptions",
    category: "financial",
  },
};

export function listRegisteredScripts(category?: "geochem" | "financial") {
  return Object.entries(SCRIPT_REGISTRY)
    .filter(([, v]) => !category || v.category === category)
    .map(([name, v]) => ({
      name,
      description: v.description,
      outputType: v.outputType,
    }));
}

function shellQuote(arg: string) {
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}

function dbEnvs() {
  return {
    PGHOST: process.env.PGHOST ?? "",
    PGPORT: process.env.PGPORT ?? "",
    PGDATABASE: process.env.PGDATABASE ?? "",
    PGUSER: process.env.PGUSER ?? "",
    PGPASSWORD: process.env.PGPASSWORD ?? "",
  };
}

/**
 * sbx.commands.run() REJECTS (throws CommandExitError) on a non-zero exit code rather than
 * resolving with exitCode set — an `if (result.exitCode !== 0)` check after a plain `await` is
 * dead code, and the real stderr gets lost behind a generic "exit status N" Error unless it's
 * caught and unwrapped here. CommandExitError still exposes .stdout/.stderr/.exitCode, just as a
 * thrown object instead of a resolved one.
 */
async function runCommandCapturingError(
  sbx: Sandbox,
  cmd: string,
  opts: Parameters<Sandbox["commands"]["run"]>[1]
) {
  try {
    return await sbx.commands.run(cmd, opts);
  } catch (err) {
    const stderr = (err as { stderr?: string })?.stderr;
    const stdout = (err as { stdout?: string })?.stdout;
    const detail = stderr || stdout || (err instanceof Error ? err.message : String(err));
    throw new Error(`Command failed: ${cmd}\n${detail}`);
  }
}

export type AnalyticsResult =
  | { kind: "json"; data: unknown }
  | { kind: "image"; mimeType: "image/png"; base64: string; summary: string };

export type AnalyticsSelection =
  | { sampleIds?: undefined; occurrenceId?: undefined; assumptions?: undefined } // filter-only: the script selects its own samples
  | { sampleIds: number[]; occurrenceId?: undefined; assumptions?: undefined }
  | { occurrenceId: number; sampleIds?: undefined; assumptions?: undefined }
  | { assumptions: Record<string, unknown>; sampleIds?: undefined; occurrenceId?: undefined };

export async function runAnalyticsScript(
  scriptName: string,
  selection: AnalyticsSelection,
  options: Record<string, string | number> = {},
  label?: string
): Promise<AnalyticsResult> {
  const entry = SCRIPT_REGISTRY[scriptName];
  if (!entry) {
    throw new Error(
      `Unknown script "${scriptName}". Registered scripts: ${Object.keys(SCRIPT_REGISTRY).join(", ")}`
    );
  }
  if (entry.selection === "sample_ids" && !selection.sampleIds) {
    throw new Error(`"${scriptName}" requires sample_ids, not occurrence_id.`);
  }
  if (entry.selection === "occurrence_id" && selection.occurrenceId === undefined) {
    throw new Error(`"${scriptName}" requires occurrence_id (it searches a radius around one point), not sample_ids.`);
  }
  if (entry.selection === "financial_assumptions" && !selection.assumptions) {
    throw new Error(`"${scriptName}" requires an assumptions object (it does not read from the database).`);
  }

  const scriptsDir = path.join(process.cwd(), "analytics-scripts");
  const scriptContent = fs.readFileSync(path.join(scriptsDir, entry.file), "utf-8");
  const requirements = fs.readFileSync(path.join(scriptsDir, entry.requirements ?? "requirements.txt"), "utf-8");

  // E2B_TEMPLATE names a prebuilt image with every dependency already installed (scripts/build-e2b-template.mjs), so
  // no pip install is needed. Without it, fall back to the stock image plus a per-call pip install of the script's requirements.
  // The name is trimmed (a stray newline from `vercel env add` makes the template unknown), and if the template cannot be
  // started at all the call falls back to the stock image + pip rather than failing every analysis.
  const template = process.env.E2B_TEMPLATE?.trim() || undefined;
  const sandboxOpts = { apiKey: process.env.E2B_API_KEY, timeoutMs: 180_000 };
  let sbx: Sandbox | undefined;
  if (template) {
    try {
      sbx = await Sandbox.create(template, sandboxOpts);
    } catch (err) {
      console.error(`E2B template "${template}" could not be started, falling back to the stock image:`, err instanceof Error ? err.message : err);
    }
  }
  const usedTemplate = sbx !== undefined;
  if (!sbx) sbx = await Sandbox.create(sandboxOpts);
  try {
    await sbx.files.write("/home/user/script.py", scriptContent);
    if (!usedTemplate) {
      await sbx.files.write("/home/user/requirements.txt", requirements);
      await runCommandCapturingError(sbx, "pip install -q -r requirements.txt", {
        cwd: "/home/user",
        timeoutMs: 120_000,
      });
    }

    // sample_ids scripts take a single comma-separated positional arg (CLI) or a Python list
    // literal (plot call line); occurrence_id scripts keep the original single-int positional.
    // financial_assumptions scripts are plot-only (no CLI arg needed) — their assumptions object
    // is embedded as a JSON string literal and parsed back to a dict in the generated call line
    // (the script itself already imports json, so json.loads is available in that scope).
    const primaryArgCli =
      entry.selection === "sample_ids" ? selection.sampleIds!.join(",") :
      entry.selection === "occurrence_id" ? String(selection.occurrenceId) :
      "";
    const primaryArgPy =
      entry.selection === "sample_ids_or_filter" ? (selection.sampleIds ? `[${selection.sampleIds.join(",")}]` : "None") :
      entry.selection === "sample_ids" ? `[${selection.sampleIds!.join(",")}]` :
      entry.selection === "occurrence_id" ? String(selection.occurrenceId) :
      `json.loads(${JSON.stringify(JSON.stringify(selection.assumptions))})`;

    if (entry.outputType === "json") {
      const args = [primaryArgCli];
      for (const [key, value] of Object.entries(options)) {
        args.push(`--${key.replace(/_/g, "-")}`, String(value));
      }
      if (label) args.push("--label", label);
      const result = await runCommandCapturingError(
        sbx,
        `python script.py ${args.map(shellQuote).join(" ")}`,
        { cwd: "/home/user", envs: dbEnvs(), timeoutMs: 30_000 }
      );
      // Python's json.dumps writes bare NaN / Infinity for missing numbers, which JSON.parse rejects: turn them into null.
      const stdout = result.stdout.replace(/([:[,]\s*)-?(NaN|Infinity)(?=\s*[,\]}])/g, "$1null");
      return { kind: "json", data: JSON.parse(stdout) };
    }

    // "plot": run as a code cell so matplotlib's figure is captured as an image result.
    // Strip the script's own `if __name__ == "__main__":` CLI block first — E2B's runCode
    // executes in a __main__-like context too, so that block would otherwise run with no argv
    // and argparse would exit(2) rather than falling through harmlessly.
    const mainGuardIndex = scriptContent.search(/\nif __name__ == ["']__main__["']:/);
    const codeBody = mainGuardIndex === -1 ? scriptContent : scriptContent.slice(0, mainGuardIndex);
    // Only pass kwargs the caller actually specified — otherwise call with just the primary
    // selection so each script's own Python-level default applies (these vary: Chondrite_PON vs
    // PM_PON for reference, 50 for radius_km, etc. — the wrapper shouldn't second-guess a script's
    // default).
    const kwargOptions = { ...options, ...(label ? { label } : {}) };
    const kwargs = Object.entries(kwargOptions)
      .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
      .join(", ");
    const callArgs = kwargs ? `${primaryArgPy}, ${kwargs}` : primaryArgPy;
    const callLine = `\n\n${entry.entryPoint}(${callArgs})`;
    const execution = await sbx.runCode(codeBody + callLine, {
      envs: dbEnvs(),
      timeoutMs: 60_000,
    });
    if (execution.error) {
      throw new Error(
        `Plot generation failed:\n${execution.error.name}: ${execution.error.value}\n${execution.error.traceback}`
      );
    }
    const imageResult = execution.results.find((r) => r.png);
    if (!imageResult?.png) {
      throw new Error(
        "Script ran without error but produced no image. Logs: " + JSON.stringify(execution.logs)
      );
    }
    // Scripts print a JSON summary (sample counts, computed values) before plt.show() — captured
    // here so the model gets exact numbers to interpret alongside the image itself, not just a
    // picture it has to eyeball.
    const summary = execution.logs.stdout.join("").trim();
    return { kind: "image", mimeType: "image/png", base64: imageResult.png, summary };
  } finally {
    await sbx.kill();
  }
}
