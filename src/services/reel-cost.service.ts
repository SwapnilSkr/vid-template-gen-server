import { config } from "../config";
import type { TtsChoice } from "../config/models";
import type { ICostBreakdown, ICostLine, IReel } from "../models";

export interface MeasuredCostInput {
  label: string;
  model?: string;
  costUsd?: number;
  source: "actual" | "estimated";
}

const TTS_PRICE_PER_1K_CHARS_USD = 0.00003;
const LLM_PLANNING_ESTIMATE_USD = 0.002;
const LOCAL_RENDER_STORAGE_ESTIMATE_USD = 0.001;

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
  const hasMeteredLlm = measured.some((item) => /^(Script planning|Story bible|Scene script)/.test(item.label));
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
    note:
      "Actual lines use OpenRouter response/generation usage when available. Estimated lines are marked explicitly; OpenRouter does not expose exact cost for every media endpoint response.",
    generatedAt: new Date(),
  };
}
