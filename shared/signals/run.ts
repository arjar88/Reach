import { runSignalPipeline, type AgentFilter, type CommitWrite, type EngagerInput, type PipelineResult, type SignalRead } from "./pipeline.js";
import type { ScrapePlan } from "./fetch.js";

export interface WatchedRun extends PipelineResult {
  persisted: boolean;
  scrape: ScrapePlan | null;
}

/**
 * Preview fetches and scores in memory. It does not call `persist`.
 * Commit hands the caller one write object; the cursor moves only after the contact upserts.
 */
export async function runWatchedSignal(opts: {
  mode: "preview" | "commit";
  orgId: string;
  signalId: string;
  signalKey: string;
  signalType: string;
  agent: AgentFilter;
  engagers: EngagerInput[];
  scrape?: ScrapePlan | null;
  now: Date;
  read: SignalRead;
  prescore: (people: { id: string; name: string; headline: string }[]) => Promise<{ id: string; keep: boolean }[]>;
  score: (ids: string[]) => Promise<string>;
  cap?: { scoredThisMonth: number; limit: number };
  persist?: (write: CommitWrite, scrape: ScrapePlan | null) => Promise<void>;
}): Promise<WatchedRun> {
  const result = await runSignalPipeline(opts);
  const scrape = opts.scrape ?? null;
  if (opts.mode === "preview" || !result.write || !opts.persist) {
    return { ...result, persisted: false, scrape };
  }
  await opts.persist(result.write, scrape);
  return { ...result, persisted: true, scrape };
}
