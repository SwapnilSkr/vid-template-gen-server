import {
  S3Client,
  GetObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
  HeadObjectCommand,
} from "@aws-sdk/client-s3";
import { Upload } from "@aws-sdk/lib-storage";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import { config } from "../config";
import { generateFilename } from "../utils";

// Initialize S3 client
const s3Client = new S3Client({
  region: config.awsRegion,
  credentials: {
    accessKeyId: config.awsAccessKeyId,
    secretAccessKey: config.awsSecretAccessKey,
  },
});

export type S3Folder =
  | "templates"
  | "characters"
  | "compositions"
  | "reels"
  | "audio"
  | "subtitles"
  | "gameplay"
  | "voice-samples"
  | "art-styles"
  | "yt-imports";

/** Public delivery URL for a key — CloudFront if configured, else direct S3. */
export function cdnUrlFor(key: string): string {
  if (config.cdnUrl) return `${config.cdnUrl}/${key}`;
  return `https://${config.s3Bucket}.s3.${config.awsRegion}.amazonaws.com/${key}`;
}

/** List object keys under a prefix (e.g. "gameplay/"). */
export async function listKeys(prefix: string): Promise<string[]> {
  const keys: string[] = [];
  let token: string | undefined;
  do {
    const res = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const o of res.Contents ?? []) if (o.Key) keys.push(o.Key);
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return keys;
}

/** List objects under a prefix with their last-modified time (for age-based
 * safety checks — e.g. don't touch anything uploaded in the last hour, it
 * might belong to a render that's still in flight). */
export async function listKeysWithMeta(
  prefix: string
): Promise<{ key: string; lastModified?: Date }[]> {
  const out: { key: string; lastModified?: Date }[] = [];
  let token: string | undefined;
  do {
    const res = await s3Client.send(
      new ListObjectsV2Command({
        Bucket: config.s3Bucket,
        Prefix: prefix,
        ContinuationToken: token,
      })
    );
    for (const o of res.Contents ?? []) {
      if (o.Key) out.push({ key: o.Key, lastModified: o.LastModified });
    }
    token = res.IsTruncated ? res.NextContinuationToken : undefined;
  } while (token);
  return out;
}

/** Check whether an object exists at `key` without downloading it. */
export async function keyExists(key: string): Promise<boolean> {
  try {
    await s3Client.send(new HeadObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    return true;
  } catch {
    return false;
  }
}

/**
 * Upload a file to S3
 */
export async function uploadToS3(
  buffer: Buffer,
  folder: S3Folder,
  filename: string,
  contentType: string
): Promise<string> {
  const key = `${folder}/${filename}`;

  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    },
  });

  await upload.done();

  const url = `https://${config.s3Bucket}.s3.${config.awsRegion}.amazonaws.com/${key}`;
  console.log(`☁️  Uploaded to S3: ${key}`);

  return url;
}

/** Read + parse a JSON object straight from S3 (bypasses CDN caching, so it's
 *  always current — use for server-side reads of files that change, e.g. the
 *  model-health report). Returns undefined if missing/unreadable. */
export async function getJson<T>(key: string): Promise<T | undefined> {
  try {
    const res = await s3Client.send(new GetObjectCommand({ Bucket: config.s3Bucket, Key: key }));
    const body = await res.Body?.transformToString();
    return body ? (JSON.parse(body) as T) : undefined;
  } catch {
    return undefined;
  }
}

/** Upload a JSON object to an exact S3 key (no folder prefix). Returns its CDN URL. */
export async function putJson(key: string, data: unknown): Promise<string> {
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.s3Bucket,
      Key: key,
      Body: Buffer.from(JSON.stringify(data, null, 2)),
      ContentType: "application/json",
    },
  });
  await upload.done();
  console.log(`☁️  Uploaded to S3: ${key}`);
  return cdnUrlFor(key);
}

/**
 * Upload a video file to S3
 */
export async function uploadVideo(
  buffer: Buffer,
  folder: S3Folder,
  originalFilename: string
): Promise<string> {
  const ext = originalFilename.split(".").pop() || "mp4";
  const filename = generateFilename("video", ext);
  return uploadToS3(buffer, folder, filename, `video/${ext}`);
}

/**
 * Upload an image file to S3
 */
export async function uploadImage(
  buffer: Buffer,
  folder: S3Folder,
  originalFilename: string
): Promise<string> {
  const ext = originalFilename.split(".").pop() || "png";
  const filename = generateFilename("image", ext);
  return uploadToS3(buffer, folder, filename, `image/${ext}`);
}

/**
 * Upload audio file to S3
 */
export async function uploadAudio(
  buffer: Buffer,
  originalFilename: string
): Promise<string> {
  const ext = originalFilename.split(".").pop() || "mp3";
  const filename = generateFilename("audio", ext);
  return uploadToS3(buffer, "audio", filename, `audio/${ext}`);
}

/**
 * Upload subtitle file to S3
 */
export async function uploadSubtitles(
  content: string,
  compositionId: string
): Promise<string> {
  const buffer = Buffer.from(content, "utf-8");
  const isAss = content.trim().startsWith("[Script Info]");
  const extension = isAss ? "ass" : "srt";
  const filename = `${compositionId}.${extension}`;
  return uploadToS3(buffer, "subtitles", filename, "text/plain");
}

/**
 * Generate a presigned URL for downloading
 */
export async function getPresignedUrl(
  key: string,
  expiresInSeconds = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

/** Upload a local file to an exact S3 key. Returns the CDN URL. */
export async function uploadFileAtKey(
  localPath: string,
  key: string,
  contentType: string
): Promise<string> {
  const { readFile } = await import("node:fs/promises");
  const buffer = await readFile(localPath);
  const upload = new Upload({
    client: s3Client,
    params: {
      Bucket: config.s3Bucket,
      Key: key,
      Body: buffer,
      ContentType: contentType,
    },
  });
  await upload.done();
  console.log(`☁️  Uploaded to S3: ${key}`);
  return cdnUrlFor(key);
}

/** Delete an object by its raw S3 key (e.g. "reels/video_123.mp4"). */
export async function deleteKey(key: string): Promise<void> {
  await s3Client.send(new DeleteObjectCommand({ Bucket: config.s3Bucket, Key: key }));
  console.log(`🗑️  Deleted from S3: ${key}`);
}

/**
 * Delete a file from S3 given its full URL (CDN or direct S3).
 */
export async function deleteFromS3(url: string): Promise<void> {
  const key = getS3KeyFromUrl(url);
  if (!key) return;
  await deleteKey(key);
}

/**
 * Get S3 key from a full URL — direct S3 or CloudFront.
 */
export function getS3KeyFromUrl(url: string): string | null {
  const s3Parts = url.split(".amazonaws.com/");
  if (s3Parts.length >= 2) return s3Parts[1];

  if (config.cdnUrl && url.startsWith(config.cdnUrl)) {
    return url.slice(config.cdnUrl.length).replace(/^\/+/, "");
  }
  return null;
}
