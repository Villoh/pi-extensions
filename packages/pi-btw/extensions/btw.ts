import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type {
  ThinkingLevel as AiThinkingLevel,
  AssistantMessage,
  Message,
  UserMessage,
} from "@earendil-works/pi-ai";
import {
  type AgentSession,
  type AgentSessionEvent,
  buildSessionContext,
  createAgentSession,
  createExtensionRuntime,
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  getAgentDir,
  getSettingsListTheme,
  type ModelRuntime,
  type ResourceLoader,
  SessionManager,
} from "@earendil-works/pi-coding-agent";
import {
  Box,
  type Component,
  Container,
  type Focusable,
  Input,
  Key,
  type KeybindingsManager,
  matchesKey,
  type OverlayHandle,
  type SettingItem,
  SettingsList,
  Text,
  type TUI,
  truncateToWidth,
  visibleWidth,
  wrapTextWithAnsi,
} from "@earendil-works/pi-tui";

const BTW_MESSAGE_TYPE = "btw-note";
const BTW_ENTRY_TYPE = "btw-thread-entry";
const BTW_RESET_TYPE = "btw-thread-reset";
const BTW_MODEL_OVERRIDE_TYPE = "btw-model-override";
const BTW_THINKING_OVERRIDE_TYPE = "btw-thinking-override";
const BTW_CONFIG_FILENAME = "pi-btw.json";
const BTW_FOCUS_SHORTCUTS = [Key.alt("/"), Key.ctrlAlt("w")] as const;

// Sub-session toolset for `/btw` threads. Single source of truth:
// createBtwSubSession enables exactly these tools, and buildBtwSeedState
// strips tool-call/tool-result history for anything outside this set so the
// child model never sees itself having used a tool (e.g. an MCP tool only
// available in the main session) that it can't actually call here.
export const BTW_SUB_SESSION_TOOLS = ["read", "bash", "edit", "write"] as const;
export const BTW_SUB_SESSION_TOOL_SET = new Set<string>(BTW_SUB_SESSION_TOOLS);

// Every tool name pi's `tools:` allowlist accepts without loading any
// extension/MCP registration. This is the full pickable set for `/btw
// config`'s "Tools" row; selecting anything else would silently no-op since
// createBtwResourceLoader never loads extensions (see its docstring).
const BTW_AVAILABLE_TOOL_NAMES = ["read", "bash", "edit", "write", "grep", "find", "ls"] as const;

/**
 * Minimal checkbox-style multi-select for a SettingsList submenu.
 * SettingsList itself only supports single-value cycling (`values`) or a
 * free-form submenu Component, so tools/extensions selection needs this.
 */
class BtwMultiSelectSubmenu implements Component {
  private selectedIndex = 0;
  private readonly checked: Set<string>;
  private readonly options: { value: string; label: string }[];
  private readonly theme: { fg(color: string, text: string): string };
  private readonly done: (value?: string) => void;

  constructor(
    options: { value: string; label: string }[],
    initiallyChecked: string[],
    theme: { fg(color: string, text: string): string },
    done: (value?: string) => void,
  ) {
    this.options = options;
    this.theme = theme;
    this.done = done;
    this.checked = new Set(initiallyChecked);
  }

  render(width: number): string[] {
    const hint = this.theme.fg("dim", "↑/↓ move · space toggle · enter confirm · esc cancel");
    const rows = this.options.map((option, index) => {
      const box = this.checked.has(option.value) ? "[x]" : "[ ]";
      const text = truncateToWidth(`${box} ${option.label}`, width);
      return index === this.selectedIndex ? this.theme.fg("accent", text) : text;
    });
    return [hint, ...rows];
  }

  invalidate(): void {}

  handleInput(data: string): void {
    if (matchesKey(data, Key.escape)) {
      this.done(undefined);
      return;
    }
    if (matchesKey(data, Key.enter)) {
      this.done([...this.checked].join(","));
      return;
    }
    if (matchesKey(data, Key.space)) {
      const option = this.options[this.selectedIndex];
      if (option) {
        if (this.checked.has(option.value)) {
          this.checked.delete(option.value);
        } else {
          this.checked.add(option.value);
        }
      }
      return;
    }
    if (matchesKey(data, Key.up)) {
      this.selectedIndex = Math.max(0, this.selectedIndex - 1);
      return;
    }
    if (matchesKey(data, Key.down)) {
      this.selectedIndex = Math.min(this.options.length - 1, this.selectedIndex + 1);
    }
  }
}

function matchesBtwFocusShortcut(data: string): boolean {
  return BTW_FOCUS_SHORTCUTS.some((shortcut) => matchesKey(data, shortcut));
}

const BTW_SYSTEM_PROMPT = [
  "You are having an aside conversation with the user, separate from their main working session.",
  "If main session messages are provided, they are for context only — that work is being handled by another agent.",
  "If no main session messages are provided, treat this as a fully contextless tangent thread and rely only on the user's words plus your general instructions.",
  "Focus on answering the user's side questions, helping them think through ideas, or planning next steps.",
  "Do not act as if you need to continue unfinished work from the main session unless the user explicitly asks you to prepare something for injection back to it.",
].join(" ");

const BTW_SUMMARIZE_SYSTEM_PROMPT =
  "Summarize the side conversation concisely. Preserve key decisions, plans, insights, risks, and action items. Output only the summary.";

const BTW_CONTINUE_THREAD_USER_TEXT =
  "[The following is a separate side conversation. Continue this thread.]";
const BTW_CONTINUE_THREAD_ASSISTANT_TEXT = "Understood, continuing our side conversation.";

type SessionThinkingLevel = "off" | AiThinkingLevel;
type BtwThreadMode = "contextual" | "tangent";
type SessionModel = NonNullable<ExtensionCommandContext["model"]>;
/**
 * Loose model reference parsed from `/btw model <provider> <id> <api>` and persisted to
 * session entries. Resolved to a full SessionModel via ctx.modelRegistry.find(...).
 */
type BtwModelRef = Pick<SessionModel, "provider" | "id" | "api">;

type BtwDetails = {
  question: string;
  thinking: string;
  answer: string;
  provider: string;
  model: string;
  api: string;
  thinkingLevel: SessionThinkingLevel;
  timestamp: number;
  usage?: AssistantMessage["usage"];
};

type ParsedBtwArgs = {
  question: string;
  save: boolean;
};

type SaveState = "not-saved" | "saved" | "queued";

type BtwResetDetails = {
  timestamp: number;
  mode?: BtwThreadMode;
};

type BtwModelOverrideDetails =
  | ({ timestamp: number; action: "set" } & Pick<SessionModel, "provider" | "id" | "api">)
  | { timestamp: number; action: "clear" };

type BtwThinkingOverrideDetails =
  | { timestamp: number; action: "set"; thinkingLevel: SessionThinkingLevel }
  | { timestamp: number; action: "clear" };

type ResolvedBtwModel = {
  model: SessionModel | null;
  source: "override" | "main" | "none";
  configuredOverride: SessionModel | null;
  fallbackReason?: string;
};

type ResolvedBtwSettings = {
  model: SessionModel | null;
  modelSource: "override" | "main" | "none";
  configuredModelOverride: SessionModel | null;
  thinkingLevel: SessionThinkingLevel;
  thinkingSource: "override" | "main";
  fallbackReason?: string;
};

type BtwTranscriptEntry =
  | {
      id: number;
      turnId: number;
      type: "turn-boundary";
      phase: "start" | "end";
    }
  | { id: number; turnId: number; type: "user-message"; text: string }
  | {
      id: number;
      turnId: number;
      type: "thinking";
      text: string;
      streaming: boolean;
    }
  | {
      id: number;
      turnId: number;
      type: "assistant-text";
      text: string;
      streaming: boolean;
    }
  | {
      id: number;
      turnId: number;
      type: "tool-call";
      toolCallId: string;
      toolName: string;
      args: string;
    }
  | {
      id: number;
      turnId: number;
      type: "tool-result";
      toolCallId: string;
      toolName: string;
      content: string;
      truncated: boolean;
      isError: boolean;
      streaming: boolean;
    };

type BtwTranscript = BtwTranscriptEntry[];

type BtwTranscriptState = {
  entries: BtwTranscript;
  nextEntryId: number;
  nextTurnId: number;
  currentTurnId: number | null;
  lastTurnId: number | null;
  toolCalls: Map<string, { turnId: number; callEntryId: number; resultEntryId?: number }>;
};

type BtwSessionRuntime = {
  session: AgentSession;
  mode: BtwThreadMode;
  subscriptions: Set<() => void>;
  sideThreadStartIndex: number;
};

type OverlayRuntime = {
  handle?: OverlayHandle;
  refresh?: () => void;
  close?: () => void;
  finish?: () => void;
  setDraft?: (value: string) => void;
  closed?: boolean;
};

function isVisibleBtwMessage(message: { role: string; customType?: string }): boolean {
  return message.role === "custom" && message.customType === BTW_MESSAGE_TYPE;
}

function isCustomEntry(
  entry: unknown,
  customType: string,
): entry is { type: "custom"; customType: string; data?: unknown } {
  return (
    !!entry &&
    typeof entry === "object" &&
    (entry as { type?: string }).type === "custom" &&
    (entry as { customType?: string }).customType === customType
  );
}

function stripDynamicSystemPromptFooter(systemPrompt: string): string {
  return systemPrompt
    .replace(/\nCurrent date and time:[^\n]*(?:\nCurrent working directory:[^\n]*)?$/u, "")
    .replace(/\nCurrent working directory:[^\n]*$/u, "")
    .trim();
}

function createBtwResourceLoader(
  ctx: ExtensionCommandContext,
  appendSystemPrompt: string[] = [BTW_SYSTEM_PROMPT],
): ResourceLoader {
  // Deliberately empty: no extensions/MCP servers are loaded into BTW
  // sub-sessions. Doing so would require the internal (non-exported)
  // path-scoped extension loader, or the public discoverAndLoadExtensions()
  // which always rescans every standard extension directory too - i.e. no
  // way to load just a chosen few without loading everything the main
  // session already has running.
  const extensionsResult = {
    extensions: [],
    errors: [],
    runtime: createExtensionRuntime(),
  };
  const systemPrompt = stripDynamicSystemPromptFooter(ctx.getSystemPrompt());

  return {
    getExtensions: () => extensionsResult,
    getSkills: () => ({ skills: [], diagnostics: [] }),
    getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }),
    getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt,
    getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => appendSystemPrompt,
    getAppendSystemPromptSources: () => [],
    extendResources: () => {},
    reload: async () => {},
  };
}

function getModelRuntime(ctx: ExtensionCommandContext): ModelRuntime {
  // ModelRegistry keeps the active runtime private, but sub-sessions must share it
  // so extension-registered providers such as CLIProxyAPI remain available.
  return (ctx.modelRegistry as unknown as { runtime: ModelRuntime }).runtime;
}

function extractText(parts: AssistantMessage["content"], type: "text" | "thinking"): string {
  const chunks: string[] = [];

  for (const part of parts) {
    if (type === "text" && part.type === "text") {
      chunks.push(part.text);
    } else if (type === "thinking" && part.type === "thinking") {
      chunks.push(part.thinking);
    }
  }

  return chunks.join("\n").trim();
}

