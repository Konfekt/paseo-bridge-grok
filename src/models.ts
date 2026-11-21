import type { ProviderCatalog, ProviderModel } from "@getpaseo/plugin/server/provider";
import { z } from "zod";

/** Grok Build reports its models in `initialize._meta.modelState` and per session. */
const EffortSchema = z
  .object({
    id: z.string().optional(),
    value: z.string().optional(),
    label: z.string().optional(),
    description: z.string().optional(),
    default: z.boolean().optional(),
  })
  .loose();

const ModelSchema = z
  .object({
    modelId: z.string().min(1),
    name: z.string().optional(),
    description: z.string().nullish(),
    _meta: z
      .object({
        totalContextTokens: z.number().optional(),
        supportsReasoningEffort: z.boolean().optional(),
        reasoningEffort: z.string().nullish(),
        reasoningEfforts: z.array(EffortSchema).optional(),
      })
      .loose()
      .nullish(),
  })
  .loose();

export const ModelStateSchema = z
  .object({
    currentModelId: z.string().nullish(),
    availableModels: z.array(ModelSchema),
  })
  .loose();

export type ModelState = z.infer<typeof ModelStateSchema>;
type GrokModel = ModelState["availableModels"][number];

/** Read a model state, tolerating unknown fields and skipping malformed models. */
export function readModelState(value: unknown): ModelState | null {
  if (!value || typeof value !== "object") return null;
  const raw = value as { currentModelId?: unknown; availableModels?: unknown };
  if (!Array.isArray(raw.availableModels)) return null;
  const availableModels = raw.availableModels.flatMap((model) => {
    const parsed = ModelSchema.safeParse(model);
    return parsed.success ? [parsed.data] : [];
  });
  if (!availableModels.length) return null;
  const current = typeof raw.currentModelId === "string" ? raw.currentModelId : null;
  return { currentModelId: current, availableModels };
}

function efforts(model: GrokModel) {
  if (model._meta?.supportsReasoningEffort === false) return [];
  return (model._meta?.reasoningEfforts ?? []).flatMap((effort) => {
    const id = effort.value ?? effort.id;
    return id ? [{ ...effort, id }] : [];
  });
}

function defaultEffort(model: GrokModel): string | undefined {
  const options = efforts(model);
  return (
    options.find((effort) => effort.default)?.id ??
    (model._meta?.reasoningEffort && options.some((e) => e.id === model._meta?.reasoningEffort)
      ? model._meta.reasoningEffort
      : undefined) ??
    options[0]?.id
  );
}

function currentModel(state: ModelState): GrokModel {
  const found = state.availableModels.find((model) => model.modelId === state.currentModelId);
  return found ?? (state.availableModels[0] as GrokModel);
}

/**
 * ACP session config options equivalent to a live Grok session's, for a catalog request.
 * Answering catalog requests from `initialize` avoids creating a throwaway Grok session,
 * which would otherwise appear in Grok's own session store.
 */
export function catalogConfigOptions(state: ModelState): Record<string, unknown>[] {
  const current = currentModel(state);
  const options: Record<string, unknown>[] = [
    {
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: current.modelId,
      options: state.availableModels.map((model) => ({
        value: model.modelId,
        name: model.name || model.modelId,
        ...(model.description ? { description: model.description } : {}),
      })),
    },
  ];
  const currentEfforts = efforts(current);
  const effort = defaultEffort(current);
  if (currentEfforts.length && effort)
    options.push({
      id: "reasoning_effort",
      name: "Reasoning Effort",
      category: "thought_level",
      type: "select",
      currentValue: effort,
      options: currentEfforts.map((option) => ({
        value: option.id,
        name: option.label || option.id,
        ...(option.description ? { description: option.description } : {}),
      })),
    });
  return options;
}

/**
 * Paseo's generic ACP catalog names models only. Add what Grok reports per model: its
 * reasoning efforts and default, context window, description and Grok's default model.
 * A catalog that would otherwise be empty is rebuilt from the model state, so the app's
 * model picker always has Grok's models.
 */
export function enrichCatalog(catalog: ProviderCatalog, state: ModelState | null): ProviderCatalog {
  if (!state) return catalog;
  const byId = new Map(state.availableModels.map((model) => [model.modelId, model]));
  const listed: ProviderModel[] = catalog.models.length
    ? [...catalog.models]
    : state.availableModels.map((model) => ({
        id: model.modelId,
        label: model.name || model.modelId,
      }));
  const defaultModel = catalog.defaultModel ?? currentModel(state).modelId;
  const models = listed.map((model): ProviderModel => {
    const grok = byId.get(model.id);
    if (!grok) return model;
    const thinkingOptions = efforts(grok).map((effort) => ({
      id: effort.id,
      label: effort.label || effort.id,
      ...(effort.description ? { description: effort.description } : {}),
      ...(effort.default ? { isDefault: true } : {}),
    }));
    const defaultThinking = defaultEffort(grok);
    return {
      ...model,
      ...(grok.description && !model.description ? { description: grok.description } : {}),
      ...(model.id === defaultModel ? { isDefault: true } : {}),
      ...(grok._meta?.totalContextTokens
        ? { contextWindowMaxTokens: grok._meta.totalContextTokens }
        : {}),
      ...(thinkingOptions.length ? { thinkingOptions } : {}),
      ...(defaultThinking && thinkingOptions.length
        ? { defaultThinkingOptionId: defaultThinking }
        : {}),
    };
  });
  return { ...catalog, models, defaultModel };
}
