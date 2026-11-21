import { errorMessage } from "./errors.js";

const DEFAULT_DELAY_MS = 1_500;

/**
 * Coalesces Grok's title changes per agent: Grok replays earlier titles when a session loads
 * and regenerates a new session's title a few times, so only the last title within a short
 * window is applied.
 */
export class TitleSync {
  private readonly pending = new Map<string, string>();
  private readonly applied = new Map<string, string>();
  private timer: NodeJS.Timeout | undefined;
  private flushing: Promise<void> = Promise.resolve();
  private stopped = false;

  constructor(
    private readonly apply: (titles: ReadonlyMap<string, string>) => Promise<void>,
    private readonly delayMs = DEFAULT_DELAY_MS,
    private readonly onError: (error: unknown) => void = (error) =>
      console.error("Grok title synchronization failed:", errorMessage(error)),
  ) {}

  update = (agentId: string, title: string): void => {
    if (this.stopped || this.applied.get(agentId) === title) {
      this.pending.delete(agentId);
      return;
    }
    this.pending.set(agentId, title);
    if (!this.timer) {
      this.timer = setTimeout(() => {
        this.timer = undefined;
        this.flushing = this.flushing.then(() => this.flush());
      }, this.delayMs);
      this.timer.unref?.();
    }
  };

  private async flush(): Promise<void> {
    if (!this.pending.size || this.stopped) return;
    const batch = new Map(this.pending);
    this.pending.clear();
    try {
      await this.apply(batch);
      for (const [agentId, title] of batch) this.applied.set(agentId, title);
    } catch (error) {
      this.onError(error);
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    await this.flushing;
  }
}
