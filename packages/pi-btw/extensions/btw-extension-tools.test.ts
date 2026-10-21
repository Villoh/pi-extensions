// @ts-nocheck

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBtwExtensionSources } from "./btw-extension-tools.ts";

function setup(globalConfig?: unknown, projectConfig?: unknown) {
  const root = mkdtempSync(join(tmpdir(), "btw-ext-"));
  const agentDir = join(root, "agent");
  const cwd = join(root, "proj");
  mkdirSync(agentDir, { recursive: true });
  mkdirSync(join(cwd, ".pi"), { recursive: true });
  if (globalConfig !== undefined) {
    writeFileSync(join(agentDir, "btw.json"), JSON.stringify(globalConfig));
  }
  if (projectConfig !== undefined) {
    writeFileSync(join(cwd, ".pi", "btw.json"), JSON.stringify(projectConfig));
  }
  return { root, agentDir, cwd };
}

test("no btw.json means no extensions", async () => {
  const { agentDir, cwd } = setup();
  assert.deepEqual(await readBtwExtensionSources({ cwd, agentDir, projectTrusted: true }), []);
});

test("local paths resolve relative to the config, npm:/git: sources stay as-is, duplicates collapse", async () => {
  const { agentDir, cwd } = setup({ extensions: ["./ext.ts", "./ext.ts", "npm:some-pkg"] });
  assert.deepEqual(await readBtwExtensionSources({ cwd, agentDir, projectTrusted: true }), [
    join(agentDir, "ext.ts"),
    "npm:some-pkg",
  ]);
});

test("project list replaces the global one, even when empty", async () => {
  const withProject = setup({ extensions: ["npm:global"] }, { extensions: ["npm:project"] });
  assert.deepEqual(await readBtwExtensionSources({ ...withProject, projectTrusted: true }), [
    "npm:project",
  ]);
  const emptyProject = setup({ extensions: ["npm:global"] }, { extensions: [] });
  assert.deepEqual(await readBtwExtensionSources({ ...emptyProject, projectTrusted: true }), []);
});

test("untrusted projects ignore .pi/btw.json", async () => {
  const dirs = setup({ extensions: ["npm:global"] }, { extensions: ["npm:project"] });
  assert.deepEqual(await readBtwExtensionSources({ ...dirs, projectTrusted: false }), [
    "npm:global",
  ]);
});

test("invalid configs fail loudly", async () => {
  for (const bad of [
    { extensions: "npm:x" },
    { extensions: [""] },
    { other: 1 },
    { workspace: "ssh" },
  ]) {
    const dirs = setup(bad);
    await assert.rejects(
      readBtwExtensionSources({ ...dirs, projectTrusted: true }),
      /Invalid BTW config/,
    );
  }
});
