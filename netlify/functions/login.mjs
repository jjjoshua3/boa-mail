import { antwoord, controleerLogin, geldigAdres, ipVan, koekje, leesJson, mailLog, openToken, verzegel } from "./lib.mjs";
import { bewaarGeheim, totpStaat } from "./adres.mjs";
import { klopt, nieuwGeheim, qrData } from "./totp.mjs";

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
      if (!open) return antwoord(401, { fout: "De tweede stap is verlopen. Log opnieuw in." });
      const local = open.email.split("@")[0];
      const staat = await totpStaat(open.email);
      if (staat.fout) return antwoord(503, { fout: staat.fout });
      if (!staat.geheim || !klopt(staat.geheim, body.code)) {
        await mailLog("MAIL_LOGIN", local, "onjuiste authenticatorcode", "mislukt", ip);
        return antwoord(401, { fout: "De code uit de authenticator klopt niet." });
      }
      if (!staat.bevestigd) {
        const opgeslagen = await bewaarGeheim(local, staat.geheim, true);
        if (opgeslagen.fout) return antwoord(503, { fout: "De authenticator kon niet worden vastgelegd." });
      }
      const token = verzegel({ email: open.email, pass: open.pass, exp: Date.now() + 12 * 60 * 60 * 1000 });
      await mailLog("MAIL_LOGIN", local, "ingelogd", "geslaagd", ip);
      return antwoord(200, profiel(open.email), { "set-cookie": koekje(token, 12 * 60 * 60) });
    }
    const adres = naarAdres(body.email);
    const local = adres.split("@")[0];
    if (!geldigAdres(adres)) return antwoord(400, { fout: "Gebruik je loginnaam. Zonder @boaportaal.nl, bijvoorbeeld info of je Client-ID." });
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
    const staat = await totpStaat(adres);
    if (staat.fout) return antwoord(503, { fout: staat.fout });
    if (staat.overgeslagen) {
      const token = verzegel({ email: adres, pass: geheim, exp: Date.now() + 12 * 60 * 60 * 1000 });
      await mailLog("MAIL_LOGIN", local, "ingelogd, tweestaps nog niet gekoppeld", "geslaagd", ip);
      return antwoord(200, profiel(adres), { "set-cookie": koekje(token, 12 * 60 * 60) });
    }
    let geheimTotp = staat.geheim;
    const stap = staat.bevestigd ? "code" : "setup";
    if (!geheimTotp) {
      geheimTotp = nieuwGeheim();
      const opgeslagen = await bewaarGeheim(local, geheimTotp, false);
      if (opgeslagen.fout) return antwoord(503, { fout: "De authenticator kon niet worden klaargezet." });
    }
    const ticket = verzegel({
      email: adres,
      pass: geheim,
      exp: Date.now() + 10 * 60 * 1000,
      ticket: true,
    });
    return antwoord(200, {
      stap,
      ticket,
      qr: stap === "setup" ? await qrData(geheimTotp, local) : "",
      secret: stap === "setup" ? geheimTotp : "",
      local,
    });
  } catch {
    return antwoord(500, { fout: "Inloggen lukt nu niet. Probeer het opnieuw." });
  }
}
