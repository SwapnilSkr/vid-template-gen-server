import type { ICharacter } from "../models";

export interface SubtitleEntry {
  index: number;
  startTime: string;
  endTime: string;
  text: string;
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
 * Calculate dialogue timing based on text length
 */
export function calculateDialogueTiming(
  dialogues: { text: string }[],
  startTime = 0,
  wordsPerSecond = 2.5,
  pauseBetweenLines = 0.5
): { text: string; startTime: number; duration: number }[] {
  let currentTime = startTime;

  return dialogues.map((d) => {
    const wordCount = d.text.split(/\s+/).length;
    const duration = Math.max(1.5, wordCount / wordsPerSecond);

    const result = {
      text: d.text,
      startTime: currentTime,
      duration,
    };

    currentTime += duration + pauseBetweenLines;

    return result;
  });
}
