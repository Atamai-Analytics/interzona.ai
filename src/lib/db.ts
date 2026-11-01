import { Pool } from "pg";

let pool: Pool | null = null;

export function getPool() {
  if (!pool) {
    pool = new Pool({
      host: process.env.PGHOST,
      port: Number(process.env.PGPORT || 5432),
      database: process.env.PGDATABASE,
      user: process.env.PGUSER,
      password: process.env.PGPASSWORD,
      max: 5,
      idleTimeoutMillis: 30000,
      // interzona_cm is on the internet, not in-VPC yet — require SSL in transit.
      ssl: { rejectUnauthorized: false },
    });
  }
  return pool;
}

const FORBIDDEN = /\b(insert|update|delete|drop|alter|truncate|grant|revoke|create|call|copy|vacuum|reindex|refresh)\b/i;

/**
 * Runs a read-only SQL query. Defense in depth on top of the cm_app_readonly
 * role (which cannot write at all): reject anything that isn't a bare SELECT,
 * enforce a statement timeout, and cap the row count so one bad query can't
 * hang the request or blow up the response payload.
 */
export async function runReadOnlyQuery(sql: string, maxRows = 200) {
  // Strip leading SQL comments, then accept a SELECT or a WITH (CTE) query. Data-modifying CTEs are still
  // rejected by FORBIDDEN below and by the read-only database role.
  const trimmed = sql
    .replace(/^(\s*(--[^\n]*(\n|$)|\/\*[\s\S]*?\*\/))*/, "")
    .trim()
    .replace(/;+\s*$/, "");
  if (!/^(select|with)\b/i.test(trimmed)) {
    throw new Error("Only SELECT statements are allowed (a WITH ... SELECT query is fine).");
  }
  if (FORBIDDEN.test(trimmed)) {
    throw new Error("Query contains a disallowed keyword.");
  }

  const client = await getPool().connect();
  try {
    await client.query("SET statement_timeout = 15000");
    const wrapped = `SELECT * FROM (${trimmed}) AS q LIMIT ${maxRows}`;
    const result = await client.query(wrapped);
    return { rows: result.rows, rowCount: result.rowCount, truncated: result.rowCount === maxRows };
  } finally {
    client.release();
  }
}
