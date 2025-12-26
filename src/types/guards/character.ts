import { t } from "elysia";

/**
 * Character position schema - reusable partial
 */
export const CharacterPositionSchema = t.Object({
  x: t.Number(),
  y: t.Number(),
  scale: t.Number(),
  anchor: t.String(),
});

/**
 * Create character request body
 */
export const CreateCharacterBody = t.Object({
  image: t.File(),
  name: t.String(),
  displayName: t.String(),
  voiceId: t.String(),
  positionX: t.Optional(t.Number({ default: 50 })),
  positionY: t.Optional(t.Number({ default: 75 })),
  scale: t.Optional(t.Number({ default: 0.25 })),
  anchor: t.Optional(t.String({ default: "bottom-left" })),
});

/**
 * Update character request body
 */
export const UpdateCharacterBody = t.Object({
  ...t.Partial(t.Omit(CreateCharacterBody, ["name"])).properties,
  position: t.Optional(CharacterPositionSchema),
});

export type TCharacterPosition = typeof CharacterPositionSchema.static;
export type TCreateCharacterBody = typeof CreateCharacterBody.static;
export type TUpdateCharacterBody = typeof UpdateCharacterBody.static;
