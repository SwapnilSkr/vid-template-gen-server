import { config } from "../config";
import type { TtsChoice } from "../config/models";
import { Reel, type ICostBreakdown, ICostLine, IReel } from "../models";

export interface MeasuredCostInput {
  label: string;
  model?: string;
  costUsd?: number;
  source: "actual" | "estimated";
}

const COST_NOTE =
  "Actual lines use OpenRouter response/generation usage when available. Estimated lines are marked explicitly; OpenRouter does not expose exact cost for every media endpoint response.";

const TTS_PRICE_PER_1K_CHARS_USD = 0.00003;
const LLM_PLANNING_ESTIMATE_USD = 0.002;
const LOCAL_RENDER_STORAGE_ESTIMATE_USD = 0.001;
const METERED_LLM_LABEL =
  /^(Script planning|Story bible|Scene script|Horror series plan|Reddit story|Review copy|Structure script)/;

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

function line(
  label: string,
  units: number,
  unit: string,
  unitCostUsd: number,
  model?: string
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
    input.model
  );
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
  const lines = [...(reel.costBreakdown?.lines ?? []), ...newLines];
  reel.costBreakdown = {
    currency: "USD",
    totalUsd: roundUsd(lines.reduce((sum, item) => sum + item.costUsd, 0)),
    lines,
    note: reel.costBreakdown?.note ?? COST_NOTE,
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

async function getVideoSkuPrice(model: string): Promise<number | undefined> {
  try {
    const res = await fetch(`${config.openRouterBaseUrl}/videos/models`);
    if (!res.ok) return undefined;
    const data = (await res.json()) as {
      data?: { id: string; pricing_skus?: Record<string, string | number> }[];
    };
    const match = data.data?.find((item) => item.id === model);
    const skus = match?.pricing_skus;
    if (!skus) return undefined;
    const raw =
      skus.duration_seconds_without_audio_720p ??
      skus.duration_seconds_without_audio ??
      skus.duration_seconds_720p ??
      skus.duration_seconds ??
      skus.text_to_video_duration_seconds_720p;
    const parsed = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : NaN;
    return Number.isFinite(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export async function buildReelCostBreakdown(
  reel: IReel,
  opts: {
    llmModel: string;
    tts: TtsChoice;
    measuredCosts?: MeasuredCostInput[];
    heroVideoModel?: string;
    heroDurationSec?: number;
  }
): Promise<ICostBreakdown> {
  const measured = (opts.measuredCosts ?? []).map(measuredLine).filter((item): item is ICostLine => Boolean(item));
  // Prefer the metered LLM line(s) (real model + every pass) over the flat
  // estimate — that estimate is only a fallback when metering didn't report.
  const hasMeteredLlm = (opts.measuredCosts ?? []).some((item) =>
    METERED_LLM_LABEL.test(item.label),
  );
  const lines: ICostLine[] = [
    ...(hasMeteredLlm ? [] : [line("Script planning (estimated)", 1, "plan", LLM_PLANNING_ESTIMATE_USD, opts.llmModel)]),
    ...measured,
  ];

  const hasMeasuredTts = measured.some((item) => item.label.startsWith("Narration"));
  const ttsChars = reel.scenes.reduce((sum, scene) => sum + scene.narration.length, 0);
  if (!hasMeasuredTts && ttsChars > 0) {
    lines.push(
      line(
        "Narration (estimated)",
        Math.ceil(ttsChars / 1000),
        "1k chars",
        TTS_PRICE_PER_1K_CHARS_USD,
        `${opts.tts.model}/${opts.tts.voice}`
      )
    );
  }

  const hasMeasuredHero = measured.some((item) => item.label.startsWith("Hero video"));
  if (!hasMeasuredHero && opts.heroVideoModel && opts.heroDurationSec && opts.heroDurationSec > 0) {
    const perSecond = await getVideoSkuPrice(opts.heroVideoModel);
    if (perSecond !== undefined) {
      lines.push(line("Hero video (live SKU estimate)", opts.heroDurationSec, "second", perSecond, opts.heroVideoModel));
    } else {
      lines.push(line("Hero video (price not reported)", 1, "request", 0, opts.heroVideoModel));
    }
  }

  lines.push(line("Render + storage (estimated)", 1, "video", LOCAL_RENDER_STORAGE_ESTIMATE_USD));

  const totalUsd = roundUsd(lines.reduce((sum, item) => sum + item.costUsd, 0));
  return {
    currency: "USD",
    totalUsd,
    lines,
    note: COST_NOTE,
    generatedAt: new Date(),
  };
}

/**
 * Merge a new produce/re-render run into the existing breakdown so re-renders
 * accumulate OpenRouter spend instead of wiping prior actuals. Keeps prior
 * lines and appends this run's lines with a `[Re-render]` prefix.
 */
export function accumulateReelCostBreakdown(
  previous: ICostBreakdown | undefined,
  next: ICostBreakdown,
  runLabel = "Re-render"
): ICostBreakdown {
  if (!previous?.lines?.length) return next;

  const stampedNext = next.lines.map((item) => ({
    ...item,
    label: item.label.startsWith("[") ? item.label : `[${runLabel}] ${item.label}`,
  }));
  const lines = [...previous.lines, ...stampedNext];
  return {
    currency: "USD",
    totalUsd: roundUsd(lines.reduce((sum, item) => sum + item.costUsd, 0)),
    lines,
    note: next.note ?? previous.note,
    generatedAt: new Date(),
  };
}
