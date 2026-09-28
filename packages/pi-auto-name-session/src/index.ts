import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  DynamicBorder,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Container, type SelectItem, SelectList, Text } from "@earendil-works/pi-tui";
import {
  getModelCandidates,
  getModelCompletionValues,
  getRegisteredModelRefs,
  type ModelConfig,
  normalizeModelConfig,
  parseModelRef,
} from "./model";
import {
  extractUserText,
  getRecentUserPrompt,
  sanitizeSessionName,
  shouldArmAutoNaming,
} from "./title";

const CONFIG_PATH = join(homedir(), CONFIG_DIR_NAME, "agent", "pi-auto-name-session.json");

const COMMAND_ARGUMENTS = [
  {
    value: "model",
    label: "model",
    description: "Choose the model used to generate session titles",
  },
  {
    value: "now",
    label: "now",
    description: "Rename from recent user messages",
  },
  {
    value: "config",
    label: "config",
    description: "Open the auto-name settings",
  },
  {
    value: "settings",
    label: "settings",
    description: "Alias for the config settings",
  },
] as const;
const USAGE_TEXT = "Usage: /auto-name [now | model [provider/model] | config | settings]";

const SYSTEM_PROMPT = `You create searchable session titles for coding and technical work.
The user uses these titles later to find old sessions, so prefer memorable, specific words over generic summaries.
Return exactly one title based only on the user's messages.

Rules:
- Prefer 2 to 6 words
- Use Title Case
- Include the task, feature, bug, file, package, command, model, or error when clear
- Avoid generic titles like Coding Help, Fix Bug, Update Code, or New Session
- If the message is vague, conversational, or lacks a clear task, return a funny but compact coding-themed title
- Funny fallback titles should be memorable, not random; examples: Mystery Bug Goblin, Keyboard Goblin Hour, Undefined Behavior Club
- No quotes
- No markdown
- No labels like Title:
- No trailing punctuation
- Maximum 60 characters`;

function getArgumentCompletions(
  argumentPrefix: string,
  registeredModelRefs: string[],
): Array<{ value: string; label: string; description: string }> | null {
  const normalized = argumentPrefix.trim().toLowerCase();
  if (normalized.includes(" ")) {
    if (!normalized.startsWith("model ")) return null;
    const values = getModelCompletionValues(argumentPrefix, registeredModelRefs);
    return values.length > 0
      ? values.map((value) => ({
          value,
          label: value,
          description: "Select a registered model",
        }))
      : null;
  }

  const filtered = COMMAND_ARGUMENTS.filter((item) => item.value.startsWith(normalized));
  return filtered.length > 0 ? [...filtered] : null;
}

