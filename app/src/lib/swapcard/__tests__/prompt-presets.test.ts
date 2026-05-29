import { describe, it, expect } from "vitest";
import {
  PROMPT_PRESETS,
  getPromptPresetById,
} from "@/lib/swapcard/prompt-presets";

describe("PROMPT_PRESETS", () => {
  it("has at least 4 presets so the row never looks empty", () => {
    expect(PROMPT_PRESETS.length).toBeGreaterThanOrEqual(4);
  });

  it("all presets have unique ids", () => {
    const ids = PROMPT_PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("every preset has non-empty label/emoji/prompt", () => {
    for (const p of PROMPT_PRESETS) {
      expect(p.id).toMatch(/^[a-z0-9-]+$/);
      expect(p.label.length).toBeGreaterThan(0);
      expect(p.emoji.length).toBeGreaterThan(0);
      expect(p.prompt.length).toBeGreaterThan(20);
    }
  });

  it("prompts are short enough to fit inside the customPrompt 4000-char cap", () => {
    for (const p of PROMPT_PRESETS) {
      expect(p.prompt.length).toBeLessThanOrEqual(4000);
    }
  });

  it("getPromptPresetById finds an existing preset", () => {
    const first = PROMPT_PRESETS[0];
    expect(getPromptPresetById(first.id)).toEqual(first);
  });

  it("getPromptPresetById returns undefined for unknown id", () => {
    expect(getPromptPresetById("__not_a_real_preset__")).toBeUndefined();
  });
});
