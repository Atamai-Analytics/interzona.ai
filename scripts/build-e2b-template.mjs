// Builds the E2B sandbox image "interzona-analytics" used by src/lib/sandbox.ts: the stock code-interpreter image
// plus every dependency in analytics-scripts/requirements.txt (pyrolite, geopandas, fractopo, numpy-financial,
// psycopg2 ...) pre-installed, so a sandbox no longer pip-installs them on every call.
// Usage: node scripts/build-e2b-template.mjs        (reads E2B_API_KEY from .env.local)
// After a build, set E2B_TEMPLATE=interzona-analytics (Vercel env + .env.local). Rebuild whenever requirements.txt changes.
import fs from "fs";
import { Template, defaultBuildLogger } from "e2b";

const env = fs.readFileSync(new URL("../.env.local", import.meta.url), "utf8");
const apiKey = env.match(/^E2B_API_KEY=(.*)$/m)?.[1]?.trim();
if (!apiKey) throw new Error("E2B_API_KEY not found in .env.local");

const NAME = process.env.TEMPLATE_NAME || "interzona-analytics";
const template = Template({ fileContextPath: new URL("../analytics-scripts", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1") })
  .fromTemplate("code-interpreter-v1")
  .copy("requirements.txt", "/tmp/requirements.txt")
  .runCmd("pip install -q -r /tmp/requirements.txt", { user: "root" })
  .runCmd(
    `python -c "import pyrolite.geochem, pyrolite.plot, geopandas, fractopo, numpy_financial, psycopg2, shapely; print('imports ok')"`
  );

const info = await Template.build(template, NAME, { apiKey, onBuildLogs: defaultBuildLogger({ minLevel: "info" }) });
console.log("BUILT", JSON.stringify(info));
