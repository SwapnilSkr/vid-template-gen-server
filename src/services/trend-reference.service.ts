import {
  TrendReference,
  type ITrendMetrics,
  type ITrendReference,
  type TrendPlatform,
  type TrendReferenceStatus,
} from "../models/trend-reference.model";

export interface CreateTrendReferenceInput {
  niche: string;
  genre?: string;
  sourceUrl: string;
  platform: TrendPlatform;
  metrics?: ITrendMetrics;
  notes?: string;
  status?: TrendReferenceStatus;
}

export interface ListTrendReferencesInput {
  niche?: string;
  genre?: string;
  platform?: TrendPlatform;
  status?: TrendReferenceStatus;
  limit?: number;
  skip?: number;
}

export async function createTrendReference(
  input: CreateTrendReferenceInput
): Promise<ITrendReference> {
  return TrendReference.create({
    niche: input.niche,
    genre: input.genre,
    sourceUrl: input.sourceUrl,
    platform: input.platform,
    metrics: input.metrics ?? { capturedAt: new Date() },
    notes: input.notes,
    status: input.status ?? "candidate",
  });
}

export async function listTrendReferences(
  input: ListTrendReferencesInput = {}
): Promise<ITrendReference[]> {
  const filter: Partial<Pick<ITrendReference, "niche" | "genre" | "platform" | "status">> = {};

  if (input.niche) filter.niche = input.niche;
  if (input.genre) filter.genre = input.genre;
  if (input.platform) filter.platform = input.platform;
  if (input.status) filter.status = input.status;

  return TrendReference.find(filter)
    .sort({ "metrics.views": -1, "metrics.likes": -1, updatedAt: -1 })
    .skip(input.skip ?? 0)
    .limit(Math.min(input.limit ?? 50, 200));
}
