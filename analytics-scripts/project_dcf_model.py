"""
Project-economics discounted cash flow (DCF) model — single commodity, single ore/production
stream. Computes NPV, IRR, payback period, and a one-way sensitivity ranking from a set of
annual assumptions supplied by the caller.

THIS SCRIPT DOES NOT LOOK ANYTHING UP FROM THE DATABASE. interzona_cm's financials schema is
company-level only (balance_sheet/income_statement/cash_flow/financial_ratios) — there is no
mine-plan, capex, opex, recovery, or project-level commodity-price data anywhere in this
database. Every number here has to come from the user (a scoping/feasibility study, a technical
report, their own estimate) or from an explicitly cited external source — never invented by the
calling agent as a "plausible" placeholder. A wrong-but-plausible-looking financial number is
worse than refusing to run the model until real inputs are provided.

Methodologically inspired by the general DCF structure (revenue -> opex -> EBITDA -> units-of-
production depreciation -> EBIT -> tax -> FCF -> NPV/IRR) in Hutson (2025), "A Novel Analytics-
Based Approach to Mining Project Valuations" (data/code: CC BY 4.0,
data.mendeley.com/datasets/hkgdkmynnk) — deliberately simplified and generalized from that
source: ONE commodity/ore stream instead of three, no hardcoded "Gold Price"/file paths, and NO
Cartesian multi-way sensitivity grid (that scales combinatorially — the reference implementation's
full-grid output files ran to tens of megabytes for one scenario — and isn't needed to answer
"is this project profitable under these assumptions, and what does it depend on most").

UNITS: price_per_unit, operating_costs_annual, and capex_annual must all be in the SAME currency
scale (e.g. all in $ million, or all in raw $) — this script does no implicit conversion. NPV and
annual FCF are reported in whatever scale you supplied those three in.

Designed to run as a cell in an E2B code-interpreter sandbox (via runCode). Also runnable directly
for local testing with a JSON assumptions file.
"""
import json
import warnings

warnings.filterwarnings("ignore")

import numpy as np
import pandas as pd
import numpy_financial as npf
import matplotlib.pyplot as plt

REQUIRED_KEYS = [
    "recovered_units_annual", "price_per_unit", "operating_costs_annual",
    "capex_annual", "tax_rate", "discount_rate",
]
SENSITIVITY_DRIVERS = ("price_per_unit", "recovered_units_annual", "operating_costs_annual", "capex_annual")


def _broadcast(value, n):
    if isinstance(value, (list, tuple)):
        if len(value) != n:
            raise ValueError(f"Expected {n} values (matching recovered_units_annual's length), got {len(value)}.")
        return np.array(value, dtype=float)
    return np.full(n, float(value))


def run_dcf(assumptions):
    missing = [k for k in REQUIRED_KEYS if k not in assumptions]
    if missing:
        raise ValueError(f"Missing required assumptions: {missing}")

    recovered = np.array(assumptions["recovered_units_annual"], dtype=float)
    n = len(recovered)
    if n == 0:
        raise ValueError("recovered_units_annual must have at least one year.")

    price = _broadcast(assumptions["price_per_unit"], n)
    opex = _broadcast(assumptions["operating_costs_annual"], n)
    capex = _broadcast(assumptions["capex_annual"], n)
    tax_rate = float(assumptions["tax_rate"])
    discount_rate = float(assumptions["discount_rate"])
    royalty_pct = float(assumptions.get("royalty_pct", 0.0))
    refining_cost_per_unit = float(assumptions.get("refining_cost_per_unit", 0.0))

    gross_revenue = recovered * price
    refining = recovered * refining_cost_per_unit
    royalty = royalty_pct * (gross_revenue - refining)
    net_revenue = gross_revenue - refining - royalty

    ebitda = net_revenue - opex

    # Units-of-production depreciation: each year's capex is depreciated against the remaining
    # recovered-unit stream from that year forward (vectorized single-stream version of the
    # method in the reference DCF).
    depreciation = np.zeros(n)
    for i in range(n):
        if capex[i] == 0:
            continue
        remaining = recovered[i:].sum()
        if remaining <= 0:
            continue
        depreciation[i:] += capex[i] * (recovered[i:] / remaining)

    ebit = ebitda - depreciation
    taxes = np.clip(ebit, 0, None) * tax_rate
    earnings = ebit - taxes
    fcf = earnings + depreciation - capex

    discount_factors = 1.0 / (1.0 + discount_rate) ** np.arange(n)
    pv = fcf * discount_factors
    npv = float(pv.sum())
    try:
        irr = float(npf.irr(fcf))
        if np.isnan(irr):
            irr = None
    except Exception:
        irr = None

    cumulative = np.cumsum(fcf)
    payback_year = None
    for i, c in enumerate(cumulative):
        if c >= 0:
            payback_year = i + 1
            break

    table = pd.DataFrame({
        "year": np.arange(1, n + 1),
        "recovered_units": recovered,
        "gross_revenue": gross_revenue,
        "net_revenue": net_revenue,
        "opex": opex,
        "ebitda": ebitda,
        "depreciation": depreciation,
        "ebit": ebit,
        "taxes": taxes,
        "capex": capex,
        "fcf": fcf,
        "cumulative_fcf": cumulative,
    })
    return table, npv, irr, payback_year


