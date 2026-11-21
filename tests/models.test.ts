import { expect, test } from "vitest";
import { catalogConfigOptions, enrichCatalog, readModelState } from "../src/models.js";

const raw = {
  currentModelId: "grok-b",
  availableModels: [
    { modelId: "grok-a", name: "Grok A", description: "fast", _meta: { totalContextTokens: 1000 } },
    {
      modelId: "grok-b",
      name: "Grok B",
      _meta: {
        supportsReasoningEffort: true,
        reasoningEffort: "medium",
        reasoningEfforts: [{ value: "low", label: "Low" }, { value: "medium" }],
      },
    },
    { name: "malformed" },
  ],
  extra: true,
};

test("reads Grok's model state tolerantly", () => {
  const state = readModelState(raw);
  expect(state?.availableModels.map((model) => model.modelId)).toEqual(["grok-a", "grok-b"]);
  expect(readModelState({ availableModels: [] })).toBeNull();
  expect(readModelState("x")).toBeNull();
});

test("synthesizes ACP config options with the current model's reasoning effort", () => {
  const state = readModelState(raw);
  if (!state) throw new Error("no state");
  const options = catalogConfigOptions(state);
  expect(options).toMatchObject([
    { id: "model", currentValue: "grok-b" },
    { id: "reasoning_effort", category: "thought_level", currentValue: "medium" },
  ]);
  const withoutEffort = catalogConfigOptions({ ...state, currentModelId: "grok-a" });
  expect(withoutEffort.map((option) => option["id"])).toEqual(["model"]);
});

test("enriches or rebuilds Paseo's catalog from the model state", () => {
  const state = readModelState(raw);
  const rebuilt = enrichCatalog({ models: [], modes: [] } as never, state);
  expect(rebuilt.defaultModel).toBe("grok-b");
  const a = rebuilt.models.find((model) => model.id === "grok-a");
  const b = rebuilt.models.find((model) => model.id === "grok-b");
  expect(a).toMatchObject({ label: "Grok A", description: "fast", contextWindowMaxTokens: 1000 });
  expect(b?.thinkingOptions?.map((option) => option.id)).toEqual(["low", "medium"]);
  expect(b?.defaultThinkingOptionId).toBe("medium");
  const untouched = { models: [{ id: "x", label: "X" }], modes: [] } as never;
  expect(enrichCatalog(untouched, null)).toBe(untouched);
});