export default function piAutoNameSessionExtension(pi: ExtensionAPI): void {
  let sessionToken = 0;
  let armed = false;
  let pending = false;
  let registeredModelRefs: string[] = [];

  const renameSessionNow = async (ctx: ExtensionContext): Promise<void> => {
    if (pending) {
      ctx.ui.notify("Auto-naming is already in progress", "info");
      return;
    }

    const prompt = getRecentUserPrompt(ctx.sessionManager.getBranch());
    if (!prompt) {
      ctx.ui.notify("No user messages available to name this session", "info");
      return;
    }

    pending = true;
    sessionToken += 1;
    const token = sessionToken;
    ctx.ui.notify("Auto-naming session…", "info");
    try {
      const name = await generateSessionName(prompt, ctx);
      if (name && token === sessionToken) {
        pi.setSessionName(name);
        ctx.ui.notify(`Session named: ${name}`, "info");
      }
    } catch (error: unknown) {
      console.error("[pi-auto-name-session] Failed to generate session name:", error);
    } finally {
      if (token === sessionToken) pending = false;
    }
  };

  pi.registerCommand("auto-name", {
    description:
      "Configure automatic session naming (usage: /auto-name [now|model|config|settings])",
    getArgumentCompletions: (prefix) => getArgumentCompletions(prefix, registeredModelRefs),
    handler: async (args, ctx) => {
      const [subcommand, ...rest] = args.trim().split(/\s+/).filter(Boolean);
      if (subcommand === "now") {
        await renameSessionNow(ctx);
        return;
      }
      if (subcommand === "model") {
        // Prefer available models, but retain registered models without auth.
        const available = ctx.modelRegistry.getAvailable();
        registeredModelRefs = getRegisteredModelRefs(
          available.length > 0 ? available : ctx.modelRegistry.getAll(),
        );
        const token = sessionToken;
        await configureAutoNameModel(
          ctx,
          registeredModelRefs,
          rest.join(" ").trim(),
          () => token === sessionToken,
        );
        return;
      }
      if (!subcommand || subcommand === "config" || subcommand === "settings") {
        const token = sessionToken;
        await configureAutoNameModel(ctx, registeredModelRefs, "", () => token === sessionToken);
        return;
      }
      ctx.ui.notify(USAGE_TEXT, "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    registeredModelRefs = getRegisteredModelRefs(ctx.modelRegistry.getAll());
    sessionToken += 1;
    armed = shouldArmAutoNaming(
      ctx.sessionManager.getBranch() as Parameters<typeof shouldArmAutoNaming>[0],
      pi.getSessionName(),
    );
    pending = false;
  });

  pi.on("session_shutdown", async () => {
    sessionToken += 1;
    armed = false;
    pending = false;
  });

  pi.on("before_agent_start", async (event) => {
    const name = pi.getSessionName();
    if (!name) return;
    return {
      systemPrompt: `${event.systemPrompt}\n\nCurrent session name: ${name}`,
    };
  });

  pi.on("message_end", async (event, ctx) => {
    if (!armed || pending || pi.getSessionName()) return;
    if (event.message.role !== "user") return;

    const prompt = extractUserText(event.message.content);
    armed = false;
    if (!prompt) return;

    pending = true;
    const token = sessionToken;
    const hasUI = ctx.hasUI;
    if (hasUI) ctx.ui.notify("Auto-naming session…", "info");

    generateSessionName(prompt, ctx)
      .then((name) => {
        if (!name || token !== sessionToken || pi.getSessionName()) return;
        pi.setSessionName(name);
        if (hasUI) ctx.ui.notify(`Session named: ${name}`, "info");
      })
      .catch((error: unknown) => {
        console.error("[pi-auto-name-session] Failed to generate session name:", error);
      })
      .finally(() => {
        if (token === sessionToken) pending = false;
      });
  });
}

async function configureAutoNameModel(
  ctx: ExtensionContext,
  registeredModelRefs: string[],
  initialSelected = "",
  isCurrent: () => boolean = () => true,
): Promise<void> {
  if (registeredModelRefs.length === 0) {
    ctx.ui.notify("No models are registered in Pi", "error");
    return;
  }

  const config = await loadModelConfig();
  if (!isCurrent()) return;
  let selected = initialSelected;
  if (!selected) {
    if (!ctx.hasUI) {
      ctx.ui.notify(`Selected auto-name model: ${config.selected ?? "session model"}`, "info");
      return;
    }
    selected = (await selectAutoNameModel(ctx, registeredModelRefs)) ?? "";
    if (!isCurrent() || !selected) return;
  }

  const parsed = parseModelRef(selected);
  if (!parsed) {
    ctx.ui.notify(`Invalid model reference: ${selected}`, "error");
    return;
  }
  if (!registeredModelRefs.includes(selected)) {
    ctx.ui.notify(`Model is not registered in Pi: ${selected}`, "error");
    return;
  }

  try {
    await saveModelConfig(
      normalizeModelConfig({
        models: [selected, ...config.models],
        selected,
      }),
    );
  } catch (error) {
    console.error("[pi-auto-name-session] Failed to save model config:", error);
    if (isCurrent()) {
      ctx.ui.notify("Could not save auto-name model configuration", "error");
    }
    return;
  }
  if (isCurrent()) ctx.ui.notify(`Auto-name model: ${selected}`, "info");
}

async function selectAutoNameModel(
  ctx: ExtensionContext,
  registeredModelRefs: string[],
): Promise<string | undefined> {
  const items: SelectItem[] = registeredModelRefs.map((value) => ({ value, label: value }));
  const selected = await ctx.ui.custom<string | null>((tui, theme, _keybindings, done) => {
    const container = new Container();
    const border = () => new DynamicBorder((text: string) => theme.fg("accent", text));
    const list = new SelectList(items, Math.min(items.length, 10), {
      selectedPrefix: (text) => theme.fg("accent", text),
      selectedText: (text) => theme.fg("accent", text),
      description: (text) => theme.fg("muted", text),
      scrollInfo: (text) => theme.fg("dim", text),
      noMatch: (text) => theme.fg("warning", text),
    });

    list.onSelect = (item) => done(item.value);
    list.onCancel = () => done(null);
    container.addChild(border());
    container.addChild(new Text(theme.fg("accent", theme.bold("Auto-name model")), 1, 0));
    container.addChild(list);
    container.addChild(new Text(theme.fg("dim", "↑↓ navigate · enter select · esc cancel"), 1, 0));
    container.addChild(border());

    return {
      render: (width) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data) => {
        list.handleInput(data);
        tui.requestRender();
      },
    };
  });

  return selected ?? undefined;
}

async function loadModelConfig(): Promise<ModelConfig> {
  try {
    return normalizeModelConfig(JSON.parse(await readFile(CONFIG_PATH, "utf8")));
  } catch {
    return normalizeModelConfig(undefined);
  }
}

async function saveModelConfig(config: ModelConfig): Promise<void> {
  await mkdir(dirname(CONFIG_PATH), { recursive: true });
  await writeFile(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function generateSessionName(
  prompt: string,
  ctx: ExtensionContext,
): Promise<string | undefined> {
  const config = await loadModelConfig();
  const activeModel = ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined;
  for (const ref of getModelCandidates(config, activeModel)) {
    const parsed = parseModelRef(ref);
    if (!parsed) continue;

    const model = ctx.modelRegistry.find(parsed.provider, parsed.id);
    if (!model) continue;

    const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
    if (!auth.ok || !auth.apiKey) continue;

    const response = await ctx.modelRegistry.complete(
      model,
      {
        systemPrompt: SYSTEM_PROMPT,
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        apiKey: auth.apiKey,
        headers: auth.headers,
        maxTokens: 32000,
        signal: ctx.signal,
      },
    );

    const text = response.content
      .filter((part): part is { type: "text"; text: string } => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim();

    return sanitizeSessionName(text);
  }

  console.warn("[pi-auto-name-session] No configured model is available or authenticated");
  return undefined;
}
