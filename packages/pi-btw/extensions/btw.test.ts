// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import { BTW_SUB_SESSION_TOOL_SET, stripForeignToolActivity } from "./btw.ts";

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
