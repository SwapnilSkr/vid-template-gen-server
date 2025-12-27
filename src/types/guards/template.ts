import { t } from "elysia";

/**
 * Create template request body
 */
export const CreateTemplateBody = t.Object({
  video: t.File(),
  name: t.String(),
  description: t.Optional(t.String()),
});

/**
 * Update template request body
 */
export const UpdateTemplateBody = t.Object({
  ...t.Partial(CreateTemplateBody).properties,
});

/**
 * Add/Remove characters from template body
 */
export const TemplateCharactersBody = t.Object({
  characterIds: t.Array(t.String()),
});

/**
 * Query parameters for template upload with optional trimming
 */
export const TemplateQuery = t.Object({
  trimStart: t.Optional(
    t.Numeric({ description: "Seconds to trim from the start of the video" })
  ),
  keepDuration: t.Optional(
    t.Numeric({ description: "Keep only the first N seconds of the video" })
  ),
});

export type TCreateTemplateBody = typeof CreateTemplateBody.static;
export type TUpdateTemplateBody = typeof UpdateTemplateBody.static;
export type TTemplateCharactersBody = typeof TemplateCharactersBody.static;
export type TTemplateQuery = typeof TemplateQuery.static;
