import { Elysia } from "elysia";
import { uploadImage, uploadVideo } from "../services/s3.service";
import { getErrorMessage } from "../types";

export interface UploadField {
  field: string;
  type: "image" | "video";
  folder: "characters" | "templates" | "compositions";
  required?: boolean;
}

/**
 * Request body with file fields
 */
type FileRequestBody = Record<string, unknown>;

/**
 * Middleware to handle S3 file uploads dynamically
 * Replaces File objects in body with S3 URLs
 */
export const fileUpload = (fields: UploadField[]) => {
  return new Elysia({ name: "file-upload" }).derive(
    { as: "global" },
    async ({ body, set }) => {
      const uploadedFiles: Record<string, string> = {};
      if (!body || typeof body !== "object") return { uploadedFiles };

      const bodyMap = body as FileRequestBody;
      console.log(
        "🔍 Upload middleware triggered. Body keys:",
        Object.keys(bodyMap)
      );

      for (const { field, type, folder, required = false } of fields) {
        const file = bodyMap[field];
        console.log(
          `🔍 Checking field "${field}":`,
          file instanceof File ? "File detected" : typeof file
        );

        if (file instanceof File) {
          try {
            console.log(`⬆️  Uploading ${type} "${field}" to S3...`);
            const buffer = Buffer.from(await file.arrayBuffer());
            let url: string;

            if (type === "video") {
              url = await uploadVideo(buffer, folder, file.name);
            } else {
              url = await uploadImage(buffer, folder, file.name);
            }

            uploadedFiles[field] = url;
            console.log(`✅ Uploaded ${field} to ${url}`);
          } catch (error: unknown) {
            set.status = 500;
            throw new Error(
              `Failed to upload ${field}: ${getErrorMessage(error)}`
            );
          }
        } else if (required && !file) {
          set.status = 400;
          throw new Error(`Field ${field} is required but missing`);
        }
      }

      return { uploadedFiles };
    }
  );
};
