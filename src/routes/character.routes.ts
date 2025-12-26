import { Elysia, t } from "elysia";
import {
  createCharacter,
  getCharacter,
  listCharacters,
  updateCharacter,
  deleteCharacter,
} from "../services";

export const characterRoutes = new Elysia({ prefix: "/api/characters" })
  // Create a new character
  .post(
    "/",
    async ({ body }) => {
      const {
        image,
        name,
        displayName,
        voiceId,
        positionX,
        positionY,
        scale,
        anchor,
      } = body;

      if (!image) {
        return { success: false, error: "No image file provided" };
      }

      try {
        const buffer = Buffer.from(await image.arrayBuffer());
        const character = await createCharacter(
          buffer,
          image.name,
          name,
          displayName,
          voiceId,
          {
            x: positionX,
            y: positionY,
            scale,
            anchor: anchor as any,
          }
        );

        return { success: true, data: character };
      } catch (error: any) {
        return { success: false, error: error.message };
      }
    },
    {
      body: t.Object({
        image: t.File(),
        name: t.String(),
        displayName: t.String(),
        voiceId: t.String(),
        positionX: t.Optional(t.Number({ default: 50 })),
        positionY: t.Optional(t.Number({ default: 75 })),
        scale: t.Optional(t.Number({ default: 0.25 })),
        anchor: t.Optional(t.String({ default: "bottom-left" })),
      }),
    }
  )

  // List all characters
  .get("/", async () => {
    const characters = await listCharacters();
    return { success: true, data: characters };
  })

  // Get character by ID or name
  .get(
    "/:id",
    async ({ params }) => {
      const character = await getCharacter(params.id);
      if (!character) {
        return { success: false, error: "Character not found" };
      }
      return { success: true, data: character };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  )

  // Update character
  .put(
    "/:id",
    async ({ params, body }) => {
      const updated = await updateCharacter(params.id, body as any);
      if (!updated) {
        return { success: false, error: "Character not found" };
      }
      return { success: true, data: updated };
    },
    {
      params: t.Object({ id: t.String() }),
      body: t.Object({
        displayName: t.Optional(t.String()),
        voiceId: t.Optional(t.String()),
        position: t.Optional(
          t.Object({
            x: t.Number(),
            y: t.Number(),
            scale: t.Number(),
            anchor: t.String(),
          })
        ),
      }),
    }
  )

  // Delete character
  .delete(
    "/:id",
    async ({ params }) => {
      const deleted = await deleteCharacter(params.id);
      if (!deleted) {
        return { success: false, error: "Character not found" };
      }
      return { success: true, data: { deleted: true } };
    },
    {
      params: t.Object({
        id: t.String(),
      }),
    }
  );
