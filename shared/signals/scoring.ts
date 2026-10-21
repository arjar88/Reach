import type { ZodType } from "zod";
import { scoreSchema, type ScoreOutput } from "../prompts/schemas.js";
import { config } from "../config.js";

export class ModelOutputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ModelOutputError";
  }
}

export function parseModelJson<T>(raw: string, schema: ZodType<T>): T {
  const start = raw.indexOf("{");
  const end = raw.lastIndexOf("}");
  if (start < 0 || end < start) throw new ModelOutputError("No JSON object");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.slice(start, end + 1));
  } catch {
    throw new ModelOutputError("Invalid JSON");
  }
  const result = schema.safeParse(parsed);
  if (!result.success) throw new ModelOutputError(result.error.message);
  return result.data;
}

export async function withOneRetry<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (!(error instanceof ModelOutputError)) throw error;
    return run();
  }
}

export interface ScorePerson {
  id: string;
}

export interface ResolvedScores {
  scored: Map<string, { score: number; reason: string }>;
  unscored: string[];
  ignoredUnknown: string[];
}

export async function resolveScores(
  people: ScorePerson[],
  ask: (ids: string[]) => Promise<string>,
): Promise<ResolvedScores> {
  const wanted = new Set(people.map((p) => p.id));
  const ignoredUnknown: string[] = [];
  const scored = new Map<string, { score: number; reason: string }>();

  const consume = (output: ScoreOutput, expected: Set<string>) => {
    for (const row of output.results) {
      if (!expected.has(row.id)) {
        ignoredUnknown.push(row.id);
        continue;
      }
      scored.set(row.id, { score: row.score, reason: row.reason });
    }
  };

  const firstIds = people.map((p) => p.id);
  const first = await withOneRetry(async () => parseModelJson(await ask(firstIds), scoreSchema));
  consume(first, wanted);

  let missing = firstIds.filter((id) => !scored.has(id));
  if (missing.length > 0) {
    const batch = missing.slice(0, config.scoring.retryBatchSize);
    const expected = new Set(batch);
    const second = await withOneRetry(async () => parseModelJson(await ask(batch), scoreSchema));
    consume(second, expected);
    missing = firstIds.filter((id) => !scored.has(id));
  }
  return { scored, unscored: missing, ignoredUnknown };
}
