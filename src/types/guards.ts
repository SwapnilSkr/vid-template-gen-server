import { t } from "elysia";

// ============================================
// Common Guard Types
// ============================================

/**
 * Common ID parameter guard - reusable for all routes with :id param
 */
export const IdParams = t.Object({
  id: t.String(),
});

// ============================================
// Character Guards
// ============================================

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
  image: t.Optional(t.File()),
  displayName: t.Optional(t.String()),
  voiceId: t.Optional(t.String()),
  position: t.Optional(CharacterPositionSchema),
});

// ============================================
// Template Guards
// ============================================

/**
 * Create template request body
 */
export const CreateTemplateBody = t.Object({
  video: t.File(),
  name: t.String(),
  description: t.Optional(t.String()),
});

/**
 * Add/Remove characters from template body
 */
export const TemplateCharactersBody = t.Object({
  characterIds: t.Array(t.String()),
});

// ============================================
// Composition Guards
// ============================================

/**
 * Create composition request body
 */
export const CreateCompositionBody = t.Object({
  templateId: t.String(),
  plot: t.String(),
  title: t.Optional(t.String()),
});

// ============================================
// Type Exports (TypeScript types from Elysia schemas)
// ============================================

export type TIdParams = typeof IdParams.static;
export type TCharacterPosition = typeof CharacterPositionSchema.static;
export type TCreateCharacterBody = typeof CreateCharacterBody.static;
export type TUpdateCharacterBody = typeof UpdateCharacterBody.static;
export type TCreateTemplateBody = typeof CreateTemplateBody.static;
export type TTemplateCharactersBody = typeof TemplateCharactersBody.static;
export type TCreateCompositionBody = typeof CreateCompositionBody.static;
