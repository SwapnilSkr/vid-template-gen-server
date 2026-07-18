#!/usr/bin/env bun
/**
 * Prepare local word alignment for Reddit narrations.
 *
 * The whisper.cpp executable is deliberately installed through the OS package
 * manager (not node_modules): it is a native binary and local `bun dev` should
 * use the same executable as production. This script only downloads the small
 * English model into gitignored runtime storage.
 */
import { mkdir, rename, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";

const cli = process.env.WHISPER_CLI_PATH || "whisper-cli";
const modelPath = resolve(
  process.env.WHISPER_MODEL_PATH || "./storage/whisper/ggml-base.en.bin"
);
const modelUrl = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin";
const minimumModelBytes = 100 * 1024 * 1024;

const cliCheck = Bun.spawnSync([cli, "--help"], { stdout: "ignore", stderr: "ignore" });
if (cliCheck.exitCode !== 0) {
  console.error(`Missing ${cli}. On macOS, install it once with:\n\n  brew install whisper-cpp\n`);
  process.exit(1);
}

const existing = await stat(modelPath).catch(() => undefined);
if (existing && existing.size >= minimumModelBytes) {
  console.log(`✓ whisper.cpp CLI found; base.en model already present (${Math.round(existing.size / 1024 / 1024)} MB)\n  ${modelPath}`);
  process.exit(0);
}

await mkdir(dirname(modelPath), { recursive: true });
const tempPath = `${modelPath}.download`;
console.log("Downloading local Whisper base.en model (~142 MB; one-time)…");
// Stream with the system curl rather than buffering a Fetch Response in Bun.
// It gives the user a real progress meter and lets a later run resume a partial
// 142 MB transfer instead of appearing frozen for hours.
const download = Bun.spawnSync([
  "curl",
  "--fail",
  "--location",
  "--retry", "3",
  "--retry-delay", "2",
  "--connect-timeout", "15",
  "--max-time", "900",
  "--continue-at", "-",
  "--output", tempPath,
  modelUrl,
], { stdout: "inherit", stderr: "inherit" });
if (download.exitCode !== 0) {
  throw new Error(`Model download failed (curl exit ${download.exitCode}). Re-run this command to resume the partial download.`);
}
const downloaded = await stat(tempPath);
if (downloaded.size < minimumModelBytes) {
  throw new Error(`Downloaded model is unexpectedly small (${downloaded.size} bytes); refusing to install it.`);
}
await rename(tempPath, modelPath);
console.log(`✓ Installed ${Math.round(downloaded.size / 1024 / 1024)} MB model at\n  ${modelPath}\n\nAdd this to .env.local, then restart bun dev:\n  WHISPER_ALIGNMENT_ENABLED=true`);
