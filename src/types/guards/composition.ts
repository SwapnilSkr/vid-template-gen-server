import { t } from "elysia";

/**
 * Character position schema for composition
 * x, y, and scale are optional - if not provided, they will be calculated from anchor and screenType
 */
export const CharacterPositionSchema = t.Object({
  x: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
  y: t.Optional(t.Number({ minimum: 0, maximum: 100 })),
  scale: t.Optional(t.Number({ minimum: 0.01, maximum: 2 })),
  anchor: t.Union([
    t.Literal("top-left"),
    t.Literal("top-right"),
    t.Literal("bottom-left"),
    t.Literal("bottom-right"),
    t.Literal("center"),
  ]),
});

/**
 * Screen type enum
 */
export const ScreenTypeSchema = t.Union([
  t.Literal("mobile"),
  t.Literal("desktop"),
]);

/**
 * Subtitle animation type enum
 */
export const SubtitleAnimationSchema = t.Union([
  t.Literal("none"),
  t.Literal("pop"),
  t.Literal("shake"),
  t.Literal("reel"),
]);

/**
 * Create composition request body
 */
export const CreateCompositionBody = t.Object({
  templateId: t.String(),
  plot: t.String(),
  title: t.Optional(t.String()),
  screenType: t.Optional(ScreenTypeSchema),
  subtitlePosition: t.Optional(
    t.Union([t.Literal("top"), t.Literal("center"), t.Literal("bottom")])
  ),
  subtitleAnimation: t.Optional(SubtitleAnimationSchema),
  characterPositions: t.Optional(t.Record(t.String(), CharacterPositionSchema)),
});

export type TCreateCompositionBody = typeof CreateCompositionBody.static;

/**
 * Regenerate composition request body
 */
export const RegenerateCompositionBody = t.Object({
  delays: t.Optional(t.Array(t.Number())),
  screenType: t.Optional(ScreenTypeSchema),
  subtitlePosition: t.Optional(
    t.Union([t.Literal("top"), t.Literal("center"), t.Literal("bottom")])
  ),
  subtitleAnimation: t.Optional(SubtitleAnimationSchema),
  characterPositions: t.Optional(t.Record(t.String(), CharacterPositionSchema)),
});

export type TRegenerateCompositionBody =
  typeof RegenerateCompositionBody.static;
