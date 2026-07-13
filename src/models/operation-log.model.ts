import { Schema, model, type Document } from "mongoose";

export type OperationLogLevel = "debug" | "info" | "warn" | "error";
export type OperationLogScope = "api" | "queue" | "worker" | "external" | "system";

export interface IOperationLog extends Document {
  requestId?: string;
  level: OperationLogLevel;
  scope: OperationLogScope;
  event: string;
  message: string;
  method?: string;
  path?: string;
  status?: number;
  durationMs?: number;
  reelId?: string;
  jobId?: string;
  metadata?: Record<string, unknown>;
  error?: {
    name?: string;
    message: string;
    stack?: string;
    code?: string;
  };
  expiresAt: Date;
  createdAt: Date;
  updatedAt: Date;
}

const operationLogSchema = new Schema<IOperationLog>(
  {
    requestId: { type: String, index: true },
    level: { type: String, enum: ["debug", "info", "warn", "error"], required: true, index: true },
    scope: { type: String, enum: ["api", "queue", "worker", "external", "system"], required: true, index: true },
    event: { type: String, required: true, index: true },
    message: { type: String, required: true },
    method: String,
    path: String,
    status: Number,
    durationMs: Number,
    reelId: { type: String, index: true },
    jobId: { type: String, index: true },
    metadata: Schema.Types.Mixed,
    error: {
      name: String,
      message: String,
      stack: String,
      code: String,
    },
    // TTL keeps an outage from becoming an unbounded database-growth event.
    // Creators can still delete any entries earlier through Operations.
    expiresAt: { type: Date, required: true, index: { expires: 0 } },
  },
  { timestamps: true }
);

operationLogSchema.index({ createdAt: -1, level: 1 });
operationLogSchema.index({ reelId: 1, createdAt: -1 });

export const OperationLog = model<IOperationLog>("OperationLog", operationLogSchema);
