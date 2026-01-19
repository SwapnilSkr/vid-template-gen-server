import type { ICharacter } from "../models";

export interface SubtitleEntry {
  index: number;
  startTime: string;
  endTime: string;
  text: string;
}

export interface KaraokeConfig {
  wordsPerChunkMin?: number;
  wordsPerChunkMax?: number;
  primaryColor?: string;
  secondaryColor?: string;
  chunkSpeedMultiplier?: number; // Lower = faster chunks
  animationType?: "none" | "pop" | "shake" | "reel";
}

/**
 * Format time for SRT (HH:MM:SS,mmm)
 */
function formatSrtTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);
  const ms = Math.round((seconds % 1) * 1000);

  return `${hours.toString().padStart(2, "0")}:${minutes
    .toString()
    .padStart(2, "0")}:${secs.toString().padStart(2, "0")},${ms
    .toString()
    .padStart(3, "0")}`;
}

/**
 * Generate SRT subtitle content from dialogue
 */
export function generateSrtContent(
  dialogues: {
    text: string;
    startTime: number;
    duration: number;
    character?: ICharacter | undefined;
  }[]
): string {
  const entries: SubtitleEntry[] = dialogues.map((d, index) => ({
    index: index + 1,
    startTime: formatSrtTime(d.startTime),
    endTime: formatSrtTime(d.startTime + d.duration),
    text: d.text,
  }));

  return entries
    .map((e) => `${e.index}\n${e.startTime} --> ${e.endTime}\n${e.text}\n`)
    .join("\n");
}

function hexToAssColor(hex: string): string {
  const cleanHex = hex.replace(/^#/, "");
  const r = parseInt(cleanHex.substring(0, 2), 16);
  const g = parseInt(cleanHex.substring(2, 4), 16);
  const b = parseInt(cleanHex.substring(4, 6), 16);
  return `&H00${b.toString(16).padStart(2, "0")}${g
    .toString(16)
    .padStart(2, "0")}${r.toString(16).padStart(2, "0")}`;
}

function formatAssTime(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = (seconds % 60).toFixed(2);
  return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.padStart(
    5,
    "0"
  )}`;
}

function getRandomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function splitTextIntoChunks(
  text: string,
  minWords: number,
  maxWords: number
): string[] {
  const words = text.trim().split(/\s+/);
  if (words.length === 0) return [""];

  const chunks: string[] = [];
  let i = 0;

  while (i < words.length) {
    const chunkSize = getRandomInt(minWords, maxWords);
    const end = Math.min(i + chunkSize, words.length);
    chunks.push(words.slice(i, end).join(" "));
    i = end;
  }

  return chunks;
}

function splitChunkIntoWords(chunk: string): string[] {
  return chunk
    .trim()
    .split(/\s+/)
    .filter((word) => word.length > 0);
}

/**
 * Get ASS animation tags for a given animation type
 * Returns opening tags for the active word
 */
function getAnimationTags(
  animationType: "none" | "pop" | "shake" | "reel",
  wordDurationMs: number
): string {
  if (animationType === "none") {
    return "";
  }

  // Calculate timing for animation (use first ~40% of word duration for effect)
  const animDuration = Math.min(Math.floor(wordDurationMs * 0.4), 200);
  const halfAnim = Math.floor(animDuration / 2);

  switch (animationType) {
    case "pop":
      // Scale up to 120% then back to 100%
      return `{\\t(0,${halfAnim},\\fscx120\\fscy120)\\t(${halfAnim},${animDuration},\\fscx100\\fscy100)}`;
    case "shake": {
      // Rotate right, left, then back to center
      const third = Math.floor(animDuration / 3);
      return `{\\t(0,${third},\\frz8)\\t(${third},${third * 2},\\frz-8)\\t(${third * 2},${animDuration},\\frz0)}`;
    }
    case "reel": {
      // Slide in from left with fade in (reel-style)
      // Move from -200px left to center, with fade
      return `{\\move(-200,0,0,0,0,${animDuration})\\fad(${Math.floor(animDuration * 0.3)},0)}`;
    }
    default:
      return "";
  }
}

export async function generateKaraokeAssContent(
  dialogues: { text: string; startTime: number; duration: number }[],
  config: KaraokeConfig = {},
  alignment = 2,
  marginV = 30
): Promise<string> {
  const {
    wordsPerChunkMin = 2,
    wordsPerChunkMax = 3,
    primaryColor = "#FFFFFF",
    secondaryColor = "#00FF00",
    chunkSpeedMultiplier = 0.75,
    animationType = "none",
  } = config;

  const primaryAssColor = hexToAssColor(primaryColor);
  const secondaryAssColor = hexToAssColor(secondaryColor);
  const greenAssColor = hexToAssColor(secondaryColor);
  const whiteAssColor = hexToAssColor(primaryColor);

  const header = `[Script Info]
Title: Karaoke Subtitles
ScriptType: v4.00+
PlayResX: 1920
PlayResY: 1080
WrapStyle: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,${primaryAssColor},${secondaryAssColor},&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,1,${alignment},10,10,${marginV},1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const dialogueLines: string[] = [];

  for (const dialogue of dialogues) {
    const dialogueStartTime = dialogue.startTime;

    const chunks = splitTextIntoChunks(
      dialogue.text,
      wordsPerChunkMin,
      wordsPerChunkMax
    );
    const chunkDuration =
      (dialogue.duration / chunks.length) * chunkSpeedMultiplier;

    for (let i = 0; i < chunks.length; i++) {
      const chunkStartTime = dialogueStartTime + i * chunkDuration;

      const currentChunk = chunks[i];
      const words = splitChunkIntoWords(currentChunk);
      const wordDuration = chunkDuration / words.length;

      for (let j = 0; j < words.length; j++) {
        const wordStartTime = chunkStartTime + j * wordDuration;
        const wordEndTime = chunkStartTime + (j + 1) * wordDuration;

        const startTimeStr = formatAssTime(wordStartTime);
        const endTimeStr = formatAssTime(wordEndTime);

        let coloredText = "";
        for (let k = 0; k < words.length; k++) {
          if (k === j) {
            // Active word: apply color and animation
            const wordDurationMs = Math.floor(wordDuration * 1000);
            const animTags = getAnimationTags(animationType, wordDurationMs);
            coloredText += `{\\1c&${greenAssColor}}${animTags}${words[k]}`;
          } else {
            coloredText += `{\\1c&${whiteAssColor}}${words[k]}`;
          }
          if (k < words.length - 1) {
            coloredText += " ";
          }
        }

        const dialogueLine = `Dialogue: 0,${startTimeStr},${endTimeStr},Default,,0,0,0,,${coloredText}`;
        console.log(
          `🎤 Word ${j + 1}/${words.length} in chunk: ${dialogueLine.substring(
            0,
            120
          )}...`
        );
        dialogueLines.push(dialogueLine);
      }
    }
  }

  return header + dialogueLines.join("\n") + "\n";
}