function extractAnswer(message: AssistantMessage): string {
  return extractText(message.content, "text") || "(No text response)";
}

function extractThinking(message: AssistantMessage): string {
  return extractText(message.content, "thinking");
}

function parseBtwArgs(args: string): ParsedBtwArgs {
  const save = /(?:^|\s)(?:--save|-s)(?=\s|$)/.test(args);
  const question = args.replace(/(?:^|\s)(?:--save|-s)(?=\s|$)/g, " ").trim();
  return { question, save };
}

const BTW_COMMAND_ARGUMENTS = [
  { value: "ask", label: "ask", description: "Ask a contextual side question" },
  {
    value: "new",
    label: "new",
    description: "Start a fresh contextual thread",
  },
  {
    value: "tangent",
    label: "tangent",
    description: "Start a contextless thread",
  },
  { value: "clear", label: "clear", description: "Clear the current thread" },
  {
    value: "inject",
    label: "inject",
    description: "Send the thread to the main agent",
  },
  {
    value: "summarize",
    label: "summarize",
    description: "Summarize and send the thread",
  },
  { value: "resume", label: "resume", description: "Resume an earlier thread" },
  { value: "model", label: "model", description: "Show or set the BTW model" },
  {
    value: "thinking",
    label: "thinking",
    description: "Show or set thinking level",
  },
  {
    value: "config",
    label: "config",
    description: "Edit BTW settings (model, thinking, tools) like /settings",
  },
  {
    value: "settings",
    label: "settings",
    description: "Alias for /btw config",
  },
  { value: "help", label: "help", description: "Show BTW command help" },
];

const BTW_USAGE = [
  "Usage: /btw [command] [arguments]",
  "  /btw ask [--save] <question>",
  "  /btw new [--save] [question]",
  "  /btw tangent [--save] [question]",
  "  /btw clear | resume | help",
  "  /btw inject [instructions]",
  "  /btw summarize [instructions]",
  "  /btw model [provider model api | clear]",
  "  /btw thinking [level | clear]",
  "  /btw config | settings",
].join("\n");

function getBtwArgumentCompletions(argumentPrefix: string) {
  const normalized = argumentPrefix.trim().toLowerCase();
  if (normalized.includes(" ")) {
    return null;
  }

  const filtered = BTW_COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(normalized));
  return filtered.length > 0 ? [...filtered] : null;
}

function parseBtwCommand(args: string): { name: string; args: string } {
  const trimmed = args.trim();
  const match = trimmed.match(/^(\S+)(?:\s+([\s\S]*))?$/);
  const candidate = match?.[1]?.toLowerCase();
  const isCommand = candidate && BTW_COMMAND_ARGUMENTS.some((item) => item.value === candidate);

  return isCommand
    ? { name: candidate, args: match?.[2]?.trim() ?? "" }
    : { name: "ask", args: trimmed };
}

function parseBtwModelArgs(
  args: string,
):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; model: BtwModelRef }
  | { action: "invalid"; message: string } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  const parts = trimmed.split(/\s+/);
  if (parts.length !== 3) {
    return {
      action: "invalid",
      message: "Usage: /btw model <provider> <model> <api> | clear",
    };
  }

  const [provider, id, api] = parts;
  return { action: "set", model: { provider, id, api } as BtwModelRef };
}

function parseBtwThinkingArgs(
  args: string,
):
  | { action: "show" }
  | { action: "clear" }
  | { action: "set"; thinkingLevel: SessionThinkingLevel } {
  const trimmed = args.trim();
  if (!trimmed) {
    return { action: "show" };
  }

  if (trimmed === "clear") {
    return { action: "clear" };
  }

  return { action: "set", thinkingLevel: trimmed as SessionThinkingLevel };
}

function formatModelRef(model: Pick<SessionModel, "provider" | "id" | "api">): string {
  return `${model.provider}/${model.id} (${model.api})`;
}

type BtwConfigFile = {
  model?: BtwModelRef;
  thinkingLevel?: SessionThinkingLevel;
  /** Built-in tool names enabled for BTW sub-sessions. Defaults to BTW_SUB_SESSION_TOOLS when unset/empty. */
  tools?: string[];
};

function resolveBtwToolNames(config: BtwConfigFile): string[] {
  return config.tools && config.tools.length > 0 ? config.tools : [...BTW_SUB_SESSION_TOOLS];
}

function getBtwConfigPath(): string {
  return join(getAgentDir(), BTW_CONFIG_FILENAME);
}

// ponytail: best-effort read/write, no file locking. A concurrent pi process writing
// pi-btw.json at the same instant can lose a write; acceptable for a single-user config file.
function readBtwConfig(): BtwConfigFile {
  try {
    return JSON.parse(readFileSync(getBtwConfigPath(), "utf8")) as BtwConfigFile;
  } catch {
    return {};
  }
}

function writeBtwConfig(config: BtwConfigFile): void {
  try {
    writeFileSync(getBtwConfigPath(), `${JSON.stringify(config, null, 2)}\n`, "utf8");
  } catch {
    // Best-effort persistence; a write failure just means the next session falls back to inherited defaults.
  }
}

/**
 * Drops tool-call/tool-result history for tools the BTW sub-session can't
 * actually call, and strips all `thinking`/redacted-thinking blocks.
 *
 * Contextual `/btw` threads seed the child from the main session's message
 * history, which can include calls to MCP/extension tools that only exist
 * in the parent's toolset (e.g. UI-automation tools). Left in, the child
 * sees itself having used those tools and imitates the call, which then
 * fails with "Tool ... not found".
 *
 * Thinking blocks are provider/model-specific (signed or encrypted against
 * the exact turn that produced them) and aren't portable into a fresh
 * session - replaying them verbatim, or even just reconstructing their
 * sibling content array, makes providers like Codex reject the request with
 * "thinking blocks ... cannot be modified". The answer text already carries
 * everything the child needs, so thinking is dropped unconditionally.
 */
export function stripForeignToolActivity(
  messages: Message[],
  allowedTools: ReadonlySet<string>,
): Message[] {
  const droppedCallIds = new Set<string>();
  const filtered: Message[] = [];

  for (const message of messages) {
    if (message.role === "assistant") {
      const content = message.content.filter((part) => {
        if (part.type === "thinking") {
          return false;
        }
        if (part.type !== "toolCall" || allowedTools.has(part.name)) {
          return true;
        }
        droppedCallIds.add(part.id);
        return false;
      });
      if (content.length === 0) {
        continue;
      }
      filtered.push({ ...message, content });
      continue;
    }

    if (
      message.role === "toolResult" &&
      (!allowedTools.has(message.toolName) || droppedCallIds.has(message.toolCallId))
    ) {
      continue;
    }

    filtered.push(message);
  }

  return filtered;
}

function buildBtwSeedState(
  ctx: ExtensionCommandContext,
  thread: BtwDetails[],
  mode: BtwThreadMode,
  sessionModel: SessionModel | null,
  allowedTools: ReadonlySet<string>,
): { messages: Message[]; sideThreadStartIndex: number } {
  const messages: Message[] = [];

  if (mode === "contextual") {
    const contextMessages: Message[] = [];
    try {
      contextMessages.push(
        ...(
          buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId())
            .messages as Message[]
        ).filter((message) => !isVisibleBtwMessage(message)),
      );
    } catch {
      contextMessages.push(
        ...ctx.sessionManager.getEntries().flatMap((entry) => {
          if (!entry || typeof entry !== "object") {
            return [];
          }

          const message = entry as unknown as Partial<Message> & {
            role?: string;
            customType?: string;
            content?: unknown;
          };
          if (typeof message.role !== "string" || !Array.isArray(message.content)) {
            return [];
          }

          return isVisibleBtwMessage({
            role: message.role,
            customType: message.customType,
          })
            ? []
            : [message as Message];
        }),
      );
    }
    messages.push(...stripForeignToolActivity(contextMessages, allowedTools));
  }

  const sideThreadStartIndex = messages.length;

  if (thread.length > 0) {
    messages.push(
      {
        role: "user",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_USER_TEXT }],
        timestamp: Date.now(),
      },
      {
        role: "assistant",
        content: [{ type: "text", text: BTW_CONTINUE_THREAD_ASSISTANT_TEXT }],
        provider: sessionModel?.provider ?? "unknown",
        model: sessionModel?.id ?? "unknown",
        api: sessionModel?.api ?? "openai-responses",
        usage: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          totalTokens: 0,
          cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason: "stop",
        timestamp: Date.now(),
      },
    );

    for (const entry of thread) {
      messages.push(
        {
          role: "user",
          content: [{ type: "text", text: entry.question }],
          timestamp: entry.timestamp,
        },
        {
          role: "assistant",
          content: [{ type: "text", text: entry.answer }],
          provider: entry.provider,
          model: entry.model,
          api: entry.api || sessionModel?.api || ctx.model?.api || "openai-responses",
          usage: entry.usage ?? {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 0,
            cost: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              total: 0,
            },
          },
          stopReason: "stop",
          timestamp: entry.timestamp,
        },
      );
    }
  }

  return {
    messages,
    sideThreadStartIndex,
  };
}

function formatToolPreview(value: unknown): string {
  if (value === undefined) {
    return "";
  }

  if (typeof value === "string") {
    return value;
  }

  if (value && typeof value === "object") {
    const path = (value as { path?: unknown }).path;
    if (typeof path === "string") {
      return path;
    }
  }

  try {
    const preview = JSON.stringify(value);
    if (!preview || preview === "{}") {
      return "";
    }
    return preview.length > 120 ? `${preview.slice(0, 117)}...` : preview;
  } catch {
    return "";
  }
}

function createEmptyTranscriptState(): BtwTranscriptState {
  return {
    entries: [],
    nextEntryId: 1,
    nextTurnId: 1,
    currentTurnId: null,
    lastTurnId: null,
    toolCalls: new Map(),
  };
}

function appendTranscriptEntry<T extends BtwTranscriptEntry>(
  state: BtwTranscriptState,
  entry: Omit<T, "id">,
): T {
  const nextEntry = { ...entry, id: state.nextEntryId++ } as T;
  state.entries.push(nextEntry);
  return nextEntry;
}

function ensureTranscriptTurn(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    return state.currentTurnId;
  }

  const turnId = state.nextTurnId++;
  state.currentTurnId = turnId;
  state.lastTurnId = turnId;
  appendTranscriptEntry(state, {
    type: "turn-boundary",
    turnId,
    phase: "start",
  } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  return turnId;
}

function finishTranscriptTurn(state: BtwTranscriptState, turnId?: number | null): void {
  const resolvedTurnId = turnId ?? state.currentTurnId;
  if (resolvedTurnId === null || resolvedTurnId === undefined) {
    return;
  }

  const hasEndBoundary = state.entries.some(
    (entry) =>
      entry.turnId === resolvedTurnId && entry.type === "turn-boundary" && entry.phase === "end",
  );
  if (!hasEndBoundary) {
    appendTranscriptEntry(state, {
      type: "turn-boundary",
      turnId: resolvedTurnId,
      phase: "end",
    } as Omit<Extract<BtwTranscriptEntry, { type: "turn-boundary" }>, "id">);
  }

  for (const entry of state.entries) {
    if (entry.turnId !== resolvedTurnId) {
      continue;
    }

    if (
      entry.type === "thinking" ||
      entry.type === "assistant-text" ||
      entry.type === "tool-result"
    ) {
      entry.streaming = false;
    }
  }

  state.lastTurnId = resolvedTurnId;
  if (state.currentTurnId === resolvedTurnId) {
    state.currentTurnId = null;
  }
}

