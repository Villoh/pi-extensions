// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {
  BTW_READONLY_TOOLS,
  BTW_SUB_SESSION_TOOL_SET,
  describeFocusShortcuts,
  getBtwCompletions,
  resolveBtwFocusShortcuts,
  resolveBtwToolNames,
  stripForeignToolActivity,
  withoutParentToolDeclarations,
} from "./btw.ts";

function toolCallMessage(name: string, id = "call-1") {
  return {
    role: "assistant",
    content: [{ type: "toolCall", id, name, arguments: {} }],
    api: "openai-responses",
    provider: "test",
    model: "test",
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "toolUse",
    timestamp: 0,
  };
}

function toolResultMessage(name: string, id = "call-1") {
  return {
    role: "toolResult",
    toolCallId: id,
    toolName: name,
    content: [{ type: "text", text: "ok" }],
    isError: false,
    timestamp: 0,
  };
}

test("keeps allowed tool call/result pairs untouched", () => {
  const messages = [toolCallMessage("bash"), toolResultMessage("bash")];
  assert.deepEqual(stripForeignToolActivity(messages, BTW_SUB_SESSION_TOOL_SET), messages);
});

test("drops calls/results for tools outside the sub-session toolset", () => {
  const messages = [
    { role: "user", content: "hi", timestamp: 0 },
    toolCallMessage("find_roots"),
    toolResultMessage("find_roots"),
    toolCallMessage("bash", "call-2"),
    toolResultMessage("bash", "call-2"),
  ];

  const filtered = stripForeignToolActivity(messages, BTW_SUB_SESSION_TOOL_SET);

  assert.equal(filtered.length, 3);
  assert.equal(filtered[0].role, "user");
  assert.equal(filtered[1].content[0].name, "bash");
  assert.equal(filtered[2].toolName, "bash");
});

test("drops an assistant message left empty after stripping its only tool call", () => {
  const messages = [toolCallMessage("find_roots")];
  assert.deepEqual(stripForeignToolActivity(messages, BTW_SUB_SESSION_TOOL_SET), []);
});

test("strips thinking blocks even alongside an allowed tool call, without dropping the call", () => {
  const messages = [
    {
      ...toolCallMessage("bash"),
      content: [
        {
          type: "thinking",
          thinking: "let me check",
          thinkingSignature: "sig",
        },
        { type: "toolCall", id: "call-1", name: "bash", arguments: {} },
      ],
    },
    toolResultMessage("bash"),
  ];

  const filtered = stripForeignToolActivity(messages, BTW_SUB_SESSION_TOOL_SET);

  assert.equal(filtered.length, 2);
  assert.deepEqual(
    filtered[0].content.map((part) => part.type),
    ["toolCall"],
  );
});

test("drops a message that only has a redacted thinking block", () => {
  const messages = [
    {
      ...toolCallMessage("bash"),
      content: [{ type: "thinking", thinking: "", redacted: true }],
    },
  ];
  assert.deepEqual(stripForeignToolActivity(messages, BTW_SUB_SESSION_TOOL_SET), []);
});

test("strips parent tool declarations from system messages only", () => {
  const system = { role: "system", content: "x", toolsAdded: ["mcp"], toolsRemoved: ["edit"] };
  assert.deepEqual(withoutParentToolDeclarations(system), { role: "system", content: "x" });
  const user = { role: "user", content: [], toolsAdded: ["keep"] };
  assert.equal(withoutParentToolDeclarations(user), user);
});

test("PI_BTW_FOCUS_KEYS replaces defaults, drops invalid ids, falls back when empty", () => {
  const defaults = resolveBtwFocusShortcuts({});
  assert.deepEqual(defaults, ["alt+/", "super+/", "ctrl+alt+w"]);
  assert.deepEqual(
    resolveBtwFocusShortcuts({ PI_BTW_FOCUS_KEYS: " Ctrl+/, cmd+x, ctrl+alt+b ,ctrl+/" }),
    ["ctrl+/", "ctrl+alt+b"],
  );
  assert.deepEqual(resolveBtwFocusShortcuts({ PI_BTW_FOCUS_KEYS: "nope,," }), defaults);
  assert.equal(describeFocusShortcuts(defaults), "Alt+/, Super+/ or Ctrl+Alt+W");
});

test("readonly mode always uses the fixed read-only tools, ignoring configured tools", () => {
  const configured = { tools: ["read", "bash", "edit", "write"] };
  assert.deepEqual(resolveBtwToolNames(configured, "readonly"), [...BTW_READONLY_TOOLS]);
  assert.deepEqual(resolveBtwToolNames(configured, "contextual"), configured.tools);
  assert.ok(!BTW_READONLY_TOOLS.some((tool) => ["bash", "edit", "write"].includes(tool)));
});

test("composer completion: / offers btw and side, /btw offers subcommands, other input none", () => {
  assert.deepEqual(
    getBtwCompletions("/").map((c) => c.label),
    ["/btw", "/side"],
  );
  assert.deepEqual(
    getBtwCompletions("/si").map((c) => c.label),
    ["/side"],
  );
  const sub = getBtwCompletions("/btw re");
  assert.deepEqual(
    sub.map((c) => c.label),
    ["readonly", "resume"],
  );
  assert.equal(sub[0].insert, "/btw readonly ");
  assert.deepEqual(getBtwCompletions("/btw ask what"), []);
  assert.deepEqual(getBtwCompletions("/help"), []);
  assert.deepEqual(getBtwCompletions("hello"), []);
});
