// @ts-nocheck

// Drives the extension through the real Pi SDK with a deterministic fake
// provider, so context inheritance, tool surfaces and capability prompts are
// checked end to end instead of through mocks.

import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import * as piAI from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import btwExtension from "./btw.ts";

const roots: string[] = [];
const sessions: any[] = [];
const previousAgentDir = process.env.PI_CODING_AGENT_DIR;

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.abort();
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

const BUILTINS = ["read", "bash", "edit", "write"];
const READONLY = ["read", "grep", "find", "ls"];
const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

async function fixture({ withExtension = false, withToolHistory = false } = {}) {
  const root = await mkdtemp(join(tmpdir(), "pi-btw-sdk-test-"));
  roots.push(root);
  const cwd = join(root, "project");
  const agentDir = join(root, "agent");
  await mkdir(cwd);
  await mkdir(agentDir);
  process.env.PI_CODING_AGENT_DIR = agentDir;

  const marker = join(root, "lifecycle.txt");
  if (withExtension) {
    const extension = join(root, "lookup.ts");
    await writeFile(
      extension,
      `
      import { appendFileSync } from 'node:fs';
      export default function(pi) {
        pi.on('session_start', () => appendFileSync(${JSON.stringify(marker)}, 'start\\n'));
        pi.on('session_shutdown', () => appendFileSync(${JSON.stringify(marker)}, 'stop\\n'));
        pi.registerTool({name:'lookup_fact',label:'Lookup',description:'Look up a fact',parameters:{type:'object',properties:{}},execute:async()=>({content:[{type:'text',text:'fixture fact'}],details:{}})});
      }
    `,
    );
    await writeFile(join(agentDir, "btw.json"), JSON.stringify({ extensions: [extension] }));
  }

  const requests: Array<{ prompt: string; messages: any[]; tools: string[] }> = [];
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"),
    modelsPath: join(agentDir, "models.json"),
    allowModelNetwork: false,
  });
  modelRuntime.registerProvider("btw-test", {
    baseUrl: "http://unused.invalid",
    api: "btw-test-api",
    apiKey: "fixture-key",
    models: [
      {
        id: "fixture",
        name: "Fixture",
        reasoning: false,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 32000,
        maxTokens: 1024,
      },
    ],
    streamSimple(model, context) {
      // Pi 0.99+ embeds the prompt and tool updates in system messages; older
      // supported SDKs pass them as separate fields on Context.
      const prompt = piAI.getCurrentSystemPrompt?.(context.messages) ?? context.systemPrompt ?? "";
      const tools = piAI.getCurrentTools?.(context.messages) ?? context.tools ?? [];
      requests.push({
        prompt,
        messages: structuredClone(context.messages),
        tools: tools.map((tool) => tool.name),
      });
      const last = context.messages.at(-1);
      const callTool =
        tools.some((tool) => tool.name === "lookup_fact") &&
        last?.role === "user" &&
        JSON.stringify(last.content).includes("use lookup");
      const stopReason = callTool ? "toolUse" : "stop";
      const message = {
        role: "assistant",
        api: model.api,
        provider: model.provider,
        model: model.id,
        content: callTool
          ? [{ type: "toolCall", id: "lookup-1", name: "lookup_fact", arguments: {} }]
          : [{ type: "text", text: "fixture answer" }],
        stopReason,
        timestamp: Date.now(),
        usage,
      };
      const stream = piAI.createAssistantMessageEventStream();
      stream.push({ type: "start", partial: message });
      stream.push({ type: "done", reason: stopReason, message });
      stream.end();
      return stream;
    },
  });
  await modelRuntime.refresh({ allowNetwork: false });

  const sessionManager = SessionManager.inMemory(cwd);
  if (withToolHistory) {
    sessionManager.appendMessage({
      role: "system",
      content: "Initial parent prompt sentinel",
      sections: { "parent-instructions": "Preserved parent instruction sentinel" },
      toolsAdded: [
        {
          name: "unavailable_parent_tool",
          description: "Parent-only fixture",
          parameters: piAI.Type.Object({}),
        },
      ],
      timestamp: Date.now(),
    });
  }
  sessionManager.appendMessage({
    role: "user",
    content: "parent context sentinel",
    timestamp: Date.now(),
  });

  const settingsManager = SettingsManager.inMemory();
  const loader = new DefaultResourceLoader({
    cwd,
    agentDir,
    settingsManager,
    noExtensions: true,
    noSkills: true,
    noThemes: true,
    noPromptTemplates: true,
    noContextFiles: true,
    extensionFactories: [
      btwExtension,
      (pi) =>
        pi.registerTool({
          name: "unavailable_parent_tool",
          label: "Parent tool",
          description: "Parent-only fixture",
          parameters: piAI.Type.Object({}),
          execute: async () => ({
            content: [{ type: "text", text: "parent-only fact" }],
            details: {},
          }),
        }),
    ],
    systemPrompt: "Project instruction sentinel. Parent can use unavailable_parent_tool.",
  });
  await loader.reload();
  const { session } = await createAgentSession({
    cwd,
    agentDir,
    modelRuntime,
    sessionManager,
    settingsManager,
    resourceLoader: loader,
    model: modelRuntime.getModel("btw-test", "fixture"),
    thinkingLevel: "off",
  });
  sessions.push(session);
  const errors: unknown[] = [];
  await session.bindExtensions({ onError: (error) => errors.push(error) });

  // A populated parent history, including Pi's persisted system/tool messages
  // on newer releases, before any child session exists.
  await session.prompt("parent request sentinel");
  assert.ok(requests.at(-1).tools.includes("unavailable_parent_tool"));
  requests.length = 0;
  if (withToolHistory) {
    sessionManager.appendMessage({
      role: "system",
      content: "Parent tool update sentinel",
      sections: { "parent-update": "Preserved parent update sentinel" },
      toolsAdded: [
        {
          name: "retired_parent_tool",
          description: "Retired fixture",
          parameters: piAI.Type.Object({}),
        },
      ],
      timestamp: Date.now(),
    });
    sessionManager.appendMessage({
      role: "system",
      content: "Parent tool removal sentinel",
      toolsRemoved: [{ name: "retired_parent_tool" }],
      timestamp: Date.now(),
    });
  }
  const parentAnswers = sessionManager
    .buildSessionContext()
    .messages.filter((message) => message.role === "assistant");

  const command = async (name: string, args: string) => {
    const registered = session.extensionRunner.getCommand(name);
    assert.ok(registered, `registered command ${name}`);
    await registered.handler(args, session.extensionRunner.createCommandContext());
    assert.deepEqual(errors, []);
  };
  return { sessionManager, requests, command, marker, parentAnswers };
}