function removeTranscriptTurn(state: BtwTranscriptState, turnId: number | null): void {
  if (turnId === null) {
    return;
  }

  state.entries = state.entries.filter((entry) => entry.turnId !== turnId);
  for (const [toolCallId, toolCall] of state.toolCalls.entries()) {
    if (toolCall.turnId === turnId) {
      state.toolCalls.delete(toolCallId);
    }
  }

  if (state.currentTurnId === turnId) {
    state.currentTurnId = null;
  }
  if (state.lastTurnId === turnId) {
    state.lastTurnId = null;
  }
}

function findLatestTranscriptEntry<TType extends BtwTranscriptEntry["type"]>(
  state: BtwTranscriptState,
  turnId: number,
  type: TType,
): Extract<BtwTranscriptEntry, { type: TType }> | undefined {
  for (let i = state.entries.length - 1; i >= 0; i--) {
    const entry = state.entries[i];
    if (entry.turnId === turnId && entry.type === type) {
      return entry as Extract<BtwTranscriptEntry, { type: TType }>;
    }
  }

  return undefined;
}

function ensureTranscriptTurnForUserMessage(state: BtwTranscriptState): number {
  if (state.currentTurnId !== null) {
    const currentAssistant = findLatestTranscriptEntry(
      state,
      state.currentTurnId,
      "assistant-text",
    );
    if (currentAssistant && !currentAssistant.streaming) {
      finishTranscriptTurn(state, state.currentTurnId);
    }
  }

  return ensureTranscriptTurn(state);
}

function extractMessageText(message: {
  content?: string | AssistantMessage["content"] | UserMessage["content"];
}): string {
  if (typeof message.content === "string") {
    return message.content;
  }
  if (!Array.isArray(message.content)) {
    return "";
  }
  return message.content
    .filter(
      (part): part is { type: "text"; text: string } =>
        part.type === "text" && typeof part.text === "string",
    )
    .map((part) => part.text)
    .join("\n")
    .trim();
}

function upsertUserMessageEntry(state: BtwTranscriptState, turnId: number, text: string): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, "user-message");
  if (existing) {
    existing.text = text;
    return;
  }

  appendTranscriptEntry(state, { type: "user-message", turnId, text } as Omit<
    Extract<BtwTranscriptEntry, { type: "user-message" }>,
    "id"
  >);
}

function upsertTranscriptTextEntry(
  state: BtwTranscriptState,
  turnId: number,
  type: "thinking" | "assistant-text",
  text: string,
  streaming: boolean,
): void {
  if (!text) {
    return;
  }

  const existing = findLatestTranscriptEntry(state, turnId, type);
  if (existing) {
    existing.text = text;
    existing.streaming = streaming;
    return;
  }

  appendTranscriptEntry(state, { type, turnId, text, streaming } as Omit<
    Extract<BtwTranscriptEntry, { type: "thinking" | "assistant-text" }>,
    "id"
  >);
}

function summarizeToolResult(
  value: unknown,
  maxLength = 400,
): { content: string; truncated: boolean } {
  let content = "";

  if (value && typeof value === "object") {
    const toolValue = value as {
      content?: Array<{ type?: string; text?: string }>;
      error?: unknown;
      message?: unknown;
    };

    if (Array.isArray(toolValue.content)) {
      content = toolValue.content
        .filter((part) => part.type === "text" && typeof part.text === "string")
        .map((part) => part.text ?? "")
        .join("\n")
        .trim();
    }

    if (!content && typeof toolValue.error === "string") {
      content = toolValue.error;
    }

    if (!content && typeof toolValue.message === "string") {
      content = toolValue.message;
    }
  }

  if (!content) {
    if (typeof value === "string") {
      content = value;
    } else if (value !== undefined) {
      try {
        content = JSON.stringify(value, null, 2);
      } catch {
        content = String(value);
      }
    }
  }

  if (!content) {
    content = "(no tool output)";
  }

  const truncated = content.length > maxLength;
  return {
    content: truncated ? `${content.slice(0, maxLength - 3)}...` : content,
    truncated,
  };
}

function ensureToolCallEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  args: string,
): { turnId: number; callEntryId: number; resultEntryId?: number } {
  const existing = state.toolCalls.get(toolCallId);
  if (existing) {
    return existing;
  }

  const callEntry = appendTranscriptEntry(state, {
    type: "tool-call",
    turnId,
    toolCallId,
    toolName,
    args,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-call" }>, "id">);
  const record = { turnId, callEntryId: callEntry.id };
  state.toolCalls.set(toolCallId, record);
  return record;
}

function upsertToolResultEntry(
  state: BtwTranscriptState,
  turnId: number,
  toolCallId: string,
  toolName: string,
  content: string,
  truncated: boolean,
  isError: boolean,
  streaming: boolean,
): void {
  const toolCall = ensureToolCallEntry(state, turnId, toolCallId, toolName, "");
  const existing =
    toolCall.resultEntryId !== undefined
      ? state.entries.find(
          (entry) => entry.id === toolCall.resultEntryId && entry.type === "tool-result",
        )
      : undefined;

  if (existing && existing.type === "tool-result") {
    existing.content = content;
    existing.truncated = truncated;
    existing.isError = isError;
    existing.streaming = streaming;
    return;
  }

  const resultEntry = appendTranscriptEntry(state, {
    type: "tool-result",
    turnId,
    toolCallId,
    toolName,
    content,
    truncated,
    isError,
    streaming,
  } as Omit<Extract<BtwTranscriptEntry, { type: "tool-result" }>, "id">);
  toolCall.resultEntryId = resultEntry.id;
}

function applyAssistantMessageToTranscript(
  state: BtwTranscriptState,
  turnId: number,
  message: AssistantMessage,
  streaming: boolean,
): void {
  const assistantMessage = message;
  const thinking = extractThinking(assistantMessage);
  const answer = extractMessageText(assistantMessage);

  if (thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", thinking, streaming);
  }

  if (answer) {
    upsertTranscriptTextEntry(state, turnId, "assistant-text", answer, streaming);
  }
}

function applyTranscriptEvent(state: BtwTranscriptState, event: AgentSessionEvent): void {
  switch (event.type) {
    case "turn_start": {
      ensureTranscriptTurn(state);
      return;
    }
    case "message_start": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, true);
      }
      return;
    }
    case "message_update": {
      if (event.message.role !== "assistant") {
        return;
      }

      const turnId = ensureTranscriptTurn(state);
      applyAssistantMessageToTranscript(state, turnId, event.message, true);
      return;
    }
    case "message_end": {
      if (event.message.role === "user") {
        const turnId = ensureTranscriptTurnForUserMessage(state);
        upsertUserMessageEntry(state, turnId, extractMessageText(event.message));
        return;
      }

      if (event.message.role === "assistant") {
        const turnId = ensureTranscriptTurn(state);
        applyAssistantMessageToTranscript(state, turnId, event.message, false);
      }
      return;
    }
    case "tool_execution_start": {
      const turnId = ensureTranscriptTurn(state);
      ensureToolCallEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        formatToolPreview(event.args),
      );
      return;
    }
    case "tool_execution_update": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.partialResult);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        false,
        true,
      );
      return;
    }
    case "tool_execution_end": {
      const turnId = state.toolCalls.get(event.toolCallId)?.turnId ?? ensureTranscriptTurn(state);
      const result = summarizeToolResult(event.result);
      upsertToolResultEntry(
        state,
        turnId,
        event.toolCallId,
        event.toolName,
        result.content,
        result.truncated,
        event.isError,
        false,
      );
      return;
    }
    case "turn_end": {
      finishTranscriptTurn(state);
      return;
    }
    default:
      return;
  }
}

function appendPersistedTranscriptTurn(state: BtwTranscriptState, details: BtwDetails): void {
  const turnId = ensureTranscriptTurn(state);
  upsertUserMessageEntry(state, turnId, details.question);
  if (details.thinking) {
    upsertTranscriptTextEntry(state, turnId, "thinking", details.thinking, false);
  }
  upsertTranscriptTextEntry(state, turnId, "assistant-text", details.answer, false);
  finishTranscriptTurn(state, turnId);
}

function setTranscriptFailure(state: BtwTranscriptState, message: string): void {
  const turnId = state.currentTurnId ?? state.lastTurnId ?? ensureTranscriptTurn(state);
  upsertTranscriptTextEntry(state, turnId, "assistant-text", `❌ ${message}`, false);
  finishTranscriptTurn(state, turnId);
}

function hasStreamingTranscriptEntry(entries: BtwTranscript): boolean {
  return entries.some(
    (entry) =>
      (entry.type === "thinking" ||
        entry.type === "assistant-text" ||
        entry.type === "tool-result") &&
      entry.streaming,
  );
}

function getCompletedExchangeCount(entries: BtwTranscript): number {
  return entries.filter((entry) => entry.type === "assistant-text" && !entry.streaming).length;
}

function buildOverlayTranscript(
  entries: BtwTranscript,
  theme: ExtensionContext["ui"]["theme"],
): string[] {
  if (entries.length === 0) {
    return [theme.fg("dim", "No BTW thread yet. Ask a side question to start one.")];
  }

  const lines: string[] = [];
  const userBadge = buildTranscriptBadge(theme, "You", "userMessageBg", "accent");
  const thinkingBadge = buildTranscriptBadge(theme, "Thinking", "toolPendingBg", "warning");
  const toolBadge = buildTranscriptBadge(theme, "Tool", "toolPendingBg", "warning");
  const assistantBadge = buildTranscriptBadge(theme, "Assistant", "customMessageBg", "success");
  const separator = theme.fg("borderMuted", "────────────────────────────────────────");
  const blockIndent = "    ";
  const resultIndent = blockIndent;

  const pushBlankLine = () => {
    if (lines.length > 0 && lines[lines.length - 1] !== "") {
      lines.push("");
    }
  };

  const pushInlineBlock = (
    header: string,
    text: string,
    options: { blankBefore?: boolean; style?: (value: string) => string } = {},
  ) => {
    const bodyLines = text.split("\n");
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    const firstLine = bodyLines.shift() ?? "";
    lines.push(`${header}${firstLine ? ` ${style(firstLine)}` : ""}`);
    for (const line of bodyLines) {
      lines.push(`${blockIndent}${style(line)}`);
    }
  };

  const pushStackedBlock = (
    header: string,
    text: string,
    options: {
      blankBefore?: boolean;
      indent?: string;
      style?: (value: string) => string;
    } = {},
  ) => {
    const bodyLines = text.split("\n");
    const indent = options.indent ?? blockIndent;
    const style = options.style ?? ((value: string) => value);
    if (options.blankBefore !== false) {
      pushBlankLine();
    }

    lines.push(header);
    for (const line of bodyLines) {
      lines.push(`${indent}${style(line)}`);
    }
  };

  for (const entry of entries) {
    if (entry.type === "turn-boundary") {
      if (entry.phase === "start" && lines.length > 0) {
        pushBlankLine();
        lines.push(separator);
      }
      continue;
    }

    if (entry.type === "user-message") {
      pushInlineBlock(userBadge, entry.text, { blankBefore: false });
      continue;
    }

    if (entry.type === "thinking") {
      const thinkingHeader = entry.streaming
        ? `${thinkingBadge} ${theme.fg("warning", "▍")}`
        : thinkingBadge;
      pushStackedBlock(thinkingHeader, entry.text, {
        style: (line) => theme.fg("warning", theme.italic(line)),
      });
      continue;
    }

    if (entry.type === "tool-call") {
      const toolLabel = theme.fg("warning", theme.bold(entry.toolName));
      const argsLabel = entry.args ? theme.fg("dim", ` · ${entry.args}`) : "";
      pushInlineBlock(toolBadge, `${toolLabel}${argsLabel}`);
      continue;
    }

    if (entry.type === "tool-result") {
      const resultHeaderLabel = entry.isError
        ? theme.fg("error", "↳ error")
        : entry.streaming
          ? theme.fg("warning", "↳ streaming result")
          : theme.fg("dim", "↳ result");
      const truncationLabel = entry.truncated ? theme.fg("dim", " (truncated)") : "";
      pushStackedBlock(`${resultHeaderLabel}${truncationLabel}`, entry.content, {
        blankBefore: false,
        indent: resultIndent,
        style: (line) => (entry.isError ? theme.fg("error", line) : theme.fg("dim", line)),
      });
      continue;
    }

    if (entry.type === "assistant-text") {
      const assistantHeader = entry.streaming
        ? `${assistantBadge} ${theme.fg("warning", "▍")}`
        : assistantBadge;
      pushStackedBlock(assistantHeader, entry.text);
    }
  }

  return lines;
}

