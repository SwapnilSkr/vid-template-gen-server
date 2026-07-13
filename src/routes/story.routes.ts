import { Elysia } from "elysia";
import { ListStoryBankQuery, ListStoryCandidatesQuery, ResolveStoryBody } from "../types/guards";
import {
  listStoryBankController,
  listStoryCandidatesController,
  listStoryGenresController,
  resolveStoryController,
} from "../controllers";

export const storyRoutes = new Elysia({ prefix: "/api/stories" })
  .get("/candidates", listStoryCandidatesController, { query: ListStoryCandidatesQuery })
  .get("/bank", listStoryBankController, { query: ListStoryBankQuery })
  .get("/genres", listStoryGenresController)
  .post("/resolve", resolveStoryController, { body: ResolveStoryBody });