def one_way_sensitivity(assumptions, drivers=SENSITIVITY_DRIVERS, delta=0.15):
    """Vary each driver +/-delta (uniform scaling across all its years), holding everything else
    at base case, and rank by resulting NPV range — a standard tornado-chart sensitivity. No
    Cartesian combination of drivers (see module docstring for why)."""
    _, base_npv, _, _ = run_dcf(assumptions)
    results = []
    for key in drivers:
        if key not in assumptions:
            continue
        base_val = assumptions[key]
        low_assumptions = dict(assumptions)
        high_assumptions = dict(assumptions)
        if isinstance(base_val, (list, tuple)):
            low_assumptions[key] = [v * (1 - delta) for v in base_val]
            high_assumptions[key] = [v * (1 + delta) for v in base_val]
        else:
            low_assumptions[key] = base_val * (1 - delta)
            high_assumptions[key] = base_val * (1 + delta)
        _, npv_low, _, _ = run_dcf(low_assumptions)
        _, npv_high, _, _ = run_dcf(high_assumptions)
        results.append({
            "driver": key, "npv_low": npv_low, "npv_high": npv_high,
            "npv_range": abs(npv_high - npv_low),
        })
    results.sort(key=lambda r: r["npv_range"], reverse=True)
    return base_npv, results


def generate_dcf_plot(assumptions, label=None, save_path=None):
    table, npv, irr, payback_year = run_dcf(assumptions)
    base_npv, sensitivity = one_way_sensitivity(assumptions)

    commodity_name = assumptions.get("commodity_name", "Commodity")
    commodity_unit = assumptions.get("commodity_unit", "unit")
    title = label or f"{commodity_name} project DCF"

    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(13, 6))

    years = table["year"]
    ax1.bar(years, table["net_revenue"], color="steelblue", label="Net revenue")
    ax1.bar(years, -table["opex"], color="indianred", label="Opex")
    ax1.bar(years, -table["capex"], bottom=-table["opex"], color="darkorange", label="Capex")
    ax1.plot(years, table["fcf"], color="black", marker="o", linewidth=1.5, label="FCF")
    ax1.axhline(0, color="gray", linewidth=0.8)
    ax1.set_xlabel("Year")
    ax1.set_ylabel("Value (your input currency scale)")
    irr_label = f"{irr * 100:.1f}%" if irr is not None else "n/a"
    payback_label = f"yr {payback_year}" if payback_year is not None else "not within horizon"
    ax1.set_title(f"{title}\nNPV={npv:,.1f}  IRR={irr_label}  Payback={payback_label}")
    ax1.legend(fontsize=8)

    drivers = [r["driver"] for r in sensitivity]
    lows = [r["npv_low"] for r in sensitivity]
    highs = [r["npv_high"] for r in sensitivity]
    y_pos = np.arange(len(drivers))
    ax2.barh(y_pos, [h - l for h, l in zip(highs, lows)], left=[min(l, h) for l, h in zip(lows, highs)], color="slategray")
    ax2.axvline(base_npv, color="black", linestyle="--", linewidth=1, label=f"Base NPV={base_npv:,.1f}")
    ax2.set_yticks(y_pos)
    ax2.set_yticklabels(drivers)
    ax2.invert_yaxis()
    ax2.set_xlabel("NPV (your input currency scale)")
    ax2.set_title("One-way sensitivity (±15% each driver)")
    ax2.legend(fontsize=8)
    fig.tight_layout()

    summary = {
        "label": label,
        "commodity_name": commodity_name,
        "commodity_unit": commodity_unit,
        "npv": round(npv, 2),
        "irr_pct": round(irr * 100, 2) if irr is not None else None,
        "payback_year": payback_year,
        "n_years": int(len(table)),
        "annual_cash_flow": table.round(3).to_dict(orient="records"),
        "one_way_sensitivity_npv_range": [
            {"driver": r["driver"], "npv_low": round(r["npv_low"], 2), "npv_high": round(r["npv_high"], 2), "npv_range": round(r["npv_range"], 2)}
            for r in sensitivity
        ],
        "caveats": (
            "Simplified single-commodity, single-ore-stream DCF — no multi-ore blending, no "
            "stripping-ratio/cutoff-grade optimization, no price escalation unless price_per_unit "
            "was supplied as a per-year array, flat tax/discount rate, units-of-production "
            "depreciation tied to recovered-unit timing vs. capex. All inputs were supplied by the "
            "caller, not looked up from the database — state where they came from and flag if "
            "any were estimated rather than sourced."
        ),
    }
    print(json.dumps(summary, indent=2, default=str))

    if save_path:
        fig.savefig(save_path, dpi=150)
        plt.close(fig)
    else:
        plt.show()


if __name__ == "__main__":
    import argparse
    import sys

    parser = argparse.ArgumentParser()
    parser.add_argument("assumptions_json", help="Path to a JSON file with the assumptions, or '-' to read JSON from stdin.")
    parser.add_argument("--label", default=None)
    parser.add_argument("--save", default=None, help="Local file path to save PNG (for testing outside a sandbox).")
    args = parser.parse_args()
    if args.assumptions_json == "-":
        loaded_assumptions = json.load(sys.stdin)
    else:
        with open(args.assumptions_json) as f:
            loaded_assumptions = json.load(f)
    generate_dcf_plot(loaded_assumptions, label=args.label, save_path=args.save)
