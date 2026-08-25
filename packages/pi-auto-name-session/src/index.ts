import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import {
  CONFIG_DIR_NAME,
  type ExtensionAPI,
  type ExtensionContext,
  getSettingsListTheme,
  ModelSelectorComponent,
} from "@earendil-works/pi-coding-agent";
import {
  type Component,
  Container,
  type SettingItem,
  SettingsList,
  Spacer,
  Text,
  type TUI,
} from "@earendil-works/pi-tui";
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
        // ModelSelectorComponent refreshes catalogs in the background. Do not
        // block the command on a second, serial catalog refresh here.
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
        await openAutoNameSettings(ctx, () => token === sessionToken);
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

function createSettingsBorder(theme: { fg(color: string, text: string): string }): Component {
  return {
    render: (width: number) => [theme.fg("border", "─".repeat(Math.max(1, width)))],
    invalidate: () => {},
  };
}

async function openAutoNameSettings(
  ctx: ExtensionContext,
  isCurrent: () => boolean,
): Promise<void> {
  const config = await loadModelConfig();
  if (!isCurrent()) return;
  if (!ctx.hasUI) {
    ctx.ui.notify(`Auto-name model: ${config.selected ?? "session model"}`, "info");
    return;
  }

  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    let current = config;
    let settingsList: SettingsList;
    const items: SettingItem[] = [
      {
        id: "model",
        label: "Model",
        description: "Model used to generate session titles",
        currentValue: current.selected ?? "session model",
        submenu: (
          _currentValue: string,
          submenuDone: (selectedValue?: string) => void,
        ): Component => createAutoNameModelSelector(ctx, tui, submenuDone),
      },
    ];

    settingsList = new SettingsList(
      items,
      10,
      getSettingsListTheme(),
      (id: string, newValue: string) => {
        if (id !== "model") return;
        current = normalizeModelConfig({
          models: [newValue, ...current.models],
          selected: newValue,
        });
        settingsList.updateValue("model", newValue);
        void saveModelConfig(current)
          .then(() => {
            if (isCurrent()) {
              ctx.ui.notify(`Auto-name model: ${newValue}`, "info");
            }
          })
          .catch((error) => {
            console.error("[pi-auto-name-session] Failed to save model config:", error);
            if (isCurrent()) {
              ctx.ui.notify("Could not save auto-name model configuration", "error");
            }
          });
      },
      () => done(),
    );

    const container = new Container();
    container.addChild(createSettingsBorder(theme));
    container.addChild(new Text(theme.fg("accent", theme.bold("Auto-name")), 1, 1));
    container.addChild(new Text(theme.fg("dim", "Configure automatic session naming."), 1, 1));
    container.addChild(new Spacer(1));
    container.addChild(settingsList);
    container.addChild(createSettingsBorder(theme));

    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: (data: string) => {
        settingsList.handleInput(data);
        tui.requestRender();
      },
    };
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
    selected = (await selectAutoNameModel(ctx)) ?? "";
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

function createAutoNameModelSelector(
  ctx: ExtensionContext,
  tui: TUI,
  done: (selectedValue?: string) => void,
): Component {
  const modelRuntime = {
    getAvailableSnapshot: () => {
      const available = ctx.modelRegistry.getAvailable();
      return available.length > 0 ? available : ctx.modelRegistry.getAll();
    },
    getModel: (provider: string, id: string) => ctx.modelRegistry.find(provider, id),
    getError: () => ctx.modelRegistry.getError(),
    // Auto-name configuration should not block on provider discovery. The
    // selector already has the registry snapshot; /model remains the place
    // for an explicit catalog refresh.
    refresh: async () => ({ aborted: false, errors: new Map<string, Error>() }),
  };

  return new ModelSelectorComponent(
    tui,
    ctx.model,
    { setDefaultModelAndProvider: () => {} } as never,
    modelRuntime as never,
    [],
    (model) => done(`${model.provider}/${model.id}`),
    () => done(undefined),
  );
}

async function selectAutoNameModel(ctx: ExtensionContext): Promise<string | undefined> {
  return ctx.ui.custom((tui, _theme, _keybindings, done) =>
    createAutoNameModelSelector(ctx, tui, done),
  );
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
