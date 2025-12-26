import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
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
  | "audio"
  | "subtitles";

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
  const filename = `${compositionId}.srt`;
  return uploadToS3(buffer, "subtitles", filename, "text/plain");
}

/**
 * Generate a presigned URL for downloading
 */
export async function getPresignedUrl(
  key: string,
  expiresInSeconds: number = 3600
): Promise<string> {
  const command = new GetObjectCommand({
    Bucket: config.s3Bucket,
    Key: key,
  });

  return getSignedUrl(s3Client, command, { expiresIn: expiresInSeconds });
}

/**
 * Delete a file from S3
 */
export async function deleteFromS3(url: string): Promise<void> {
  // Extract key from URL
  const urlParts = url.split(".amazonaws.com/");
  if (urlParts.length < 2) return;

  const key = urlParts[1];

  await s3Client.send(
    new DeleteObjectCommand({
      Bucket: config.s3Bucket,
      Key: key,
    })
  );

  console.log(`🗑️  Deleted from S3: ${key}`);
}

/**
 * Get S3 key from full URL
 */
export function getS3KeyFromUrl(url: string): string | null {
  const urlParts = url.split(".amazonaws.com/");
  return urlParts.length >= 2 ? urlParts[1] : null;
}
