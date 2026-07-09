import ffmpeg from "fluent-ffmpeg";
import { config } from "./index";

/**
 * Point fluent-ffmpeg at FFMPEG_PATH / FFPROBE_PATH for EVERY service that
 * imports fluent-ffmpeg directly (reel-render, gameplay, review, etc.).
 *
 * Without this, only modules that import ffmpeg.service.ts get the custom
 * paths — reel workers on Windows/Docker with ffmpeg not on PATH fail to spawn.
 *
 * Import this module once at process start (src/index.ts + queue/workers.ts).
 */
export function configureFfmpeg(): void {
  if (config.ffmpegPath) {
    ffmpeg.setFfmpegPath(config.ffmpegPath);
  }
  if (config.ffprobePath) {
    ffmpeg.setFfprobePath(config.ffprobePath);
  }
}

configureFfmpeg();