/**
 * Generate ASS subtitle content (for better styling)
 */
export function generateAssContent(
  dialogues: { text: string; startTime: number; duration: number }[]
): string {
  const header = `[Script Info]
Title: Generated Subtitles
ScriptType: v4.00+
Collisions: Normal
PlayDepth: 0

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,48,&H00FFFFFF,&H000000FF,&H00000000,&H80000000,1,0,0,0,100,100,0,0,1,3,2,2,10,10,30,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
`;

  const formatAssTime = (seconds: number): string => {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = (seconds % 60).toFixed(2);
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.padStart(
      5,
      "0"
    )}`;
  };

  const events = dialogues
    .map((d) => {
      const start = formatAssTime(d.startTime);
      const end = formatAssTime(d.startTime + d.duration);
      return `Dialogue: 0,${start},${end},Default,,0,0,0,,${d.text}`;
    })
    .join("\n");

  return header + events;
}

/**
 * Calculate dialogue timing based on text length and AI-generated delays
 */
export function calculateDialogueTiming(
  dialogues: { text: string; delay?: number }[],
  startTime = 0,
  wordsPerSecond = 2.5
): { text: string; startTime: number; duration: number; delay: number }[] {
  let currentTime = startTime;

  return dialogues.map((d, index) => {
    const wordCount = d.text.split(/\s+/).length;
    const duration = Math.max(1.5, wordCount / wordsPerSecond);
    // Use AI-provided delay, fallback to defaults based on position
    const delay = d.delay ?? (index === 0 ? 0 : 0.4);

    // Add delay before this line
    currentTime += delay;

    const result = {
      text: d.text,
      startTime: currentTime,
      duration,
      delay,
    };

    // Move forward by the duration of speech
    currentTime += duration;

    return result;
  });
}
