import { t } from "elysia";

/**
 * Common ID parameter guard - reusable for all routes with :id param
 */
export const IdParams = t.Object({
  id: t.String(),
});

export type TIdParams = typeof IdParams.static;
