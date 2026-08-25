export type ModelConfig = {
  models: string[];
  selected?: string;
};

type RegisteredModel = {
  provider: string;
  id: string;
};

export function normalizeModelConfig(value: unknown): ModelConfig {
  const input = value && typeof value === "object" ? (value as Record<string, unknown>) : {};
  const models = uniqueModelRefs(Array.isArray(input.models) ? input.models : []);
  const selected =
    typeof input.selected === "string" && models.includes(input.selected)
      ? input.selected
      : undefined;

  return selected ? { models, selected } : { models };
}

export function getModelCandidates(config: ModelConfig, activeModel?: string): string[] {
  return uniqueModelRefs([config.selected, ...config.models, activeModel]);
}

export function getRegisteredModelRefs(models: RegisteredModel[]): string[] {
  return uniqueModelRefs(models.map(({ provider, id }) => `${provider}/${id}`));
}

export function filterRegisteredModelRefs(query: string, registeredRefs: string[]): string[] {
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return registeredRefs;
  return registeredRefs.filter((ref) => ref.toLowerCase().includes(normalizedQuery));
}

export function getModelCompletionValues(prefix: string, registeredRefs: string[]): string[] {
  const value = prefix.trimStart();
  if (!value || (!value.includes(" ") && "model".startsWith(value.toLowerCase()))) {
    return ["model"];
  }
  if (!/^model\s+/i.test(value)) return [];

  const query = value.slice("model".length).trim().toLowerCase();
  return registeredRefs
    .filter((ref) => ref.toLowerCase().startsWith(query))
    .map((ref) => `model ${ref}`);
}

export function parseModelRef(value: string): { provider: string; id: string } | undefined {
  const separator = value.indexOf("/");
  if (separator <= 0 || separator === value.length - 1) return undefined;

  const provider = value.slice(0, separator).trim();
  const id = value.slice(separator + 1).trim();
  return provider && id ? { provider, id } : undefined;
}

function uniqueModelRefs(values: unknown[]): string[] {
  return [
    ...new Set(
      values
        .filter((value): value is string => typeof value === "string")
        .map((value) => value.trim())
        .filter((value) => Boolean(parseModelRef(value))),
    ),
  ];
}
