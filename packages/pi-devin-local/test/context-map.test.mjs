import assert from "node:assert/strict";
import test from "node:test";
import { normalizeContext } from "@earendil-works/pi-ai";
import { capImages, mapContextToChat, OMITTED_IMAGE_TEXT } from "../src/context-map.ts";

const tool = (name) => ({
  name,
  description: name,
  parameters: { type: "object", properties: {} },
});

// Regression for #7: Pi 0.86 moves prompt and tools into system messages.
test("preserves the prompt and tools from a normalized transcript", () => {
  const read = tool("read");
  const context = normalizeContext({
    systemPrompt: "Inspect the repository.",
    tools: [read],
    messages: [{ role: "user", content: "Read README", timestamp: 1 }],
  });
  assert.deepEqual(mapContextToChat(context), {
    systemPrompt: "Inspect the repository.",
    messages: [{ role: "user", content: "Read README" }],
    tools: [read],
  });
});

test("applies later instruction, section, and tool changes", () => {
  const bash = tool("bash");
  const context = {
    messages: [
      {
        role: "system",
        content: "Inspect the repository.",
        sections: { policy: "Old policy", obsolete: "Remove me" },
        toolsAdded: [tool("read")],
        timestamp: 0,
      },
      { role: "user", content: "Continue", timestamp: 1 },
      {
        role: "system",
        content: "Use bash.",
        sections: { policy: "Do not edit.", obsolete: null },
        toolsRemoved: [{ name: "read" }],
        toolsAdded: [bash],
        timestamp: 2,
      },
    ],
  };
  assert.deepEqual(mapContextToChat(context), {
    systemPrompt: "Inspect the repository.\n\nUse bash.\n\nDo not edit.",
    messages: [{ role: "user", content: "Continue" }],
    tools: [bash],
  });
});

test("accepts an empty transcript", () => {
  assert.deepEqual(mapContextToChat(normalizeContext({ messages: [] })), {
    systemPrompt: undefined,
    messages: [],
    tools: [],
  });
});

// Regression: replaying every history image as base64 pushed requests past the
// server's ~10 MB body limit (nginx 413).
test("keeps the newest images within the budget and stubs older ones", () => {
  const image = (size) => ({ type: "image", mimeType: "image/png", data: "x".repeat(size) });
  const messages = [
    { role: "user", content: [image(4)] },
    { role: "tool", content: [image(4)], tool_call_id: "t1" },
    { role: "user", content: [{ type: "text", text: "look" }, image(3)] },
  ];
  assert.deepEqual(capImages(messages, 8), [
    { role: "user", content: [{ type: "text", text: OMITTED_IMAGE_TEXT }] },
    { role: "tool", content: [image(4)], tool_call_id: "t1" },
    { role: "user", content: [{ type: "text", text: "look" }, image(3)] },
  ]);
});
