import { API } from "../../server/api";
import { api } from "./client";

export async function dismissServerError(errorId: string): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    await api(API.dismissError.method, API.dismissError.path({ errorId }));
    return { ok: true };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}