function getLastAssistantMessage(session: AgentSession): AssistantMessage | null {
  for (let i = session.state.messages.length - 1; i >= 0; i--) {
    const message = session.state.messages[i];
    if (message.role === "assistant") {
      return message as AssistantMessage;
    }
  }

  return null;
}

type BtwHandoffExchange = {
  user: string;
  assistant: string;
};

function buildBtwMessageContent(question: string, answer: string): string {
  return `Q: ${question}\n\nA: ${answer}`;
}

function formatThread(thread: BtwHandoffExchange[]): string {
  return thread
    .map((entry) => `User: ${entry.user.trim()}\nAssistant: ${entry.assistant.trim()}`)
    .join("\n\n---\n\n");
}

function isThreadContinuationMarker(messages: Message[], index: number): boolean {
  const userMessage = messages[index];
  const assistantMessage = messages[index + 1];
  return (
    userMessage?.role === "user" &&
    extractMessageText(userMessage) === BTW_CONTINUE_THREAD_USER_TEXT &&
    assistantMessage?.role === "assistant" &&
    extractMessageText(assistantMessage) === BTW_CONTINUE_THREAD_ASSISTANT_TEXT
  );
}

function extractBtwHandoffThread(sessionRuntime: BtwSessionRuntime): BtwHandoffExchange[] {
  const handoffMessages = sessionRuntime.session.state.messages.slice(
    sessionRuntime.sideThreadStartIndex,
  );
  const threadMessages = isThreadContinuationMarker(handoffMessages as Message[], 0)
    ? handoffMessages.slice(2)
    : handoffMessages;
  const exchanges: BtwHandoffExchange[] = [];
  let currentUser = "";
  let currentAssistant = "";

  const pushCurrent = () => {
    if (!currentUser && !currentAssistant) {
      return;
    }

    exchanges.push({
      user: currentUser.trim() || "(No user prompt)",
      assistant: currentAssistant.trim() || "(No assistant response)",
    });
    currentUser = "";
    currentAssistant = "";
  };

  for (const message of threadMessages) {
    if (message.role !== "user" && message.role !== "assistant") {
      continue;
    }

    const text = extractMessageText(message).trim();
    if (!text) {
      continue;
    }

    if (message.role === "user") {
      pushCurrent();
      currentUser = text;
      continue;
    }

    currentAssistant = currentAssistant ? `${currentAssistant}\n\n${text}` : text;
  }

  pushCurrent();
  return exchanges;
}

function saveVisibleBtwNote(
  pi: ExtensionAPI,
  details: BtwDetails,
  saveRequested: boolean,
  wasBusy: boolean,
): SaveState {
  if (!saveRequested) {
    return "not-saved";
  }

  const message = {
    customType: BTW_MESSAGE_TYPE,
    content: buildBtwMessageContent(details.question, details.answer),
    display: true,
    details,
  };

  if (wasBusy) {
    pi.sendMessage(message, { deliverAs: "followUp" });
    return "queued";
  }

  pi.sendMessage(message);
  return "saved";
}

function notify(
  ctx: ExtensionContext | ExtensionCommandContext,
  message: string,
  level: "info" | "warning" | "error",
): void {
  if (ctx.hasUI) {
    ctx.ui.notify(message, level);
  }
}

/** Fixed overlay rows outside the transcript viewport (must match render() structure). */
const BTW_OVERLAY_CHROME_LINES = 9;

function getOverlayTitle(mode: BtwThreadMode): string {
  return mode === "tangent" ? "BTW tangent" : "BTW";
}

function buildTranscriptBadge(
  theme: ExtensionContext["ui"]["theme"],
  label: string,
  background: "userMessageBg" | "toolPendingBg" | "customMessageBg",
  foreground: "accent" | "warning" | "success",
): string {
  return theme.bg(background, theme.fg(foreground, theme.bold(` ${label} `)));
}

class BtwOverlayComponent extends Container implements Focusable {
  private readonly input: Input;
  private readonly transcript: Container;
  private readonly statusText: Text;
  private readonly modeText: Text;
  private readonly summaryText: Text;
  private readonly hintsText: Text;
  private readonly readTranscriptEntries: () => BtwTranscript;
  private readonly getStatus: () => string | null;
  private readonly getMode: () => BtwThreadMode;
  private readonly onSubmitCallback: (value: string) => void;
  private readonly onDismissCallback: () => void;
  private readonly onUnfocusCallback: () => void;
  private readonly tui: TUI;
  private readonly theme: ExtensionContext["ui"]["theme"];
  private transcriptLines: string[] = [];
  private transcriptScrollOffset = 0;
  private transcriptViewportHeight = 8;
  private followTranscript = true;
  private _focused = false;
  private modeTextValue = "";
  private summaryTextValue = "";
  private statusTextValue = "";
  private hintsTextValue = "";

  get focused(): boolean {
    return this._focused;
  }

  set focused(value: boolean) {
    this._focused = value;
    this.input.focused = value;
  }

  constructor(
    tui: TUI,
    theme: ExtensionContext["ui"]["theme"],
    keybindings: KeybindingsManager,
    readTranscriptEntries: () => BtwTranscript,
    getStatus: () => string | null,
    getMode: () => BtwThreadMode,
    onSubmit: (value: string) => void,
    onDismiss: () => void,
    onUnfocus: () => void,
  ) {
    super();
    this.tui = tui;
    this.theme = theme;
    this.readTranscriptEntries = readTranscriptEntries;
    this.getStatus = getStatus;
    this.getMode = getMode;
    this.onSubmitCallback = onSubmit;
    this.onDismissCallback = onDismiss;
    this.onUnfocusCallback = onUnfocus;

    this.modeText = new Text("", 1, 0);
    this.summaryText = new Text("", 1, 0);
    this.transcript = new Container();
    this.statusText = new Text("", 1, 0);

    this.input = new Input();
    this.input.onSubmit = (value) => {
      this.followTranscript = true;
      this.onSubmitCallback(value);
    };
    this.input.onEscape = () => {
      this.onDismissCallback();
    };

    this.hintsText = new Text("", 1, 0);

    // Enable SGR mouse reporting so wheel/touchpad events reach handleInput().
    this.tui.terminal?.write?.("\x1b[?1000h\x1b[?1006h");

    const originalHandleInput = this.input.handleInput.bind(this.input);
    this.input.handleInput = (data: string) => {
      if (keybindings.matches(data, "app.clear")) {
        if (this.input.getValue().length > 0) {
          this.input.setValue("");
          this.tui.requestRender();
          return;
        }

        this.onDismissCallback();
        return;
      }

      if (keybindings.matches(data, "tui.select.cancel")) {
        this.onDismissCallback();
        return;
      }
      originalHandleInput(data);
    };

    this.refresh();
  }

