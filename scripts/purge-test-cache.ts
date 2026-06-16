#!/usr/bin/env bun
import { Database } from "bun:sqlite";
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const apply = process.argv.includes("--apply") || process.argv.includes("--purge");
const dbPath = join(homedir(), ".config", "onemessage", "messages.db");
const testProviderGlob = "__test*";

if (!existsSync(dbPath)) {
  console.error(`Cache database not found: ${dbPath}`);
  process.exit(1);
}

const db = new Database(dbPath);
const tables = ["messages", "fetch_log", "cursors", "contacts"] as const;

function countTestRows(table: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM ${table} WHERE provider GLOB ?`)
    .get(testProviderGlob) as { n?: number } | undefined;
  return Number(row?.n ?? 0);
}

const counts = tables.map((table) => [table, countTestRows(table)] as const);
const total = counts.reduce((sum, [, n]) => sum + n, 0);

if (total === 0) {
  console.log("No literal __test* provider rows found in the cache.");
  db.close();
  process.exit(0);
}

console.log("Found test-provider rows:");
for (const [table, count] of counts) {
  if (count > 0) console.log(`  ${table}: ${count}`);
}

if (!apply) {
  console.log("");
  console.log("Dry run only. Re-run with --apply after backing up messages.db.");
  db.close();
  process.exit(0);
}

const backupBase = `${dbPath}.bak-${new Date().toISOString().replace(/[:.]/g, "-")}`;
mkdirSync(backupBase, { recursive: true });
for (const suffix of ["", "-wal", "-shm"]) {
  const source = `${dbPath}${suffix}`;
  if (existsSync(source)) {
    copyFileSync(source, join(backupBase, `messages.db${suffix}`));
  }
}

db.transaction(() => {
  for (const table of tables) {
    db.prepare(`DELETE FROM ${table} WHERE provider GLOB ?`).run(testProviderGlob);
  }
})();

console.log("");
console.log(`Backup created: ${backupBase}`);
console.log("Purged literal __test* provider rows from the cache.");
db.close();
