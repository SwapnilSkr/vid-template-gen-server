import { t } from "elysia";

/**
 * Create character request body
 */
export const CreateCharacterBody = t.Object({
  image: t.File(),
  name: t.String(),
  displayName: t.String(),
  voiceId: t.String(),
});

/**
 * Update character request body
 */
export const UpdateCharacterBody = t.Object({
  image: t.Optional(t.File()),
  displayName: t.Optional(t.String()),
  voiceId: t.Optional(t.String()),
});

export type TCreateCharacterBody = typeof CreateCharacterBody.static;
export type TUpdateCharacterBody = typeof UpdateCharacterBody.static;