  private frameLine(content: string, innerWidth: number): string {
    const truncated = truncateToWidth(content, innerWidth, "");
    const padding = Math.max(0, innerWidth - visibleWidth(truncated));
    return `${this.theme.fg("border", "│")}${truncated}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
  }

  private ruleLine(innerWidth: number): string {
    return this.theme.fg("border", `├${"─".repeat(innerWidth)}┤`);
  }

  private borderLine(innerWidth: number, edge: "top" | "bottom"): string {
    const left = edge === "top" ? "┌" : "└";
    const right = edge === "top" ? "┐" : "┘";
    return this.theme.fg("border", `${left}${"─".repeat(innerWidth)}${right}`);
  }

  private wrapTranscript(innerWidth: number): string[] {
    const wrapped: string[] = [];
    for (const line of this.transcriptLines) {
      if (!line) {
        wrapped.push("");
        continue;
      }
      wrapped.push(...wrapTextWithAnsi(line, Math.max(1, innerWidth)));
    }
    return wrapped;
  }

  private getDialogHeight(): number {
    const terminalRows = process.stdout.rows ?? 30;
    return Math.max(18, Math.min(32, Math.floor(terminalRows * 0.78)));
  }

  private scrollTranscript(delta: number): void {
    if (delta < 0) {
      this.followTranscript = false;
    }
    this.transcriptScrollOffset = Math.max(0, this.transcriptScrollOffset + delta);
    this.tui.requestRender();
  }

  dispose(): void {
    this.tui.terminal?.write?.("\x1b[?1000l\x1b[?1006l");
  }

  private getMouseScrollDelta(data: string): number | null {
    const match = data.match(/^\x1b\[<(\d+);\d+;\d+[Mm]$/);
    if (!match) {
      return null;
    }

    const button = Number(match[1]);
    if ((button & 64) !== 64) {
      return null;
    }

    return (button & 1) === 0 ? -3 : 3;
  }

  handleInput(data: string): void {
    if (matchesBtwFocusShortcut(data)) {
      this.onUnfocusCallback();
      return;
    }

    const mouseScrollDelta = this.getMouseScrollDelta(data);
    if (mouseScrollDelta !== null) {
      this.scrollTranscript(mouseScrollDelta);
      return;
    }

    if (matchesKey(data, Key.pageUp) || matchesKey(data, Key.up)) {
      const step = matchesKey(data, Key.pageUp)
        ? Math.max(1, this.transcriptViewportHeight - 1)
        : 1;
      this.scrollTranscript(-step);
      return;
    }

    if (matchesKey(data, Key.pageDown) || matchesKey(data, Key.down)) {
      const step = matchesKey(data, Key.pageDown)
        ? Math.max(1, this.transcriptViewportHeight - 1)
        : 1;
      this.scrollTranscript(step);
      return;
    }

    this.input.handleInput(data);
  }

  private inputFrameLine(dialogWidth: number): string {
    const targetWidth = Math.max(1, dialogWidth - 2);
    const previousFocused = this.input.focused;
    // Input.render() emits CURSOR_MARKER when focused. In overlay mode that APC marker
    // can skew width/composition on this one row before the TUI strips it, producing a
    // right-edge notch and shifted border. Render the embedded input unfocused here so
    // the row stays geometrically stable while the overlay still owns keyboard input.
    this.input.focused = false;
    try {
      const renderedInputLine = this.input.render(targetWidth)[0] ?? "";
      const inputLine = truncateToWidth(renderedInputLine, targetWidth, "");
      const padding = Math.max(0, targetWidth - visibleWidth(inputLine));
      return `${this.theme.fg("border", "│")}${inputLine}${" ".repeat(padding)}${this.theme.fg("border", "│")}`;
    } finally {
      this.input.focused = previousFocused;
    }
  }

  private fitRenderedLine(line: string, width: number): string {
    return visibleWidth(line) > width ? truncateToWidth(line, width, "") : line;
  }

  override render(width: number): string[] {
    const dialogWidth = Math.max(24, width);
    const innerWidth = Math.max(22, dialogWidth - 2);
    const transcriptLines = this.wrapTranscript(innerWidth);
    const dialogHeight = this.getDialogHeight();
    const chromeHeight = BTW_OVERLAY_CHROME_LINES;
    const transcriptHeight = Math.max(6, dialogHeight - chromeHeight);
    this.transcriptViewportHeight = transcriptHeight;

    const maxScroll = Math.max(0, transcriptLines.length - transcriptHeight);
    if (this.followTranscript) {
      this.transcriptScrollOffset = maxScroll;
    } else {
      this.transcriptScrollOffset = Math.max(0, Math.min(this.transcriptScrollOffset, maxScroll));
      if (this.transcriptScrollOffset >= maxScroll) {
        this.followTranscript = true;
      }
    }

    const visibleTranscript = transcriptLines.slice(
      this.transcriptScrollOffset,
      this.transcriptScrollOffset + transcriptHeight,
    );
    const transcriptPadCount = Math.max(0, transcriptHeight - visibleTranscript.length);
    const hiddenAbove = this.transcriptScrollOffset;
    const hiddenBelow = Math.max(0, maxScroll - this.transcriptScrollOffset);
    const summary =
      hiddenAbove || hiddenBelow
        ? `${this.summaryTextValue.trim()} · ↑${hiddenAbove} ↓${hiddenBelow}`
        : this.summaryTextValue.trim();

    const lines = [this.borderLine(innerWidth, "top")];

    lines.push(
      this.frameLine(
        this.theme.fg("accent", this.theme.bold(this.modeTextValue.trim())),
        innerWidth,
      ),
    );
    lines.push(this.frameLine(this.theme.fg("dim", summary), innerWidth));
    lines.push(this.ruleLine(innerWidth));

    for (const line of visibleTranscript) {
      lines.push(this.frameLine(line, innerWidth));
    }
    for (let i = 0; i < transcriptPadCount; i++) {
      lines.push(this.frameLine("", innerWidth));
    }

    lines.push(this.ruleLine(innerWidth));
    lines.push(this.frameLine(this.theme.fg("warning", this.statusTextValue.trim()), innerWidth));
    lines.push(this.inputFrameLine(dialogWidth));
    lines.push(this.frameLine(this.theme.fg("dim", this.hintsTextValue.trim()), innerWidth));
    lines.push(this.borderLine(innerWidth, "bottom"));

    return lines.map((line) => this.fitRenderedLine(line, width));
  }

  setDraft(value: string): void {
    this.input.setValue(value);
    this.tui.requestRender();
  }

  getDraft(): string {
    return this.input.getValue();
  }

  getTranscriptEntries(): BtwTranscript {
    return this.readTranscriptEntries().map((entry) => ({ ...entry }));
  }

  refresh(): void {
    this.modeTextValue = `${getOverlayTitle(this.getMode())} · hidden thread preserved`;
    this.modeText.setText(this.modeTextValue);
    const entries = this.readTranscriptEntries();
    const exchanges = getCompletedExchangeCount(entries);
    const active = hasStreamingTranscriptEntry(entries) ? " · streaming" : " · idle";
    this.summaryTextValue = `${exchanges} exchange${exchanges === 1 ? "" : "s"}${active}`;
    this.summaryText.setText(this.summaryTextValue);

    this.transcriptLines = buildOverlayTranscript(entries, this.theme);
    this.transcript.clear();
    for (const line of this.transcriptLines) {
      this.transcript.addChild(new Text(line, 1, 0));
    }

    const status = this.getStatus() ?? "Ready. Enter submits; Escape dismisses without clearing.";
    this.statusTextValue = status;
    this.statusText.setText(this.statusTextValue);
    this.hintsTextValue = "Scroll wheel ↑↓ PgUp/PgDn · Enter · Alt+/ focus · Esc";
    this.hintsText.setText(this.hintsTextValue);
    this.tui.requestRender();
  }
}

export default function (pi: ExtensionAPI) {
  let pendingThread: BtwDetails[] = [];
  // Entries from a resumed segment that are only in memory/UI so far, not yet
  // re-appended to the session log. Flushed to the log (see runBtw) the first
  // time the thread actually continues with a new question - see the
  // ponytail note on resumeBtwThreadPicker for why.
  let pendingResumeCatchUp: BtwDetails[] = [];
  let pendingMode: BtwThreadMode = "contextual";
  let btwModelOverride: SessionModel | null = null;
  let btwThinkingOverride: SessionThinkingLevel | null = null;
  let btwQueue: string[] = [];
  let btwProcessing = false;
  let transcriptState = createEmptyTranscriptState();
  let overlayStatus: string | null = null;
  let overlayDraft = "";
  let overlayRuntime: OverlayRuntime | null = null;
  let lastUiContext: ExtensionContext | ExtensionCommandContext | null = null;
  let activeBtwSession: BtwSessionRuntime | null = null;

  function syncUi(ctx?: ExtensionContext | ExtensionCommandContext): void {
    const activeCtx = ctx ?? lastUiContext;
    if (activeCtx?.hasUI) {
      activeCtx.ui.setWidget("btw", undefined);
      overlayRuntime?.refresh?.();
    }
  }

  function setOverlayStatus(
    status: string | null,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    overlayStatus = status;
    syncUi(ctx);
  }

  function setOverlayDraft(value: string): void {
    overlayDraft = value;
    overlayRuntime?.setDraft?.(value);
  }

  function dismissOverlay(): void {
    overlayRuntime?.close?.();
    overlayRuntime = null;
  }

  function toggleOverlayFocus(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    if (handle.isFocused()) {
      handle.unfocus();
    } else {
      handle.focus();
    }
    overlayRuntime?.refresh?.();
  }

  function focusOverlay(): void {
    const handle = overlayRuntime?.handle;
    if (!handle) {
      return;
    }

    handle.setHidden(false);
    handle.focus();
    overlayRuntime?.refresh?.();
  }

  function removeBtwSessionSubscription(
    sessionRuntime: BtwSessionRuntime,
    unsubscribe: () => void,
  ): void {
    if (!sessionRuntime.subscriptions.delete(unsubscribe)) {
      return;
    }

    try {
      unsubscribe();
    } catch {
      // Ignore unsubscribe errors during BTW session replacement/shutdown.
    }
  }

  function clearBtwSessionSubscriptions(sessionRuntime: BtwSessionRuntime): void {
    for (const unsubscribe of [...sessionRuntime.subscriptions]) {
      removeBtwSessionSubscription(sessionRuntime, unsubscribe);
    }
  }

  function handleBtwSessionEvent(
    sessionRuntime: BtwSessionRuntime,
    event: AgentSessionEvent,
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    if (activeBtwSession?.session !== sessionRuntime.session || !overlayRuntime) {
      return;
    }

    applyTranscriptEvent(transcriptState, event);

    if (event.type === "tool_execution_start") {
      setOverlayStatus(`⏳ running tool: ${event.toolName}`, ctx);
      return;
    }

    if (event.type === "tool_execution_end") {
      setOverlayStatus(
        sessionRuntime.session.isStreaming
          ? `⏳ running tool: ${event.toolName}`
          : "⏳ streaming...",
        ctx,
      );
      return;
    }

    if (event.type === "turn_end") {
      setOverlayStatus("⏳ streaming...", ctx);
      return;
    }

    if (
      event.type === "message_start" ||
      event.type === "message_update" ||
      event.type === "message_end" ||
      event.type === "turn_start"
    ) {
      syncUi(ctx);
    }
  }

  function subscribeOverlayToActiveBtwSession(
    ctx?: ExtensionContext | ExtensionCommandContext,
  ): void {
    const sessionRuntime = activeBtwSession;
    if (!sessionRuntime || sessionRuntime.subscriptions.size > 0) {
      return;
    }

    const unsubscribe = sessionRuntime.session.subscribe((event: AgentSessionEvent) => {
      handleBtwSessionEvent(sessionRuntime, event, ctx);
    });
    sessionRuntime.subscriptions.add(unsubscribe);
  }

  async function disposeBtwSession(): Promise<void> {
    const current = activeBtwSession;
    activeBtwSession = null;
    if (!current) {
      return;
    }

    clearBtwSessionSubscriptions(current);

    try {
      await current.session.abort();
    } catch {
      // Ignore abort errors during BTW session replacement/shutdown.
    }

    current.session.dispose();
  }

  async function dismissOverlaySession(): Promise<void> {
    dismissOverlay();
    await disposeBtwSession();
  }

  async function resolveBtwModel(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedBtwModel> {
    if (btwModelOverride) {
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(btwModelOverride);
      if (auth.ok && auth.apiKey) {
        return {
          model: btwModelOverride,
          source: "override",
          configuredOverride: btwModelOverride,
        };
      }

      const fallbackReason = ctx.model
        ? `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials. Falling back to main model ${formatModelRef(
            ctx.model,
          )}.`
        : `Configured BTW model ${formatModelRef(btwModelOverride)} has no credentials, and no main model is active.`;
      if (notifyOnFallback) {
        notify(ctx, fallbackReason, "warning");
      }

      if (ctx.model) {
        return {
          model: ctx.model,
          source: "main",
          configuredOverride: btwModelOverride,
          fallbackReason,
        };
      }

      return {
        model: null,
        source: "none",
        configuredOverride: btwModelOverride,
        fallbackReason,
      };
    }

    if (ctx.model) {
      return {
        model: ctx.model,
        source: "main",
        configuredOverride: null,
      };
    }

    return {
      model: null,
      source: "none",
      configuredOverride: null,
    };
  }

  async function resolveBtwSettings(
    ctx: ExtensionCommandContext,
    notifyOnFallback = false,
  ): Promise<ResolvedBtwSettings> {
    const resolvedModel = await resolveBtwModel(ctx, notifyOnFallback);
    const thinkingLevel = btwThinkingOverride ?? (pi.getThinkingLevel() as SessionThinkingLevel);

    return {
      model: resolvedModel.model,
      modelSource: resolvedModel.source,
      configuredModelOverride: resolvedModel.configuredOverride,
      thinkingLevel,
      thinkingSource: btwThinkingOverride ? "override" : "main",
      fallbackReason: resolvedModel.fallbackReason,
    };
  }

  function describeResolvedModel(settings: ResolvedBtwSettings): string {
    if (!settings.model) {
      if (settings.configuredModelOverride && settings.fallbackReason) {
        return `BTW model unavailable. ${settings.fallbackReason}`;
      }
      return "BTW model unavailable. No active model selected.";
    }

    const source =
      settings.modelSource === "override"
        ? "override"
        : settings.configuredModelOverride
          ? "inherited fallback"
          : "inherits main thread";
    return `BTW model: ${formatModelRef(settings.model)} (${source}).${
      settings.fallbackReason ? ` ${settings.fallbackReason}` : ""
    }`;
  }

  function describeResolvedThinking(settings: ResolvedBtwSettings): string {
    const source = settings.thinkingSource === "override" ? "override" : "inherits main thread";
    return `BTW thinking: ${settings.thinkingLevel} (${source}).`;
  }

  async function setBtwModelOverride(
    ctx: ExtensionCommandContext,
    nextModel: SessionModel | null,
  ): Promise<void> {
    btwModelOverride = nextModel;
    const details: BtwModelOverrideDetails = nextModel
      ? {
          action: "set",
          timestamp: Date.now(),
          provider: nextModel.provider,
          id: nextModel.id,
          api: nextModel.api,
        }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_MODEL_OVERRIDE_TYPE, details);
    writeBtwConfig({
      ...readBtwConfig(),
      model: nextModel
        ? { provider: nextModel.provider, id: nextModel.id, api: nextModel.api }
        : undefined,
    });
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx);
    const message = nextModel
      ? `BTW model override set to ${formatModelRef(nextModel)}.`
      : "BTW model override cleared. BTW now inherits the main thread model.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedModel(settings)}`, "info");
  }

  async function setBtwThinkingOverride(
    ctx: ExtensionCommandContext,
    nextThinkingLevel: SessionThinkingLevel | null,
  ): Promise<void> {
    btwThinkingOverride = nextThinkingLevel;
    const details: BtwThinkingOverrideDetails = nextThinkingLevel
      ? {
          action: "set",
          timestamp: Date.now(),
          thinkingLevel: nextThinkingLevel,
        }
      : { action: "clear", timestamp: Date.now() };
    pi.appendEntry(BTW_THINKING_OVERRIDE_TYPE, details);
    writeBtwConfig({
      ...readBtwConfig(),
      thinkingLevel: nextThinkingLevel ?? undefined,
    });
    await disposeBtwSession();
    const settings = await resolveBtwSettings(ctx);
    const message = nextThinkingLevel
      ? `BTW thinking override set to ${nextThinkingLevel}.`
      : "BTW thinking override cleared. BTW now inherits the main thread thinking level.";
    setOverlayStatus(message, ctx);
    notify(ctx, `${message} ${describeResolvedThinking(settings)}`, "info");
  }

  async function setBtwToolsOverride(ctx: ExtensionCommandContext, tools: string[]): Promise<void> {
    writeBtwConfig({
      ...readBtwConfig(),
      tools: tools.length > 0 ? tools : undefined,
    });
    await disposeBtwSession();
    const resolved = resolveBtwToolNames(readBtwConfig());
    const message = `BTW tools: ${resolved.join(", ")}.`;
    setOverlayStatus(message, ctx);
    notify(ctx, message, "info");
  }

  async function showBtwConfig(ctx: ExtensionCommandContext): Promise<void> {
    if (!ctx.hasUI) {
      const settings = await resolveBtwSettings(ctx);
      notify(
        ctx,
        `${describeResolvedModel(settings)} ${describeResolvedThinking(settings)}`,
        "info",
      );
      return;
    }

    await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
      let list!: SettingsList;
      const config = readBtwConfig();
      const enabledTools = resolveBtwToolNames(config);
      const items: SettingItem[] = [
        {
          id: "model",
          label: "Model override",
          description:
            "'<provider> <id> <api>', 'clear', or blank to inherit the main thread model",
          currentValue: btwModelOverride
            ? formatModelRef(btwModelOverride)
            : "(inherit main model)",
          submenu: (_currentValue, close) => {
            const input = new Input();
            input.setValue(btwModelOverride ? formatModelRef(btwModelOverride) : "");
            input.onSubmit = (value) => close(value.trim());
            input.onEscape = () => close(undefined);
            return input;
          },
        },
        {
          id: "thinking",
          label: "Thinking override",
          description: "Thinking level used only for BTW threads",
          currentValue: btwThinkingOverride ?? "inherit",
          values: ["inherit", "off", "minimal", "low", "medium", "high", "xhigh", "max"],
        },
        {
          id: "tools",
          label: "Tools",
          description: "Tools enabled for BTW threads. Space to toggle, Enter to confirm",
          currentValue: enabledTools.join(", "),
          submenu: (_currentValue, close) => {
            const options = BTW_AVAILABLE_TOOL_NAMES.map((value) => ({
              value,
              label: value,
            }));
            return new BtwMultiSelectSubmenu(options, enabledTools, theme, close);
          },
        },
      ];

      list = new SettingsList(
        items,
        Math.min(items.length + 2, 10),
        getSettingsListTheme(),
        (id, value) => {
          if (id === "thinking") {
            void setBtwThinkingOverride(
              ctx,
              value === "inherit" ? null : (value as SessionThinkingLevel),
            );
            return;
          }
          if (id === "tools") {
            const names = value ? value.split(",").filter(Boolean) : [];
            void setBtwToolsOverride(ctx, names);
            list.updateValue("tools", resolveBtwToolNames({ tools: names }).join(", "));
            return;
          }
          if (id === "model") {
            const parsed = parseBtwModelArgs(value);
            if (parsed.action === "show") {
              return;
            }
            if (parsed.action === "invalid") {
              notify(ctx, parsed.message, "error");
              list.updateValue(
                "model",
                btwModelOverride ? formatModelRef(btwModelOverride) : "(inherit main model)",
              );
              return;
            }
            if (parsed.action === "clear") {
              void setBtwModelOverride(ctx, null);
              list.updateValue("model", "(inherit main model)");
              return;
            }
            const resolved = ctx.modelRegistry.find(parsed.model.provider, parsed.model.id);
            if (!resolved) {
              notify(ctx, `Unknown model ${parsed.model.provider}/${parsed.model.id}.`, "error");
              return;
            }
            void setBtwModelOverride(ctx, resolved);
            list.updateValue("model", formatModelRef(resolved));
          }
        },
        () => done(),
      );

      const container = new Container();
      container.addChild(new DynamicBorder((str) => theme.fg("border", str)));
      container.addChild(new Text(theme.fg("accent", theme.bold("BTW settings")), 1, 1));
      container.addChild(list);
      container.addChild(new DynamicBorder((str) => theme.fg("border", str)));

      return {
        render: (width: number) => container.render(width),
        invalidate: () => container.invalidate(),
        handleInput: (data: string) => {
          list.handleInput?.(data);
          tui.requestRender();
        },
      };
    });
  }

  async function createBtwSubSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
  ): Promise<BtwSessionRuntime> {
    const settings = await resolveBtwSettings(ctx, true);
    if (!settings.model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const config = readBtwConfig();
    const toolNames = resolveBtwToolNames(config);

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model: settings.model,
      modelRuntime: getModelRuntime(ctx),
      thinkingLevel: settings.thinkingLevel,
      // Defaults to pi's coding-agent toolset (read/bash/edit/write);
      // overridable via /btw config.
      tools: toolNames,
      resourceLoader: createBtwResourceLoader(ctx),
    });

    const { messages: seedMessages, sideThreadStartIndex } = buildBtwSeedState(
      ctx,
      pendingThread,
      mode,
      settings.model,
      new Set(toolNames),
    );
    if (seedMessages.length > 0) {
      session.agent.state.messages = seedMessages as typeof session.state.messages;
    }

    return { session, mode, subscriptions: new Set(), sideThreadStartIndex };
  }

  async function ensureBtwSession(
    ctx: ExtensionCommandContext,
    mode: BtwThreadMode,
  ): Promise<BtwSessionRuntime | null> {
    const settings = await resolveBtwSettings(ctx);
    if (!settings.model) {
      return null;
    }

    if (activeBtwSession?.mode === mode) {
      return activeBtwSession;
    }

    await disposeBtwSession();
    activeBtwSession = await createBtwSubSession(ctx, mode);
    return activeBtwSession;
  }

  async function ensureOverlay(ctx: ExtensionCommandContext | ExtensionContext): Promise<void> {
    if (!ctx.hasUI) {
      return;
    }
    lastUiContext = ctx;

    if (overlayRuntime?.handle) {
      subscribeOverlayToActiveBtwSession(ctx);
      focusOverlay();
      return;
    }

    const runtime: OverlayRuntime = {};
    const closeRuntime = () => {
      if (runtime.closed) {
        return;
      }
      runtime.closed = true;
      if (activeBtwSession) {
        clearBtwSessionSubscriptions(activeBtwSession);
      }
      runtime.handle?.hide();
      if (overlayRuntime === runtime) {
        overlayRuntime = null;
      }
      runtime.finish?.();
    };

    runtime.close = closeRuntime;
    overlayRuntime = runtime;

    void ctx.ui
      .custom<void>(
        async (tui, theme, keybindings, done) => {
          runtime.finish = () => {
            done();
          };

          const overlay = new BtwOverlayComponent(
            tui,
            theme,
            keybindings,
            () => transcriptState.entries,
            () => overlayStatus,
            () => pendingMode,
            (value) => {
              void submitFromOverlay(ctx, value);
            },
            () => {
              void dismissOverlaySession();
            },
            () => {
              overlayRuntime?.handle?.unfocus();
              overlayRuntime?.refresh?.();
            },
          );

          overlay.focused = runtime.handle?.isFocused() ?? true;
          overlay.setDraft(overlayDraft);
          runtime.setDraft = (value) => {
            overlay.setDraft(value);
          };
          runtime.refresh = () => {
            overlay.focused = runtime.handle?.isFocused() ?? false;
            overlay.refresh();
          };
          runtime.close = () => {
            overlayDraft = overlay.getDraft();
            overlay.dispose();
            closeRuntime();
          };

          subscribeOverlayToActiveBtwSession(ctx);

          if (runtime.closed) {
            done();
          }

          return overlay;
        },
        {
          overlay: true,
          overlayOptions: {
            width: "78%",
            minWidth: 72,
            maxHeight: "78%",
            anchor: "top-center",
            margin: { top: 1, left: 2, right: 2 },
            nonCapturing: true,
          },
          onHandle: (handle) => {
            runtime.handle = handle;
            handle.focus();
            if (runtime.closed) {
              closeRuntime();
            }
          },
        },
      )
      .catch((error) => {
        if (overlayRuntime === runtime) {
          overlayRuntime = null;
        }
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      });
  }

  async function processBtwQueue(ctx: ExtensionCommandContext, mode: BtwThreadMode): Promise<void> {
    if (btwProcessing) {
      return;
    }
    btwProcessing = true;
    try {
      while (btwQueue.length > 0) {
        const next = btwQueue.shift();
        if (next === undefined) {
          break;
        }
        await runBtw(ctx, next, false, mode);
      }
    } finally {
      btwProcessing = false;
    }
  }

  type BtwThreadSegment = {
    mode: BtwThreadMode;
    entries: BtwDetails[];
    isCurrent: boolean;
  };

  function listBtwThreadSegments(ctx: ExtensionContext): BtwThreadSegment[] {
    const branch = ctx.sessionManager.getBranch();
    const segments: BtwThreadSegment[] = [];
    let current: BtwThreadSegment = {
      mode: "contextual",
      entries: [],
      isCurrent: false,
    };

    for (const entry of branch) {
      if (isCustomEntry(entry, BTW_RESET_TYPE)) {
        if (current.entries.length > 0) {
          segments.push(current);
        }
        const details = (entry as unknown as { data?: BtwResetDetails }).data;
        current = {
          mode: details?.mode ?? "contextual",
          entries: [],
          isCurrent: false,
        };
        continue;
      }

      if (isCustomEntry(entry, BTW_ENTRY_TYPE)) {
        const details = (entry as unknown as { data?: BtwDetails }).data;
        if (details?.question && details.answer) {
          current.entries.push(details);
        }
      }
    }

    if (current.entries.length > 0) {
      segments.push(current);
    }
    if (segments.length > 0) {
      segments[segments.length - 1].isCurrent = true;
    }

    return segments;
  }

  function truncateLabel(text: string, maxLength = 40): string {
    const flat = text.replace(/\s+/g, " ").trim();
    return flat.length > maxLength ? `${flat.slice(0, maxLength - 3)}...` : flat;
  }

  function formatBtwSegmentLabel(segment: BtwThreadSegment, index: number): string {
    const first = segment.entries[0]?.question ?? "(untitled)";
    const modeLabel = segment.mode === "tangent" ? "tangent" : "contextual";
    return `${index + 1}. "${truncateLabel(first, 60)}" \u00b7 ${segment.entries.length} exchange${
      segment.entries.length === 1 ? "" : "s"
    } \u00b7 ${modeLabel}`;
  }

  async function resumeBtwThreadPicker(ctx: ExtensionCommandContext): Promise<void> {
    const resumable = listBtwThreadSegments(ctx).filter((segment) => !segment.isCurrent);
    if (resumable.length === 0) {
      notify(ctx, "No other saved BTW threads to resume.", "warning");
      return;
    }

    const labels = resumable.map((segment, i) => formatBtwSegmentLabel(segment, i));
    const choice = await ctx.ui.select("Resume a BTW thread:", labels);
    if (!choice) {
      return;
    }

    const segment = resumable[labels.indexOf(choice)];
    if (!segment) {
      return;
    }

    // ponytail: resuming only replays the segment into memory/UI, not back into the
    // session log - re-appending it there too duplicated the segment into a brand new
    // closeable chunk on every resume, so /btw resume kept ballooning with copies of
    // whatever was last resumed. The catch-up entries get flushed to the log lazily,
    // the first time this thread actually continues with a new question (see runBtw),
    // so reload-durability is preserved once you do anything beyond just browsing.
    // Corner case: reloading/switching branches right after resuming, before asking
    // anything new, loses the resumed view - the original segment is untouched and
    // still resumable, so nothing is actually lost, just resume it again.
    await resetThread(ctx, true, segment.mode);
    pendingResumeCatchUp = [...segment.entries];
    for (const details of segment.entries) {
      pendingThread.push(details);
      appendPersistedTranscriptTurn(transcriptState, details);
    }

    await ensureBtwSession(ctx, segment.mode);
    setOverlayStatus(
      `Resumed thread (${segment.entries.length} exchange${segment.entries.length === 1 ? "" : "s"}).`,
      ctx,
    );
    await ensureOverlay(ctx);
    notify(ctx, "Resumed BTW thread.", "info");
  }

  // ponytail: whole-exchange granularity instead of a character/line-range selector.
  // Covers "entire thread" / "last exchange" / "from exchange N onward"; add a real
  // range picker only if partial-exchange trimming turns out to matter in practice.
  async function selectBtwThreadScope(
    ctx: ExtensionCommandContext,
    thread: BtwHandoffExchange[],
  ): Promise<BtwHandoffExchange[] | null> {
    if (thread.length <= 1) {
      return thread;
    }

    const choices: { label: string; slice: BtwHandoffExchange[] }[] = [
      { label: "Entire thread", slice: thread },
      { label: "Last exchange only", slice: thread.slice(-1) },
    ];
    for (let idx = 1; idx < thread.length - 1; idx++) {
      choices.push({
        label: `From exchange ${idx + 1} onward: "${truncateLabel(thread[idx].user)}"`,
        slice: thread.slice(idx),
      });
    }

    const labels = choices.map((choice) => choice.label);
    const pick = await ctx.ui.select(
      `Bring how much of the BTW thread (${thread.length} exchanges)?`,
      labels,
    );
    if (!pick) {
      return null;
    }

    return choices[labels.indexOf(pick)]?.slice ?? null;
  }

  async function dispatchBtwCommand(
    name: string,
    args: string,
    ctx: ExtensionCommandContext,
  ): Promise<boolean> {
    const trimmedArgs = args.trim();

    if (name === "help") {
      notify(ctx, BTW_USAGE, "info");
      return true;
    }

    if (name === "ask") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (!question) {
        await ensureBtwSession(ctx, pendingMode);
        await ensureOverlay(ctx);
        return true;
      }

      if (pendingMode !== "contextual") {
        await resetThread(ctx, true, "contextual");
      }

      await runBtw(ctx, question, save, "contextual");
      return true;
    }

    if (name === "tangent") {
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (pendingMode !== "tangent") {
        await resetThread(ctx, true, "tangent");
      }

      if (!question) {
        await ensureBtwSession(ctx, "tangent");
        await ensureOverlay(ctx);
        return true;
      }

      await runBtw(ctx, question, save, "tangent");
      return true;
    }

    if (name === "new") {
      await resetThread(ctx, true, "contextual");
      const { question, save } = parseBtwArgs(trimmedArgs);
      if (question) {
        await runBtw(ctx, question, save, "contextual");
      } else {
        await ensureBtwSession(ctx, "contextual");
        setOverlayStatus("Started a fresh BTW thread.", ctx);
        await ensureOverlay(ctx);
        notify(ctx, "Started a fresh BTW thread.", "info");
      }
      return true;
    }

    if (name === "clear") {
      await resetThread(ctx);
      dismissOverlay();
      notify(ctx, "Cleared BTW thread.", "info");
      return true;
    }

    if (name === "model") {
      const parsed = parseBtwModelArgs(trimmedArgs);
      if (parsed.action === "invalid") {
        setOverlayStatus(parsed.message, ctx);
        notify(ctx, parsed.message, "error");
        return true;
      }

      if (parsed.action === "show") {
        const settings = await resolveBtwSettings(ctx);
        const message = describeResolvedModel(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, settings.model ? "info" : "warning");
        return true;
      }

      if (parsed.action === "clear") {
        await setBtwModelOverride(ctx, null);
        return true;
      }
      const ref = parsed.model;
      const resolved = ctx.modelRegistry.find(ref.provider, ref.id);
      if (!resolved) {
        const message = `Unknown model ${ref.provider}/${ref.id}. Use /login or /models to add it before setting it as the BTW override.`;
        setOverlayStatus(message, ctx);
        notify(ctx, message, "error");
        return true;
      }
      await setBtwModelOverride(ctx, resolved);
      return true;
    }

    if (name === "thinking") {
      const parsed = parseBtwThinkingArgs(trimmedArgs);
      if (parsed.action === "show") {
        const settings = await resolveBtwSettings(ctx);
        const message = describeResolvedThinking(settings);
        setOverlayStatus(message, ctx);
        notify(ctx, message, "info");
        return true;
      }

      await setBtwThinkingOverride(ctx, parsed.action === "clear" ? null : parsed.thinkingLevel);
      return true;
    }

    if (name === "config" || name === "settings") {
      await showBtwConfig(ctx);
      return true;
    }

    if (name === "inject") {
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to inject.", "warning");
        return true;
      }

      try {
        const { thread } = await getBtwHandoffThread(ctx);
        const scoped = await selectBtwThreadScope(ctx, thread);
        if (!scoped) {
          notify(ctx, "Inject cancelled.", "info");
          return true;
        }

        setOverlayStatus("⏳ injecting into the main session...", ctx);
        await ensureOverlay(ctx);

        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a side conversation I had. ${instructions}\n\n${formatThread(scoped)}`
          : `Here is a side conversation I had for additional context:\n\n${formatThread(scoped)}`;

        sendThreadToMain(ctx, content);
        const count = scoped.length;
        await resetThread(ctx);
        dismissOverlay();
        notify(ctx, `Injected BTW thread (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        setOverlayStatus("Inject failed. Thread preserved for retry or summarize.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (name === "summarize") {
      if (pendingThread.length === 0) {
        notify(ctx, "No BTW thread to summarize.", "warning");
        return true;
      }

      try {
        const { thread } = await getBtwHandoffThread(ctx);
        const scoped = await selectBtwThreadScope(ctx, thread);
        if (!scoped) {
          notify(ctx, "Summarize cancelled.", "info");
          return true;
        }

        setOverlayStatus("⏳ summarizing...", ctx);
        await ensureOverlay(ctx);

        const summary = await summarizeThread(ctx, scoped);
        const instructions = trimmedArgs;
        const content = instructions
          ? `Here is a summary of a side conversation I had. ${instructions}\n\n${summary}`
          : `Here is a summary of a side conversation I had:\n\n${summary}`;

        sendThreadToMain(ctx, content);
        const count = scoped.length;
        await resetThread(ctx);
        dismissOverlay();
        notify(ctx, `Injected BTW summary (${count} exchange${count === 1 ? "" : "s"}).`, "info");
      } catch (error) {
        setOverlayStatus("Summarize failed. Thread preserved for retry or injection.", ctx);
        notify(ctx, error instanceof Error ? error.message : String(error), "error");
      }
      return true;
    }

    if (name === "resume") {
      await resumeBtwThreadPicker(ctx);
      return true;
    }

    return false;
  }

  function parseOverlayBtwCommand(value: string): { name: string; args: string } | null {
    const trimmed = value.trim();
    const match = trimmed.match(/^\/btw(?::([^\s]+)|\s+([^\s]+))?(?:\s+([\s\S]*))?$/i);
    if (!match) {
      return null;
    }

    const name = (match[1] ?? match[2])?.toLowerCase();
    if (!name || !BTW_COMMAND_ARGUMENTS.some((item) => item.value === name)) {
      return null;
    }

    return {
      name,
      args: match[3]?.trim() ?? "",
    };
  }

  async function submitFromOverlay(
    ctx: ExtensionCommandContext | ExtensionContext,
    value: string,
  ): Promise<void> {
    const question = value.trim();
    if (!question) {
      setOverlayStatus("Enter a BTW prompt before submitting.", ctx);
      return;
    }

    if (!("getSystemPrompt" in ctx)) {
      setOverlayStatus(
        "BTW overlay submit requires a command context. Reopen BTW from a command.",
        ctx,
      );
      return;
    }

    const cmdCtx = ctx as ExtensionCommandContext;
    const btwCommand = parseOverlayBtwCommand(question);
    if (btwCommand) {
      setOverlayDraft("");
      await dispatchBtwCommand(btwCommand.name, btwCommand.args, cmdCtx);
      return;
    }

    setOverlayDraft("");
    btwQueue.push(question);
    if (btwProcessing) {
      setOverlayStatus(`Queued (${btwQueue.length} pending)...`, ctx);
      syncUi(ctx);
      return;
    }
    setOverlayStatus("⏳ streaming...", ctx);
    syncUi(ctx);
    await processBtwQueue(cmdCtx, pendingMode);
  }

  async function resetThread(
    ctx: ExtensionContext | ExtensionCommandContext,
    persist = true,
    mode: BtwThreadMode = "contextual",
  ): Promise<void> {
    await disposeBtwSession();
    pendingThread = [];
    pendingResumeCatchUp = [];
    pendingMode = mode;
    btwQueue = [];
    transcriptState = createEmptyTranscriptState();
    setOverlayDraft("");
    setOverlayStatus(null, ctx);
    if (persist) {
      const details: BtwResetDetails = { timestamp: Date.now(), mode };
      pi.appendEntry(BTW_RESET_TYPE, details);
    }
    syncUi(ctx);
  }

  async function restoreThread(ctx: ExtensionContext): Promise<void> {
    await disposeBtwSession();
    pendingThread = [];
    pendingMode = "contextual";
    btwModelOverride = null;
    btwThinkingOverride = null;
    btwQueue = [];
    transcriptState = createEmptyTranscriptState();
    overlayDraft = "";
    lastUiContext = ctx;
    overlayStatus = null;

    const branch = ctx.sessionManager.getBranch();
    let lastResetIndex = -1;
    let sawModelOverride = false;
    let sawThinkingOverride = false;

    for (let i = 0; i < branch.length; i++) {
      if (isCustomEntry(branch[i], BTW_MODEL_OVERRIDE_TYPE)) {
        sawModelOverride = true;
        const details = (branch[i] as unknown as { data?: BtwModelOverrideDetails }).data;
        if (details?.action === "set") {
          const resolved = ctx.modelRegistry.find(details.provider, details.id);
          if (resolved) {
            btwModelOverride = resolved;
          } else {
            // Configured override is no longer in the registry; drop it on restore.
            btwModelOverride = null;
          }
        } else if (details?.action === "clear") {
          btwModelOverride = null;
        }
      }

      if (isCustomEntry(branch[i], BTW_THINKING_OVERRIDE_TYPE)) {
        sawThinkingOverride = true;
        const details = (branch[i] as unknown as { data?: BtwThinkingOverrideDetails }).data;
        btwThinkingOverride =
          details?.action === "set"
            ? details.thinkingLevel
            : details?.action === "clear"
              ? null
              : btwThinkingOverride;
      }

      if (isCustomEntry(branch[i], BTW_RESET_TYPE)) {
        lastResetIndex = i;
        const details = (branch[i] as unknown as { data?: BtwResetDetails }).data;
        pendingMode = details?.mode ?? "contextual";
      }
    }

    // This session never set/cleared a BTW override: fall back to the persisted
    // cross-session default in pi-btw.json (mirrors the old @narumitw/pi-btw config file).
    if (!sawModelOverride || !sawThinkingOverride) {
      const config = readBtwConfig();
      if (!sawModelOverride && config.model) {
        const resolved = ctx.modelRegistry.find(config.model.provider, config.model.id);
        if (resolved) {
          btwModelOverride = resolved;
        }
      }
      if (!sawThinkingOverride && config.thinkingLevel) {
        btwThinkingOverride = config.thinkingLevel;
      }
    }

    for (const entry of branch.slice(lastResetIndex + 1)) {
      if (!isCustomEntry(entry, BTW_ENTRY_TYPE)) {
        continue;
      }

      const details = (entry as unknown as { data?: BtwDetails }).data;
      if (!details?.question || !details.answer) {
        continue;
      }

      const normalizedDetails: BtwDetails = {
        ...details,
        api: details.api || ctx.model?.api || "openai-responses",
      };

      pendingThread.push(normalizedDetails);
      appendPersistedTranscriptTurn(transcriptState, normalizedDetails);
    }

    syncUi(ctx);
  }

  async function runBtw(
    ctx: ExtensionCommandContext,
    question: string,
    saveRequested: boolean,
    mode: BtwThreadMode,
  ): Promise<void> {
    lastUiContext = ctx;
    const settings = await resolveBtwSettings(ctx);
    const model = settings.model;
    if (!model) {
      const message = settings.fallbackReason || "No active model selected.";
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      return;
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      const message = auth.ok
        ? `No credentials available for ${model.provider}/${model.id}.`
        : auth.error;
      setOverlayStatus(message, ctx);
      notify(ctx, message, "error");
      await ensureOverlay(ctx);
      return;
    }

    const sessionRuntime = await ensureBtwSession(ctx, mode);
    if (!sessionRuntime) {
      setOverlayStatus("No active model selected.", ctx);
      notify(ctx, "No active model selected.", "error");
      return;
    }

    const session = sessionRuntime.session;
    const wasBusy = !ctx.isIdle();
    pendingMode = mode;
    const thinkingLevel = settings.thinkingLevel;

    setOverlayStatus("⏳ streaming...", ctx);
    await ensureOverlay(ctx);

    try {
      await session.prompt(question, { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW request finished without a response.");
      }
      if (response.stopReason === "aborted") {
        removeTranscriptTurn(
          transcriptState,
          transcriptState.lastTurnId ?? transcriptState.currentTurnId,
        );
        setOverlayStatus("Request aborted.", ctx);
        return;
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "BTW request failed.");
      }

      const completedTurnId = transcriptState.lastTurnId ?? transcriptState.currentTurnId;
      const streamedThinking =
        completedTurnId !== null
          ? findLatestTranscriptEntry(transcriptState, completedTurnId, "thinking")?.text
          : "";
      const answer = extractAnswer(response);
      const thinking = extractThinking(response) || streamedThinking || "";

      const details: BtwDetails = {
        question,
        thinking,
        answer,
        provider: model.provider,
        model: model.id,
        api: model.api,
        thinkingLevel,
        timestamp: Date.now(),
        usage: response.usage,
      };

      if (pendingResumeCatchUp.length > 0) {
        for (const catchUpDetails of pendingResumeCatchUp) {
          pi.appendEntry(BTW_ENTRY_TYPE, catchUpDetails);
        }
        pendingResumeCatchUp = [];
      }
      pendingThread.push(details);
      pi.appendEntry(BTW_ENTRY_TYPE, details);

      const saveState = saveVisibleBtwNote(pi, details, saveRequested, wasBusy);
      if (saveState === "saved") {
        notify(ctx, "Saved BTW note to the session.", "info");
        setOverlayStatus("Saved BTW note to the session.", ctx);
      } else if (saveState === "queued") {
        notify(ctx, "BTW note queued to save after the current turn finishes.", "info");
        setOverlayStatus("BTW note queued to save after the current turn finishes.", ctx);
      } else {
        setOverlayStatus("Ready for a follow-up. Hidden BTW thread updated.", ctx);
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      setTranscriptFailure(transcriptState, errorMessage);
      setOverlayStatus("Request failed. Thread preserved for retry or follow-up.", ctx);
      notify(ctx, errorMessage, "error");
      await disposeBtwSession();
    } finally {
      syncUi(ctx);
    }
  }

  function getPendingThreadForHandoff(): BtwHandoffExchange[] {
    return pendingThread.map((entry) => ({
      user: entry.question,
      assistant: entry.answer,
    }));
  }

  async function getBtwHandoffThread(ctx: ExtensionCommandContext): Promise<{
    sessionRuntime: BtwSessionRuntime | null;
    thread: BtwHandoffExchange[];
  }> {
    const sessionRuntime = activeBtwSession ?? (await ensureBtwSession(ctx, pendingMode));
    const thread = sessionRuntime ? extractBtwHandoffThread(sessionRuntime) : [];
    const resolvedThread = thread.length > 0 ? thread : getPendingThreadForHandoff();

    if (resolvedThread.length === 0) {
      throw new Error("No BTW thread available for handoff.");
    }

    return { sessionRuntime, thread: resolvedThread };
  }

  async function summarizeThread(
    ctx: ExtensionCommandContext,
    thread: BtwHandoffExchange[],
  ): Promise<string> {
    const settings = await resolveBtwSettings(ctx, true);
    const model = settings.model;
    if (!model) {
      throw new Error(settings.fallbackReason || "No active model selected.");
    }

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) {
      throw new Error(
        auth.ok ? `No credentials available for ${model.provider}/${model.id}.` : auth.error,
      );
    }

    const { session } = await createAgentSession({
      sessionManager: SessionManager.inMemory(),
      model,
      modelRuntime: getModelRuntime(ctx),
      thinkingLevel: "off",
      tools: [],
      resourceLoader: createBtwResourceLoader(ctx, [BTW_SUMMARIZE_SYSTEM_PROMPT]),
    });

    try {
      await session.prompt(formatThread(thread), { source: "extension" });

      const response = getLastAssistantMessage(session);
      if (!response) {
        throw new Error("BTW summarize finished without a response.");
      }
      if (response.stopReason === "error") {
        throw new Error(response.errorMessage || "Failed to summarize BTW thread.");
      }
      if (response.stopReason === "aborted") {
        throw new Error("BTW summarize aborted.");
      }

      return extractAnswer(response);
    } finally {
      try {
        await session.abort();
      } catch {
        // Ignore abort errors during summarize session shutdown.
      }
      session.dispose();
    }
  }

  function sendThreadToMain(ctx: ExtensionCommandContext, content: string): void {
    if (ctx.isIdle()) {
      pi.sendUserMessage(content);
    } else {
      pi.sendUserMessage(content, { deliverAs: "followUp" });
    }
  }

  pi.registerMessageRenderer(BTW_MESSAGE_TYPE, (message, { expanded }, theme) => {
    const details = message.details as BtwDetails | undefined;
    const content =
      typeof message.content === "string" ? message.content : "[non-text btw message]";
    const lines = [theme.fg("accent", theme.bold("[BTW]")), content];

    if (expanded && details) {
      lines.push(
        theme.fg(
          "dim",
          `model: ${details.provider}/${details.model} (${details.api ?? "openai-responses"}) · thinking: ${details.thinkingLevel}`,
        ),
      );

      if (details.usage) {
        lines.push(
          theme.fg(
            "dim",
            `tokens: in ${details.usage.input} · out ${details.usage.output} · total ${details.usage.totalTokens}`,
          ),
        );
      }
    }

    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text));
    box.addChild(new Text(lines.join("\n"), 0, 0));
    return box;
  });

  pi.on("context", async (event) => {
    return {
      messages: event.messages.filter((message) => !isVisibleBtwMessage(message)),
    };
  });

  pi.on("session_start", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_tree", async (_event, ctx) => {
    await restoreThread(ctx);
  });

  pi.on("session_shutdown", async () => {
    await disposeBtwSession();
    dismissOverlay();
  });

  for (const shortcut of BTW_FOCUS_SHORTCUTS) {
    pi.registerShortcut(shortcut, {
      description: "Toggle BTW overlay focus while leaving it open.",
      handler: async (_ctx) => {
        toggleOverlayFocus();
      },
    });
  }

  pi.registerCommand("btw", {
    description: "Run a BTW side conversation or manage its current thread.",
    getArgumentCompletions: getBtwArgumentCompletions,
    handler: async (args, ctx) => {
      const command = parseBtwCommand(args);
      await dispatchBtwCommand(command.name, command.args, ctx);
    },
  });
}
