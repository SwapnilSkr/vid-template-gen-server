import { t } from "elysia";

export const ConnectInstagramBody = t.Object({
  label: t.String({ minLength: 1, maxLength: 100 }),
  channelKey: t.Optional(t.String({ minLength: 1, maxLength: 64 })),
  niches: t.Optional(t.Array(t.String({ maxLength: 64 }), { maxItems: 20 })),
});
export type TConnectInstagramBody = typeof ConnectInstagramBody.static;

export const InstagramCallbackQuery = t.Object({
  code: t.Optional(t.String()), state: t.Optional(t.String()), error: t.Optional(t.String()), error_reason: t.Optional(t.String()), error_description: t.Optional(t.String()),
});
export type TInstagramCallbackQuery = typeof InstagramCallbackQuery.static;
