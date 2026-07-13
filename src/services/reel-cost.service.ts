import type { TtsChoice } from "../config/models";
import { Reel, type ICostBreakdown, type ICostLine, type IReel } from "../models";

export interface MeasuredCostInput {
  label: string;
  model?: string;
  costUsd?: number;
  source: "actual" | "estimated";
}

const COST_NOTE =
  "OpenRouter AI spend only (LLM, image, TTS, video). Actual usage is recorded when OpenRouter reports it; fallback estimates are clearly labelled.";

/** Legacy infra lines that should never appear in the AI ledger. */
const NON_AI_COST_LABEL = /Render \+ storage/i;

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function line(
  label: string,
  units: number,
  unit: string,
  unitCostUsd: number,
  model?: string,
): ICostLine {
  return {
    label,
    model,
    units,
    unit,
    unitCostUsd,
    costUsd: roundUsd(units * unitCostUsd),
  };
}

function measuredLine(input: MeasuredCostInput): ICostLine | undefined {
  if (input.costUsd === undefined) return undefined;
  return line(
    `${input.label} (${input.source})`,
    1,
    "request",
    roundUsd(input.costUsd),
    input.model,
  );
}

/** Drop non-AI ledger lines and recompute the total. */
export function sanitizeAiCostBreakdown(
  breakdown?: ICostBreakdown,
): ICostBreakdown | undefined {
  if (!breakdown?.lines?.length) return breakdown;
  const lines = breakdown.lines.filter((item) => !NON_AI_COST_LABEL.test(item.label));
  if (!lines.length) return undefined;
  return {
    ...breakdown,
    lines,
    totalUsd: roundUsd(lines.reduce((sum, item) => sum + item.costUsd, 0)),
    note: COST_NOTE,
  };
}

/** Append metered OpenRouter lines to a reel without adding produce estimates. */
export function applyMeasuredCostsToReel(
  reel: IReel,
  measuredCosts: MeasuredCostInput[],
  runLabel?: string,
): void {
  if (!measuredCosts.length) return;
  const newLines = measuredCosts
    .map(measuredLine)
    .filter((item): item is ICostLine => Boolean(item))
    .map((item) => ({
      ...item,
      label: runLabel ? `[${runLabel}] ${item.label}` : item.label,
    }));
  const previous = sanitizeAiCostBreakdown(reel.costBreakdown);
  const lines = [...(previous?.lines ?? []), ...newLines];
  reel.costBreakdown = {
    currency: "USD",
    totalUsd: roundUsd(lines.reduce((sum, item) => sum + item.costUsd, 0)),
    lines,
    note: COST_NOTE,
    generatedAt: new Date(),
  };
  reel.costUsd = reel.costBreakdown.totalUsd;
}

export async function recordReelMeasuredCosts(
  reelId: string,
  measuredCosts: MeasuredCostInput[],
  runLabel?: string,
): Promise<void> {
  if (!measuredCosts.length) return;
  const reel = await Reel.findById(reelId);
  if (!reel) throw new Error("Reel not found");
  applyMeasuredCostsToReel(reel, measuredCosts, runLabel);
  await reel.save();
}

export async function buildReelCostBreakdown(
  _reel: IReel,
  opts: {
    llmModel: string;
    tts: TtsChoice;
    measuredCosts?: MeasuredCostInput[];
    heroVideoModel?: string;
    heroDurationSec?: number;
  },
): Promise<ICostBreakdown> {
  const lines = (opts.measuredCosts ?? [])
    .map(measuredLine)
    .filter((item): item is ICostLine => Boolean(item));
  return (
    sanitizeAiCostBreakdown({
      currency: "USD",
      totalUsd: roundUsd(lines.reduce((sum, item) => sum + item.costUsd, 0)),
      lines,
      note: COST_NOTE,
      generatedAt: new Date(),
    }) ?? {
      currency: "USD",
      totalUsd: 0,
      lines: [],
      note: COST_NOTE,
      generatedAt: new Date(),
    }
  );
}

/**
 * Merge any completed run into the existing breakdown. Planning and initial
 * production can both spend credits before a reel has an output URL, so using
 * output presence as the ledger boundary would erase legitimate earlier spend.
 */
export function accumulateReelCostBreakdown(
  previous: ICostBreakdown | undefined,
  next: ICostBreakdown,
  runLabel = "Re-render",
): ICostBreakdown {
  const prev = sanitizeAiCostBreakdown(previous);
  const sanitizedNext = sanitizeAiCostBreakdown(next);
  if (!sanitizedNext?.lines?.length) {
    return prev ?? sanitizedNext ?? next;
  }
  if (!prev?.lines?.length) return sanitizedNext;

  const stampedNext = sanitizedNext.lines.map((item) => ({
    ...item,
    label: item.label.startsWith("[") ? item.label : `[${runLabel}] ${item.label}`,
  }));
  const lines = [...prev.lines, ...stampedNext];
  return {
    currency: "USD",
    totalUsd: roundUsd(lines.reduce((sum, item) => sum + item.costUsd, 0)),
    lines,
    note: COST_NOTE,
    generatedAt: new Date(),
  };
}
