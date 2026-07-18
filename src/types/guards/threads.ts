import { t } from "elysia";

export const ConnectThreadsBody = t.Object({
  label: t.String({ minLength: 1, maxLength: 100 }),
  channelKey: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  niches: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 20 })),
});
export type TConnectThreadsBody = typeof ConnectThreadsBody.static;

export const UpdateThreadsChannelBody = t.Object({
  label: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  niches: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 20 })),
});
export type TUpdateThreadsChannelBody = typeof UpdateThreadsChannelBody.static;

export const ThreadsCallbackQuery = t.Object({
  code: t.Optional(t.String()),
  state: t.Optional(t.String()),
  error: t.Optional(t.String()),
  error_reason: t.Optional(t.String()),
  error_description: t.Optional(t.String()),
});
export type TThreadsCallbackQuery = typeof ThreadsCallbackQuery.static;

/** Meta posts this form field to both the uninstall and data-deletion URLs. */
export const ThreadsSignedRequestBody = t.Object({
  signed_request: t.String({ minLength: 20 }),
});
export type TThreadsSignedRequestBody = typeof ThreadsSignedRequestBody.static;

export const ThreadsDeletionStatusParams = t.Object({
  confirmationCode: t.String({ minLength: 1, maxLength: 128 }),
});
export type TThreadsDeletionStatusParams = typeof ThreadsDeletionStatusParams.static;
