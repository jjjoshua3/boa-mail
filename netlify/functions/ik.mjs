import { antwoord, openSessie } from "./lib.mjs";

export async function handler(event) {
  const sessie = openSessie(event);
  if (!sessie) return antwoord(401, { fout: "Log opnieuw in." });
  const local = sessie.email.split("@")[0];
  return antwoord(200, {
    email: sessie.email,
    local,
    account: local === "joshua.bosma" || local === "beheerder",
  });
}
