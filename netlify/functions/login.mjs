import { antwoord, controleerLogin, geldigAdres, ipVan, koekje, leesJson, mailLog, openToken, verzegel } from "./lib.mjs";
import { bevestigBeheer, mailMoetWijzigen, mailWachtwoordGezet, startBeheer } from "./beheer.mjs";

const DIENST = new Set(["support", "info"]);

function naarAdres(ruw) {
  let s = String(ruw || "").trim().toLowerCase();
  if (!s) return "";
  if (!s.includes("@")) s += "@boaportaal.nl";
  return s;
}

async function slaIp(ip, naam) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key || !ip || !naam) return;
  await fetch("https://systeem.boaportaal.nl/.netlify/functions/ip", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ actie: "poging", bron: "mail", ip, naam }),
  }).catch(() => null);
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
    if (body.wijzig) {
      const open = openToken(body.ticket);
      if (!open?.wijzig) return antwoord(401, { fout: "Kies het nieuwe wachtwoord opnieuw. De tijd is om." });
      const nieuw = String(body.nieuw || "");
      const nog = String(body.nog || "");
      const local = open.email.split("@")[0];
      if (nieuw.length < 12 || nieuw.length > 200) return antwoord(400, { fout: "Kies een wachtwoord van minstens 12 tekens." });
      if (nieuw !== nog) return antwoord(400, { fout: "De twee wachtwoorden zijn niet gelijk." });
      if (nieuw === open.pass) return antwoord(400, { fout: "Kies een ander wachtwoord dan het tijdelijke." });
      const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
      const gezet = await fetch("https://systeem.boaportaal.nl/.netlify/functions/postbus", {
        method: "POST",
        headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
        body: JSON.stringify({ local, password: nieuw }),
      });
      const data = await gezet.json().catch(() => ({}));
      if (!gezet.ok || !data.ok) return antwoord(500, { fout: data.fout || "Het mailwachtwoord is niet gewijzigd." });
      await mailWachtwoordGezet(local);
      const token = verzegel({ email: open.email, pass: nieuw, exp: Date.now() + 12 * 60 * 60 * 1000 });
      await mailLog("MAIL_LOGIN", local, "mailwachtwoord gewijzigd", "geslaagd", ip);
      return antwoord(200, profiel(open.email), { "set-cookie": koekje(token, 12 * 60 * 60) });
    }
    if (body.ticket) {
      const open = openToken(body.ticket);
      if (!open?.factorId) return antwoord(401, { fout: "De tweede stap is verlopen. Log opnieuw in." });
      const local = open.email.split("@")[0];
      const check = await bevestigBeheer(open, body.code);
      if (check.fout) {
        await mailLog("MAIL_LOGIN", local, "onjuiste authenticatorcode", "mislukt", ip);
        await slaIp(ip, local);
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
      await slaIp(ip, local);
      return antwoord(401, { fout: "Deze loginnaam en dit wachtwoord horen niet bij een postbus." });
    }
    try {
      await controleerLogin(adres, geheim);
    } catch {
      await mailLog("MAIL_LOGIN", local, "wachtwoord onjuist", "mislukt", ip);
      await slaIp(ip, local);
      return antwoord(401, { fout: "Deze loginnaam en dit wachtwoord horen niet bij een postbus." });
    }
    if (await mailMoetWijzigen(local)) {
      const ticket = verzegel({ email: adres, pass: geheim, exp: Date.now() + 10 * 60 * 1000, ticket: true, wijzig: true });
      return antwoord(200, { stap: "wachtwoord", ticket, local });
    }
    let beheer = { letop: "" };
    try {
      beheer = await startBeheer(adres, geheim);
    } catch {
      beheer = { letop: "" };
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
