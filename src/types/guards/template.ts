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

export type TCreateTemplateBody = typeof CreateTemplateBody.static;
export type TUpdateTemplateBody = typeof UpdateTemplateBody.static;
export type TTemplateCharactersBody = typeof TemplateCharactersBody.static;
