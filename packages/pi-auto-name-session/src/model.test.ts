// @ts-nocheck

import assert from "node:assert/strict";
import test from "node:test";
import {
  filterRegisteredModelRefs,
  getModelCandidates,
  getModelCompletionValues,
  getRegisteredModelRefs,
  normalizeModelConfig,
} from "./model.ts";

test("keeps configured models ordered and deduplicated", () => {
  const config = normalizeModelConfig({
    models: ["openai/gpt-5.4", "opencode/big-pickle", "openai/gpt-5.4"],
    selected: "opencode/big-pickle",
  });

  assert.deepEqual(getModelCandidates(config), ["opencode/big-pickle", "openai/gpt-5.4"]);
});

test("inherits the active session model when no model is configured", () => {
  const config = normalizeModelConfig(undefined);

  assert.deepEqual(config, { models: [] });
  assert.deepEqual(getModelCandidates(config, "anthropic/claude-sonnet"), [
    "anthropic/claude-sonnet",
  ]);
});

test("only returns registered provider/model references", () => {
  assert.deepEqual(
    getRegisteredModelRefs([
      { provider: "openai", id: "gpt-5.4" },
      { provider: "openai", id: "gpt-5.4" },
      { provider: "anthropic", id: "claude-sonnet" },
    ]),
    ["openai/gpt-5.4", "anthropic/claude-sonnet"],
  );
});

test("filters registered models before opening the selector", () => {
  assert.deepEqual(
    filterRegisteredModelRefs("claude", ["openai/gpt-5.4", "anthropic/claude-sonnet"]),
    ["anthropic/claude-sonnet"],
  );
});

test("autocompletes only registered models", () => {
  assert.deepEqual(
    getModelCompletionValues("model openai/g", ["openai/gpt-5.4", "anthropic/claude-sonnet"]),
    ["model openai/gpt-5.4"],
  );
});
