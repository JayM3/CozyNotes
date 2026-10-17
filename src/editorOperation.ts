export type EditorOperation = { operationId: string; kind: "trash" | "exit" };
export type EditorOperationFinish = { operationId: string; outcome: "cancelled" | "committed" };

type Options = {
  isActive: (operationId: string) => Promise<boolean>;
  waitForIdle: () => Promise<void>;
  waitForComposition: () => Promise<void>;
  setLocked: (locked: boolean) => void;
  flush: () => Promise<void>;
  acknowledge: (operationId: string, success: boolean) => Promise<void>;
  onCommitted: () => void;
  onError: (message: string) => void;
};

/** Hold a draft still between its final save and a native trash/exit decision. */
export class EditorOperationCoordinator {
  private current: EditorOperation | null = null;
  private pendingFinish: EditorOperationFinish | null = null;
  private retired = false;
  private savedForOperation = false;
  private disposed = false;

  constructor(private readonly options: Options) {}

  get busy() { return this.current !== null || this.retired; }
  get canClose() { return this.retired && this.current === null; }

  async prepare(operation: EditorOperation) {
    if (this.current || this.disposed || !operation || typeof operation.operationId !== "string" || !operation.operationId
      || (operation.kind !== "trash" && operation.kind !== "exit")) return;
    this.current = operation;
    this.pendingFinish = null;
    this.savedForOperation = false;
    let active: boolean;
    try { active = await this.options.isActive(operation.operationId); }
    catch {
      if (this.current === operation) {
        this.options.onError("Couldn't verify the save request. Your draft remains open.");
        await this.options.acknowledge(operation.operationId, false).catch(() => undefined);
      }
      return;
    }
    if (this.current !== operation) return;
    if (!active) { this.current = null; return; }
    try {
      if (this.retired) {
        this.savedForOperation = true;
        await this.options.acknowledge(operation.operationId, true);
        return;
      }
      await this.options.waitForIdle();
      if (this.current !== operation) return;
      await this.options.waitForComposition();
      if (this.current !== operation) return;
      this.options.setLocked(true);
      await this.options.flush();
      if (this.current !== operation) return;
      this.savedForOperation = true;
      await this.options.acknowledge(operation.operationId, true);
    } catch {
      if (this.current !== operation) return;
      this.options.onError("Couldn't save the draft. It remains open for recovery.");
      // A lost reply must not unlock a draft while native code may still commit.
      await this.options.acknowledge(operation.operationId, false).catch(() => undefined);
    }
  }

  async finish(result: EditorOperationFinish) {
    if (!result || typeof result.operationId !== "string" || !result.operationId
      || (result.outcome !== "cancelled" && result.outcome !== "committed")) return;
    const current = this.current;
    if (current?.operationId !== result.operationId || this.pendingFinish?.outcome === "committed" && result.outcome !== "committed") return;
    this.pendingFinish = result;
    try {
      if (await this.options.isActive(result.operationId) || this.current !== current || this.pendingFinish !== result) return;
    } catch {
      if (this.current === current && this.pendingFinish === result) {
        this.options.onError("Couldn't check whether the operation finished. Your draft is protected. Choose Retry to check again.");
      }
      return;
    }
    if (result.outcome === "committed") {
      if (!this.savedForOperation) {
        this.options.onError("Couldn't confirm this draft was saved. It remains open for recovery.");
        return;
      }
      this.retired = true;
      this.current = null;
      this.pendingFinish = null;
      this.options.onCommitted();
      return;
    }
    this.current = null;
    this.pendingFinish = null;
    if (!this.retired) this.options.setLocked(false);
  }

  async retryFinish() {
    if (this.pendingFinish) await this.finish(this.pendingFinish);
    return !this.busy;
  }

  dispose() {
    this.disposed = true;
    this.current = null;
    this.pendingFinish = null;
    this.retired = false;
    this.savedForOperation = false;
  }
}
