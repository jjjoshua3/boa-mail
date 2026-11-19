import { antwoord, berichten, openSessie } from "./lib.mjs";

export async function handler(event) {
  const sessie = openSessie(event);
  if (!sessie) return antwoord(401, { fout: "Log opnieuw in." });
  const local = sessie.email.split("@")[0];
  const map = sessie.org ? "org" : "in";
  let lijst = [];
  try {
    lijst = (await berichten(sessie, map)).berichten || [];
  } catch {
    lijst = [];
  }
  return antwoord(200, {
    email: sessie.email,
    local,
    account: local === "joshua.bosma" || local === "beheerder",
    staf: String(sessie.email).endsWith("@boaportaal.nl"),
    org: sessie.org || "",
    orgNaam: sessie.orgNaam || "",
    ambassadeur: Boolean(sessie.org),
    voornaam: sessie.voornaam || "",
    achternaam: sessie.achternaam || "",
    map,
    berichten: lijst,
  });
}