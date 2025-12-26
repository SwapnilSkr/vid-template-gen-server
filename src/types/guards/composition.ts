import { t } from "elysia";

/**
 * Create composition request body
 */
export const CreateCompositionBody = t.Object({
  templateId: t.String(),
  plot: t.String(),
  title: t.Optional(t.String()),
});

export type TCreateCompositionBody = typeof CreateCompositionBody.static;
