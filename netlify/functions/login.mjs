import { antwoord, controleerLogin, geldigAdres, koekje, leesJson, verzegel } from "./lib.mjs";

const DIENST = new Set(["support", "info", "account"]);

export async function handler(event) {
  if (event.httpMethod !== "POST") return antwoord(405, { fout: "Niet toegestaan." });
  try {
    const { email, wachtwoord } = leesJson(event);
    const adres = String(email || "").trim().toLowerCase();
    const local = adres.split("@")[0];
    if (!geldigAdres(adres)) return antwoord(400, { fout: "Gebruik je eigen adres op boaportaal.nl." });
    if (DIENST.has(local)) return antwoord(403, { fout: "Log in met je eigen postbus, niet met support, info of account." });
    if (String(wachtwoord || "").length < 8) return antwoord(401, { fout: "Dit adres en wachtwoord horen niet bij een postbus." });
    try {
      await controleerLogin(adres, String(wachtwoord));
    } catch {
      return antwoord(401, { fout: "Dit adres en wachtwoord horen niet bij een postbus." });
    }
    const token = verzegel({ email: adres, pass: String(wachtwoord), exp: Date.now() + 12 * 60 * 60 * 1000 });
    return antwoord(200, { email: adres, local }, { "set-cookie": koekje(token, 12 * 60 * 60) });
  } catch {
    return antwoord(500, { fout: "Inloggen lukt nu niet. Probeer het opnieuw." });
  }
}
