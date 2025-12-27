/**
 * Error type utilities for proper error handling
 */

/**
 * Standard error shape with message property
 */
export interface ErrorWithMessage {
  message: string;
}

/**
 * Node.js-style error with code property
 */
export interface NodeError extends Error {
  code?: string;
}

/**
 * Type guard to check if an error has a message property
 */
export function isErrorWithMessage(error: unknown): error is ErrorWithMessage {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

/**
 * Type guard to check if an error is a Node.js-style error with code
 */
export function isNodeError(error: unknown): error is NodeError {
  return (
    error instanceof Error && "code" in error && typeof error.code === "string"
  );
}

/**
 * Extracts error message from an unknown error
 */
export function getErrorMessage(error: unknown): string {
  if (isErrorWithMessage(error)) {
    return error.message;
  }
  if (typeof error === "string") {
    return error;
  }
  return "An unknown error occurred";
}
