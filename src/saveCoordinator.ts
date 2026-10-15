export type SaveStatus = "saved" | "saving" | "error";

type SaveOptions<Document, Snapshot extends { revision: number }> = {
  revision: number;
  save: (document: Document, expectedRevision: number) => Promise<Snapshot>;
  onSaved: (snapshot: Snapshot) => void;
  onStatus: (status: SaveStatus, error?: unknown) => void;
};

export class SaveCoordinator<Document, Snapshot extends { revision: number }> {
  private revision: number;
  private generation = 0;
  private acknowledged = 0;
  private document: Document | undefined;
  private firstDirtyAt: number | null = null;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private inFlight: Promise<void> | null = null;
  private failed = false;
  private disposed = false;
  private composing = false;
  private compositionWaiters: Array<() => void> = [];

  constructor(private readonly options: SaveOptions<Document, Snapshot>) {
    this.revision = options.revision;
  }

  get dirty() { return this.generation > this.acknowledged; }

  markDirty(document: Document) {
    if (this.disposed) return;
    this.document = document;
    this.generation++;
    this.firstDirtyAt ??= Date.now();
    this.failed = false;
    this.options.onStatus("saving");
    this.schedule();
  }

  setComposing(composing: boolean) {
    this.composing = composing;
    if (composing) this.clearTimer();
    else {
      this.compositionWaiters.splice(0).forEach(resolve => resolve());
      this.schedule();
    }
  }

  waitUntilCompositionEnds(): Promise<void> {
    return this.composing
      ? new Promise(resolve => this.compositionWaiters.push(resolve))
      : Promise.resolve();
  }

  async flush() {
    this.clearTimer();
    await this.waitUntilCompositionEnds();
    if (this.disposed) return;
    this.failed = false;
    // All callers share the in-flight request and drain the newest generation.
    while (this.dirty || this.inFlight) {
      this.clearTimer();
      await this.waitUntilCompositionEnds();
      if (this.disposed) return;
      if (this.inFlight) await this.inFlight;
      else await this.startSave();
      if (this.disposed) return;
    }
  }

  dispose() {
    this.disposed = true;
    this.clearTimer();
    this.compositionWaiters.splice(0).forEach(resolve => resolve());
  }

  private clearTimer() {
    if (this.timer !== undefined) clearTimeout(this.timer);
    this.timer = undefined;
  }

  private schedule() {
    this.clearTimer();
    if (this.disposed || this.composing || this.inFlight || this.failed || !this.dirty) return;
    const delay = Math.max(0, Math.min(300, (this.firstDirtyAt ?? Date.now()) + 2000 - Date.now()));
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.startSave().catch(() => undefined);
    }, delay);
  }

  private startSave(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (this.disposed || this.composing || !this.dirty || this.document === undefined) return Promise.resolve();
    const generation = this.generation;
    const document = this.document;
    this.firstDirtyAt = null;
    this.options.onStatus("saving");
    this.inFlight = Promise.resolve().then(async () => {
      try {
        const snapshot = await this.options.save(document, this.revision);
        this.revision = snapshot.revision;
        this.acknowledged = generation;
        this.failed = false;
        if (!this.disposed) {
          this.options.onSaved(snapshot);
          this.options.onStatus(this.dirty ? "saving" : "saved");
        }
      } catch (error) {
        this.failed = true;
        if (!this.disposed) this.options.onStatus("error", error);
        throw error;
      } finally {
        this.inFlight = null;
        this.schedule();
      }
    });
    return this.inFlight;
  }
}
