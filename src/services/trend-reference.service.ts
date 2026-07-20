import {
  TrendReference,
  type ITrendMetrics,
  type ITrendReference,
  type TrendPlatform,
  type TrendReferenceStatus,
} from "../models/trend-reference.model";
import { TREND_RESEARCH_VERSION } from "./trend-research.constants";

export interface CreateTrendReferenceInput {
  niche: string;
  genre?: string;
  genreIds?: string[];
  sourceUrl: string;
  platform: TrendPlatform;
  metrics?: ITrendMetrics;
  notes?: string;
  status?: TrendReferenceStatus;
  researchVersion?: string;
}

export interface ListTrendReferencesInput {
  niche?: string;
  researchVersion?: string;
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
    researchVersion: input.researchVersion ?? TREND_RESEARCH_VERSION,
    genre: input.genre,
    genreIds: input.genreIds ?? (input.genre ? [input.genre] : []),
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
  const filter: Record<string, unknown> = { researchVersion: input.researchVersion ?? TREND_RESEARCH_VERSION };

  if (input.niche) filter.niche = input.niche;
  if (input.platform) filter.platform = input.platform;
  if (input.status) filter.status = input.status;

  if (input.genre) {
    return TrendReference.find({
      ...filter,
      // Accept a legacy `genre` field within the current research version;
      // pre-revamp rows stay outside this fresh corpus.
      $or: [{ genreIds: input.genre }, { genre: input.genre }],
    })
      .sort({ "metrics.views": -1, "metrics.likes": -1, updatedAt: -1 })
      .skip(input.skip ?? 0)
      .limit(Math.min(input.limit ?? 50, 200));
  }

  return TrendReference.find(filter)
    .sort({ "metrics.views": -1, "metrics.likes": -1, updatedAt: -1 })
    .skip(input.skip ?? 0)
    .limit(Math.min(input.limit ?? 50, 200));
}
