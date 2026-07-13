import { Elysia, t } from "elysia";
import {
  deleteOperationLogController,
  deleteOperationLogsController,
  deleteAllOperationLogsController,
  listOperationLogsController,
} from "../controllers";

export const operationLogRoutes = new Elysia({ prefix: "/api/operations" })
  .get("/", listOperationLogsController, {
    query: t.Object({
      limit: t.Optional(t.String()),
      before: t.Optional(t.String()),
      level: t.Optional(t.String()),
      scope: t.Optional(t.String()),
      reelId: t.Optional(t.String()),
    }),
  })
  .delete("/", deleteOperationLogsController, {
    body: t.Object({ ids: t.Array(t.String({ minLength: 1 }), { minItems: 1, maxItems: 100 }) }),
  })
  .delete("/all", deleteAllOperationLogsController)
  .delete("/:id", deleteOperationLogController, {
    params: t.Object({ id: t.String({ minLength: 1 }) }),
  });