const btwEntries = (sessionManager) =>
  sessionManager
    .getEntries()
    .filter((entry) => entry.type === "custom" && entry.customType === "btw-thread-entry");

describe("BTW commands with the real Pi SDK", () => {
  for (const mode of [
    { name: "ask", command: "btw", args: "ask", inheritsContext: true, tools: BUILTINS },
    { name: "tangent", command: "btw", args: "tangent", inheritsContext: false, tools: BUILTINS },
    { name: "readonly", command: "btw", args: "readonly", inheritsContext: true, tools: READONLY },
    { name: "/side alias", command: "side", args: "ask", inheritsContext: true, tools: BUILTINS },
  ]) {
    it(`${mode.name} sends the right context, capabilities and tool surface`, async () => {
      const { command, requests, sessionManager, parentAnswers } = await fixture();
      await command(mode.command, `${mode.args} child question sentinel`);

      assert.equal(requests.length, 1);
      const request = requests[0];
      assert.deepEqual([...request.tools].sort(), [...mode.tools].sort());
      assert.match(request.prompt, /Project instruction sentinel/);
      assert.match(request.prompt, /<btw_capabilities>/);
      assert.ok(request.prompt.includes(`Available tools in this BTW session: ${mode.tools.join(", ")}.`));
      assert.equal(
        JSON.stringify(request.messages).includes("parent context sentinel"),
        mode.inheritsContext,
      );
      assert.match(JSON.stringify(request.messages), /child question sentinel/);
      assert.equal(btwEntries(sessionManager).length, 1);
      // A child response must never become an assistant response in the parent.
      assert.deepEqual(
        sessionManager
          .buildSessionContext()
          .messages.filter((message) => message.role === "assistant"),
        parentAnswers,
      );
    });
  }

  it("shows the answer as a visible note when the host has no overlay", async () => {
    const { command, sessionManager } = await fixture();
    await command("btw", "ask question without overlay");
    const notes = sessionManager
      .getEntries()
      .filter((entry) => entry.type === "custom_message" && entry.customType === "btw-note");
    assert.equal(notes.length, 1);
    assert.match(JSON.stringify(notes[0]), /fixture answer/);
  });

  it("does not replay parent tool declarations into the child", {
    skip: !("createInitialSystemMessage" in piAI) && "needs a Pi SDK with system-message tool declarations",
  }, async () => {
    for (const mode of [
      { args: "ask", tools: BUILTINS },
      { args: "readonly", tools: READONLY },
    ]) {
      const { command, requests, sessionManager } = await fixture({ withToolHistory: true });
      const parentBefore = structuredClone(sessionManager.buildSessionContext().messages);

      await command("btw", `${mode.args} child question sentinel`);

      const systemMessages = requests[0].messages.filter((message) => message.role === "system");
      const declarations = systemMessages
        .flatMap((message) => [...(message.toolsAdded ?? []), ...(message.toolsRemoved ?? [])])
        .map((tool) => tool.name);
      assert.ok(!declarations.includes("unavailable_parent_tool"));
      assert.ok(!declarations.includes("retired_parent_tool"));
      // Only the declarations go; the parent's prompt text is preserved.
      assert.match(JSON.stringify(systemMessages), /Initial parent prompt sentinel/);
      assert.match(JSON.stringify(systemMessages), /Preserved parent instruction sentinel/);
      assert.match(JSON.stringify(systemMessages), /Preserved parent update sentinel/);
      assert.deepEqual(
        sessionManager.buildSessionContext().messages.slice(0, parentBefore.length),
        parentBefore,
      );

      // Serialize with the real Anthropic payload builder, stopping before any HTTP.
      const { stream } = await import("@earendil-works/pi-ai/api/anthropic-messages");
      let payload:
        | { tools?: Array<{ name: string }>; messages: Array<{ content: unknown }> }
        | undefined;
      let fetched = false;
      const serialized = stream(
        {
          id: "fixture-anthropic",
          name: "Fixture",
          provider: "anthropic",
          api: "anthropic-messages",
          baseUrl: "http://unused.invalid",
          reasoning: false,
          input: ["text"],
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          contextWindow: 32000,
          maxTokens: 1024,
          compat: { supportsMidConvoSystemMessages: true, supportsMidConvoToolChanges: true },
        },
        { messages: requests[0].messages },
        {
          apiKey: "fixture-key",
          fetch: async () => {
            fetched = true;
            throw new Error("Unexpected network request");
          },
          onPayload(value) {
            payload = value;
            throw new Error("Fixture stops after payload capture");
          },
        },
      );
      await serialized.result();
      assert.equal(fetched, false);
      assert.ok(payload);
      assert.deepEqual(payload.tools?.map((tool) => tool.name).sort(), [...mode.tools].sort());
      const blocks = payload.messages.flatMap((message) =>
        Array.isArray(message.content) ? message.content : [],
      );
      assert.deepEqual(
        blocks.filter((block) => block.type === "tool_addition" || block.type === "tool_removal"),
        [],
      );
    }
  });

  it("keeps follow-ups in the same child thread", async () => {
    const { command, requests } = await fixture();
    await command("side", "first child question");
    await command("btw", "ask follow-up question");
    assert.equal(requests.length, 2);
    assert.match(JSON.stringify(requests[1].messages), /first child question/);
    assert.ok(requests[1].messages.some((message) => message.role === "assistant"));
  });

  it("summarizes with no tools", async () => {
    const { command, requests } = await fixture();
    await command("btw", "ask the only exchange");
    requests.length = 0;
    // Injecting the summary into the parent triggers a parent turn too, so find the summary request.
    await command("btw", "summarize");
    const summary = requests.find((request) => /Summarize the side conversation/.test(request.prompt));
    assert.ok(summary, "a summarize request was sent");
    assert.deepEqual(summary.tools, []);
    assert.match(summary.prompt, /No tools are available in this BTW session\./);
    assert.match(JSON.stringify(summary.messages), /the only exchange/);
  });

  it("executes an opted-in extension tool and keeps it out of read-only and summary sessions", async () => {
    const { command, requests, marker } = await fixture({ withExtension: true });
    await command("btw", "ask use lookup");
    assert.equal(requests.length, 2);
    assert.ok(requests[0].tools.includes("lookup_fact"));
    assert.ok(requests[0].prompt.includes("write, lookup_fact."));
    assert.ok(
      requests[1].messages.some(
        (message) =>
          message.role === "toolResult" && JSON.stringify(message.content).includes("fixture fact"),
      ),
    );
    assert.equal(await readFile(marker, "utf8"), "start\n");

    await command("btw", "readonly read-only question");
    assert.deepEqual([...requests.at(-1).tools].sort(), [...READONLY].sort());
    // Switching modes recreates the child, which shuts the extension down.
    assert.equal(await readFile(marker, "utf8"), "start\nstop\n");
  });
});
