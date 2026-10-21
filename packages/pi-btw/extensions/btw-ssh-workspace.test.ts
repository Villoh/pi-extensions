// @ts-nocheck

// Exercises the SSH workspace against a fake pi-ssh-remote backend module
// (same exports the real @99percentpeople/pi-ssh-remote 0.6.2 bundle has), so
// no server or network is involved.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { fakeSshBackend } from "./btw-ssh-fake-backend.ts";
import { type BtwSshWorkspace, createBtwSshWorkspace } from "./btw-ssh-workspace.ts";

const roots: string[] = [];
const workspaces: BtwSshWorkspace[] = [];

afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.dispose()));
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "pi-btw-ssh-test-"));
  roots.push(root);
  const source = join(root, "ssh-backend.mjs");
  await writeFile(source, fakeSshBackend());
  const backend = await import(pathToFileURL(source).href);
  const state = {
    version: 2,
    target: "test-host",
    port: 2222,
    configFile: "/test/ssh-config",
    remotePlatform: "unix",
    remoteShell: "bash",
    remoteCwd: "/srv/project",
    remoteHome: "/home/test",
  };
  const entries = [{ type: "custom", customType: "pi-ssh-remote-state", data: state }];
  const listeners = new Set<(event: unknown) => void>();
  const pi = {
    getAllTools: () => [{ name: "read", sourceInfo: { path: source } }],
    events: {
      on: (_name: string, callback: (event: unknown) => void) => {
        listeners.add(callback);
        return () => listeners.delete(callback);
      },
    },
  };
  const ctx = { cwd: root, sessionManager: { getBranch: () => entries } };
  const create = async (readonly = false) => {
    const workspace = await createBtwSshWorkspace(pi, ctx, readonly);
    workspaces.push(workspace);
    return workspace;
  };
  const execute = (workspace: BtwSshWorkspace, name: string, args: unknown) => {
    const tool = workspace.tools.find((candidate) => candidate.name === name);
    return tool.execute(
      "fixture",
      tool.prepareArguments?.(args) ?? args,
      undefined,
      undefined,
      ctx,
    );
  };
  return { root, backend, entries, state, listeners, create, execute };
}

const disposeCalls = (backend) => backend.calls.filter((call) => call[0] === "dispose").length;

describe("BTW SSH workspace backend", () => {
  it("reads, writes, edits and runs shells through a separate remote backend", async () => {
    const { create, execute, backend } = await fixture();
    const workspace = await create();
    assert.deepEqual(
      workspace.tools.map((tool) => tool.name),
      ["read", "write", "edit", "bash"],
    );
    assert.equal(workspace.label, "SSH test-host:2222:/srv/project");
    const [kind, options, settings] = backend.calls[0];
    assert.equal(kind, "connect");
    assert.equal(options.target, "test-host");
    assert.equal(options.port, 2222);
    assert.equal(options.batchMode, true);
    assert.equal(settings.preference, "auto");

    const read = await execute(workspace, "read", { path: "src/main.ts" });
    assert.match(read.content[0].text, /remote-only sentinel/);
    await execute(workspace, "write", { path: "notes.txt", content: "remote note" });
    assert.equal(backend.files.get("/srv/project/notes.txt").toString(), "remote note");
    await execute(workspace, "edit", {
      path: "notes.txt",
      oldText: "remote note",
      newText: "edited note",
    });
    assert.equal(backend.files.get("/srv/project/notes.txt").toString(), "edited note");
    await execute(workspace, "bash", { command: "pwd" });
    assert.deepEqual(
      backend.calls.find((call) => call[0] === "shell"),
      ["shell", "pwd", "/srv/project"],
    );
    await workspace.dispose();
    await workspace.dispose();
    assert.equal(disposeCalls(backend), 1);
  });

  it("preserves literal remote paths in file contents and edit diffs", async () => {
    const { create, execute, backend } = await fixture();
    const workspace = await create();
    const path = "/__remote__/srv/project/notes.txt";
    const content = `source=${path}\n`;
    backend.files.set("/srv/project/notes.txt", Buffer.from(content));
    assert.equal(
      (await execute(workspace, "read", { path: "notes.txt" })).content[0].text,
      content,
    );
    const result = await execute(workspace, "edit", {
      path: "notes.txt",
      oldText: content,
      newText: `updated=${path}\n`,
    });
    assert.ok(JSON.stringify(result.details).includes(path));
    assert.equal(backend.files.get("/srv/project/notes.txt").toString(), `updated=${path}\n`);
  });

  it("read-only mode exposes only remote read, grep, find and ls", async () => {
    const { create, execute, backend } = await fixture();
    const workspace = await create(true);
    assert.deepEqual(workspace.tools.map((tool) => tool.name).sort(), [
      "find",
      "grep",
      "ls",
      "read",
    ]);
    await execute(workspace, "read", { path: "src/main.ts", offset: 2, limit: 1 });
    const grep = await execute(workspace, "grep", { pattern: "sentinel", context: 1 });
    assert.match(grep.content[0].text, /src\/main\.ts:2: remote-only sentinel/);
    await execute(workspace, "find", { pattern: "*.ts" });
    await execute(workspace, "ls", {});
    for (const op of ["grep", "find", "ls"]) {
      assert.ok(
        backend.calls.some((call) => call[0] === op && call[1] === "/srv/project"),
        op,
      );
    }
    assert.ok(!backend.calls.some((call) => ["write", "shell"].includes(String(call[0]))));
  });

  for (const failure of ["connect", "factory"]) {
    it(`cleans up a failed ${failure} without local fallback`, async () => {
      const { create, backend, listeners } = await fixture();
      backend.setFailure(failure);
      await assert.rejects(create(), /transport unavailable|connection refused/);
      assert.equal(listeners.size, 0);
      assert.equal(disposeCalls(backend), failure === "factory" ? 0 : 1);
    });
  }

  it("propagates remote failures without reading a same-named local file", async () => {
    const { create, execute, backend, root } = await fixture();
    await writeFile(join(root, "main.ts"), "local sentinel");
    const workspace = await create(true);
    backend.setFailure("operation");
    await assert.rejects(execute(workspace, "read", { path: "main.ts" }), /remote unavailable/);
  });

  for (const change of ["host", "cwd", "exit", "event", "disconnect"]) {
    it(`requires /btw clear after a parent ${change} change`, async () => {
      const { create, execute, backend, entries, state, listeners } = await fixture();
      const workspace = await create();
      if (change === "host") entries[0].data = { ...state, target: "other-host" };
      if (change === "cwd") entries[0].data = { ...state, remoteCwd: "/other-project" };
      if (change === "exit") {
        entries.push({ type: "custom", customType: "pi-ssh-local-state", data: { version: 1 } });
      }
      if (change === "event") for (const listener of listeners) listener({ status: "started" });
      if (change === "disconnect") backend.disconnect(new Error("connection reset"));
      const before = backend.calls.length;
      await assert.rejects(
        execute(workspace, "write", { path: "notes.txt", content: "must not write" }),
        /\/btw clear/,
      );
      assert.equal(backend.calls.length, before);
      assert.throws(() => workspace.assertCurrent(), /\/btw clear/);
    });
  }

  it("rejects missing parent SSH state rather than returning local tools", async () => {
    const { create, entries } = await fixture();
    entries.length = 0;
    await assert.rejects(create(), /No active parent SSH workspace/);
  });
});
