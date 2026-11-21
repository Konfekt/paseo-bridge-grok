import { expect, test, vi } from "vitest";
import { TitleSync } from "../src/title-sync.js";

test("applies only the last title per agent and skips repeats", async () => {
  vi.useFakeTimers();
  try {
    const applied: Record<string, string>[] = [];
    const sync = new TitleSync(async (titles) => {
      applied.push(Object.fromEntries(titles));
    }, 100);
    sync.update("a", "first");
    sync.update("a", "second");
    sync.update("b", "other");
    await vi.advanceTimersByTimeAsync(150);
    sync.update("a", "second");
    await vi.advanceTimersByTimeAsync(150);
    expect(applied).toEqual([{ a: "second", b: "other" }]);
    await sync.stop();
  } finally {
    vi.useRealTimers();
  }
});

test("reports failures and retries a title later", async () => {
  vi.useFakeTimers();
  try {
    const errors: unknown[] = [];
    let fail = true;
    const applied: string[] = [];
    const sync = new TitleSync(
      async (titles) => {
        if (fail) throw new Error("offline");
        applied.push(...titles.values());
      },
      10,
      (error) => errors.push(error),
    );
    sync.update("a", "t");
    await vi.advanceTimersByTimeAsync(20);
    fail = false;
    sync.update("a", "t");
    await vi.advanceTimersByTimeAsync(20);
    expect(errors).toHaveLength(1);
    expect(applied).toEqual(["t"]);
    await sync.stop();
  } finally {
    vi.useRealTimers();
  }
});
