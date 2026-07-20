import type { Context } from "elysia";
import { getErrorMessage } from "../types";
import type {
  TGameplayLibraryDeleteBody,
  TGameplayLibraryRenameBody,
  TGameplayLibrarySpeedBody,
  TGameplayLibraryTrimBody,
} from "../types/guards";
import {
  deleteGameplayLibraryClip,
  renameGameplayLibraryClip,
  speedGameplayLibraryClip,
  trimGameplayLibraryClip,
} from "../services/gameplay-library.service";

interface DeleteContext extends Context { body: TGameplayLibraryDeleteBody; }
interface RenameContext extends Context { body: TGameplayLibraryRenameBody; }
interface TrimContext extends Context { body: TGameplayLibraryTrimBody; }
interface SpeedContext extends Context { body: TGameplayLibrarySpeedBody; }

export async function deleteGameplayLibraryController({ body, set }: DeleteContext) {
  try {
    return { success: true, data: await deleteGameplayLibraryClip(body.key, body.force === true) };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function renameGameplayLibraryController({ body, set }: RenameContext) {
  try {
    return { success: true, data: await renameGameplayLibraryClip(body.key, body.name) };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function trimGameplayLibraryController({ body, set }: TrimContext) {
  try {
    return { success: true, data: await trimGameplayLibraryClip(body.key, body.startSec, body.endSec) };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}

export async function speedGameplayLibraryController({ body, set }: SpeedContext) {
  try {
    return { success: true, data: await speedGameplayLibraryClip(body.key, body.speed) };
  } catch (error: unknown) {
    set.status = 400;
    return { success: false, error: getErrorMessage(error) };
  }
}
