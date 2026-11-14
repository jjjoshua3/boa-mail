import { antwoord, koekje } from "./lib.mjs";

export async function handler() {
  return antwoord(200, { ok: true }, { "set-cookie": koekje("", 0) });
}
