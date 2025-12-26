/**
 * Parse timestamp string to seconds
 * Supports formats: "1:30", "1:30.5", "90", "90.5"
 */
export function parseTimestamp(timestamp: string | number): number {
  if (typeof timestamp === "number") return timestamp;

  const parts = timestamp.split(":");
  if (parts.length === 1) {
    return parseFloat(parts[0]);
  }
  if (parts.length === 2) {
    const [minutes, seconds] = parts.map(parseFloat);
    return minutes * 60 + seconds;
  }
  if (parts.length === 3) {
    const [hours, minutes, seconds] = parts.map(parseFloat);
    return hours * 3600 + minutes * 60 + seconds;
  }
  throw new Error(`Invalid timestamp format: ${timestamp}`);
}

/**
 * Format seconds to timestamp string
 */
export function formatTimestamp(seconds: number): string {
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const secs = (seconds % 60).toFixed(2);

  if (hours > 0) {
    return `${hours}:${minutes.toString().padStart(2, "0")}:${secs.padStart(
      5,
      "0"
    )}`;
  }
  return `${minutes}:${secs.padStart(5, "0")}`;
}

/**
 * Calculate total duration from dialogue lines
 */
export function calculateTotalDuration(
  lines: Array<{ startTime: number; duration?: number }>
): number {
  let maxEnd = 0;
  for (const line of lines) {
    const end = line.startTime + (line.duration || 3); // default 3 seconds if unknown
    if (end > maxEnd) maxEnd = end;
  }
  return maxEnd;
}
