import { getVoices } from "../services";

// ============================================
// Controller Functions
// ============================================

/**
 * List all available voices from ElevenLabs
 */
export async function listVoicesController() {
  try {
    const voices = await getVoices();
    return { success: true, data: voices };
  } catch (error: any) {
    return { success: false, error: error.message };
  }
}
