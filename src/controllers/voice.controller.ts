import { getVoices } from "../services";
import { getErrorMessage } from "../types";

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
  } catch (error: unknown) {
    return { success: false, error: getErrorMessage(error) };
  }
}
