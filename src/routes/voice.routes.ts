import { Elysia } from "elysia";
import { getVoices } from "../services";

export const voiceRoutes = new Elysia({ prefix: "/api/voices" })
  // List all available voices from ElevenLabs
  .get("/", async () => {
    try {
      const voices = await getVoices();
      return { success: true, data: voices };
    } catch (error: any) {
      return { success: false, error: error.message };
    }
  });
