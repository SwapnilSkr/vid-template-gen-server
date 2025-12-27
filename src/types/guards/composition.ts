import { t } from "elysia";

/**
 * Create composition request body
 */
export const CreateCompositionBody = t.Object({
  templateId: t.String(),
  plot: t.String(),
  title: t.Optional(t.String()),
  subtitlePosition: t.Optional(
    t.Union([t.Literal("top"), t.Literal("center"), t.Literal("bottom")])
  ),
});

export type TCreateCompositionBody = typeof CreateCompositionBody.static;

/**
 * Regenerate composition request body
 */
export const RegenerateCompositionBody = t.Object({
  delays: t.Optional(t.Array(t.Number())),
  subtitlePosition: t.Optional(
    t.Union([t.Literal("top"), t.Literal("center"), t.Literal("bottom")])
  ),
});

export type TRegenerateCompositionBody =
  typeof RegenerateCompositionBody.static;
