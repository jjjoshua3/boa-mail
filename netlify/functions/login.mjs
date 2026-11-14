import { antwoord, controleerLogin, geldigAdres, ipVan, koekje, leesJson, mailLog, openToken, verzegel } from "./lib.mjs";
import { bevestigBeheer, startBeheer } from "./beheer.mjs";

const DIENST = new Set(["support", "info"]);

function naarAdres(ruw) {
  let s = String(ruw || "").trim().toLowerCase();
  if (!s) return "";
  if (!s.includes("@")) s += "@boaportaal.nl";
  return s;
}

function profiel(adres) {
  const local = adres.split("@")[0];
  return {
    email: adres,
    local,
    account: local === "joshua.bosma" || local === "beheerder",
  };
}

export async function handler(event) {
  if (event.httpMethod !== "POST") return antwoord(405, { fout: "Niet toegestaan." });
  try {
    const body = leesJson(event);
    const ip = ipVan(event);
    if (body.ticket) {
      const open = openToken(body.ticket);
      if (!open?.factorId) return antwoord(401, { fout: "De tweede stap is verlopen. Log opnieuw in." });
      const local = open.email.split("@")[0];
      const check = await bevestigBeheer(open, body.code);
      if (check.fout) {
        await mailLog("MAIL_LOGIN", local, "onjuiste authenticatorcode", "mislukt", ip);
        return antwoord(401, { fout: check.fout });
      }
      const token = verzegel({ email: open.email, pass: open.pass, exp: Date.now() + 12 * 60 * 60 * 1000 });
      await mailLog("MAIL_LOGIN", local, "ingelogd", "geslaagd", ip);
      return antwoord(200, profiel(open.email), { "set-cookie": koekje(token, 12 * 60 * 60) });
    }
    const adres = naarAdres(body.email);
    const local = adres.split("@")[0];
    if (!geldigAdres(adres)) return antwoord(400, { fout: "Gebruik je eigen loginnaam, zonder @boaportaal.nl." });
    if (DIENST.has(local)) return antwoord(403, { fout: "Info en Support zijn gedeelde postbussen. Log in met je eigen loginnaam. Die post lees je daarna in de map." });
    const geheim = String(body.wachtwoord || "");
    if (geheim.length < 8 || geheim.length > 200) {
      await mailLog("MAIL_LOGIN", local, "geweigerd", "mislukt", ip);
      return antwoord(401, { fout: "Deze loginnaam en dit wachtwoord horen niet bij een postbus." });
    }
    try {
      await controleerLogin(adres, geheim);
    } catch {
      await mailLog("MAIL_LOGIN", local, "wachtwoord onjuist", "mislukt", ip);
      return antwoord(401, { fout: "Deze loginnaam en dit wachtwoord horen niet bij een postbus." });
    }
    let beheer = { letop: "Tweestapsverificatie staat nog uit. Je bent ingelogd met alleen je wachtwoord." };
    try {
      beheer = await startBeheer(adres, geheim);
    } catch {
      beheer = { letop: "Tweestapsverificatie staat nog uit. Je bent ingelogd met alleen je wachtwoord." };
    }
    if (beheer.stap) {
      const ticket = verzegel({
        email: adres,
        pass: geheim,
        exp: Date.now() + 10 * 60 * 1000,
        ticket: true,
        factorId: beheer.factorId,
        access_token: beheer.access_token,
        refresh_token: beheer.refresh_token,
      });
      return antwoord(200, {
        stap: beheer.stap,
        ticket,
        qr: beheer.qr || "",
        secret: beheer.secret || "",
        local,
        welke: "beheer",
      });
    }
    const token = verzegel({ email: adres, pass: geheim, exp: Date.now() + 12 * 60 * 60 * 1000 });
    await mailLog("MAIL_LOGIN", local, beheer.letop ? "ingelogd zonder tweede stap" : "ingelogd", "geslaagd", ip);
    return antwoord(200, { ...profiel(adres), letop: beheer.letop || "" }, { "set-cookie": koekje(token, 12 * 60 * 60) });
  } catch (err) {
    if (String(err?.message || "") === "geen sleutel") {
      return antwoord(503, { fout: "De mailserver mist een sessiesleutel. Zet op de Netlify-site van mail dezelfde SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY als bij systeem, of een SESSION_SECRET van minstens 24 tekens." });
    }
    return antwoord(500, { fout: "Inloggen lukt nu niet. Probeer het opnieuw." });
  }
}
