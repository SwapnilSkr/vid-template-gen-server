import { Elysia } from "elysia";
import { saveFileToDisk } from "../utils";

export type LocalUploadField = {
  field: string;
  prefix?: string;
  required?: boolean;
};

/**
 * Middleware to save uploaded files to local disk
 * Provides local paths in 'localFiles' context
 */
export const localFileSave = (fields: LocalUploadField[]) => {
  return new Elysia({ name: "local-file-save" }).derive(
    { as: "global" },
    async ({ body, set }) => {
      const localFiles: Record<string, string> = {};
      if (!body || typeof body !== "object") return { localFiles };

      const bodyMap = body as Record<string, any>;

      for (const { field, prefix = "upload", required = false } of fields) {
        const file = bodyMap[field];

        if (file instanceof File) {
          try {
            console.log(`💾 Middleware: Saving "${field}" to local disk...`);
            const path = await saveFileToDisk(file, prefix);
            localFiles[field] = path;
          } catch (error: any) {
            set.status = 500;
            throw new Error(
              `Failed to save ${field} to disk: ${error.message}`
            );
          }
        } else if (required && !file) {
          set.status = 400;
          throw new Error(`Field ${field} is required but missing`);
        }
      }

      return { localFiles };
    }
  );
};
