import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const tmpRoot = tmpdir();
const testPrefix = "onemessage-test-config-";

for (const entry of readdirSync(tmpRoot, { withFileTypes: true })) {
  if (entry.isDirectory() && entry.name.startsWith(testPrefix)) {
    rmSync(join(tmpRoot, entry.name), { recursive: true, force: true });
  }
}

const configDir = mkdtempSync(join(tmpRoot, testPrefix));

process.env.ONEMESSAGE_CONFIG_DIR = configDir;

process.once("exit", () => {
  rmSync(configDir, { recursive: true, force: true });
});
