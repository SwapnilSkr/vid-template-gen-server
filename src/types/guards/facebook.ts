import { t } from "elysia";

export const ConnectFacebookBody = t.Object({
  label: t.String({ minLength: 1, maxLength: 100 }),
  channelKey: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  niches: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 20 })),
});
export type TConnectFacebookBody = typeof ConnectFacebookBody.static;

export const UpdateFacebookPageBody = t.Object({
  label: t.Optional(t.String({ minLength: 1, maxLength: 100 })),
  niches: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 20 })),
});
export type TUpdateFacebookPageBody = typeof UpdateFacebookPageBody.static;

export const FacebookCallbackQuery = t.Object({
  code: t.Optional(t.String()),
  state: t.Optional(t.String()),
  error: t.Optional(t.String()),
  error_reason: t.Optional(t.String()),
  error_description: t.Optional(t.String()),
});
export type TFacebookCallbackQuery = typeof FacebookCallbackQuery.static;

/** Meta posts this form field to both Facebook Login lifecycle callbacks. */
export const FacebookSignedRequestBody = t.Object({
  signed_request: t.String({ minLength: 20 }),
});
export type TFacebookSignedRequestBody = typeof FacebookSignedRequestBody.static;

export const FacebookDeletionStatusParams = t.Object({
  confirmationCode: t.String({ minLength: 1, maxLength: 128 }),
});
export type TFacebookDeletionStatusParams = typeof FacebookDeletionStatusParams.static;
