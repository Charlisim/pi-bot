import assert from "node:assert/strict";
import { access, mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { createJiti } from "jiti";

const packageJson = JSON.parse(
  await readFile(new URL("../package.json", import.meta.url), "utf8"),
);

test("the package exposes only the extension and no default agents", async () => {
  assert.deepEqual(packageJson.pi, { extensions: ["./index.ts"] });
  assert.equal(packageJson.license, "MIT");
  assert.ok(!packageJson.pi.agents);
  const rootFiles = await readdir(new URL("..", import.meta.url));
  assert.ok(!rootFiles.includes("agents"));
  for (const linkedFile of [
    "SECURITY.md",
    "CONTRIBUTING.md",
    "docs/architecture.md",
    "docs/roadmap.md",
  ]) {
    assert.ok(
      packageJson.files.includes(linkedFile),
      `${linkedFile} must ship with the README`,
    );
  }
});

test("the package has no lifecycle scripts", () => {
  for (const name of ["preinstall", "install", "postinstall"])
    assert.equal(packageJson.scripts[name], undefined);
});

test("importing the package creates no user state", async () => {
  const agentDir = await mkdtemp(join(tmpdir(), "pi-bot-import-"));
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const jiti = createJiti(import.meta.url, { moduleCache: false });
  await jiti.import(new URL("../index.ts", import.meta.url).pathname);
  await assert.rejects(access(join(agentDir, "pi-bot")));
});
