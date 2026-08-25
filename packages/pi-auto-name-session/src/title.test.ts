// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {
  countUserMessages,
  extractUserText,
  getRecentUserPrompt,
  sanitizeSessionName,
  shouldArmAutoNaming,
} from "./title.ts";

test("extracts only text parts from user content", () => {
  assert.equal(
    extractUserText([
      { type: "text", text: "Build an auto name session extension" },
      { type: "image", source: { type: "base64", data: "abc" } },
      { type: "text", text: "Use big pickle" },
    ]),
    "Build an auto name session extension\nUse big pickle",
  );
});

test("collects recent user messages within the character limit", () => {
  assert.equal(
    getRecentUserPrompt(
      [
        { type: "message", message: { role: "user", content: "old" } },
        { type: "message", message: { role: "assistant", content: "skip" } },
        { type: "message", message: { role: "user", content: "new" } },
      ],
      8,
    ),
    "old\n\nnew",
  );
});

test("sanitizes labels, quotes, and punctuation", () => {
  assert.equal(sanitizeSessionName('Title: "Auto Name Session".'), "Auto Name Session");
});

test("counts only user messages", () => {
  const entries = [
    { type: "message", message: { role: "user", content: [] } },
    { type: "message", message: { role: "assistant", content: [] } },
    { type: "custom", customType: "x", data: {} },
  ];

  assert.equal(countUserMessages(entries), 1);
});

test("arms only for empty unnamed sessions", () => {
  assert.equal(shouldArmAutoNaming([], undefined), true);
  assert.equal(shouldArmAutoNaming([], "Already Named"), false);
});
