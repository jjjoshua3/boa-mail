import { antwoord, controleerLogin, geldigAdres, ipVan, koekje, leesJson, mailLog, openToken, verzegel } from "./lib.mjs";
import { bevestigBeheer, mailMoetWijzigen, mailWachtwoordGezet, startBeheer } from "./beheer.mjs";

const DIENST = new Set(["support", "info", "ambassadeur"]);

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

function profiel(adres, extra = {}) {
  const local = adres.split("@")[0];
  return {
    email: adres,
    local,
    account: local === "joshua.bosma" || local === "beheerder",
    staf: adres.endsWith("@boaportaal.nl"),
    org: extra.slug || "",
    orgNaam: extra.naam || "",
    ambassadeur: Boolean(extra.slug),
    voornaam: extra.voornaam || "",
    achternaam: extra.achternaam || "",
  };
}

async function orgVan(email) {
  if (!String(email).endsWith("@ambassadeur.boaportaal.nl")) return null;
  const local = email.split("@")[0];
  if (!local.includes(".")) return { weiger: true };
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  const url = process.env.SUPABASE_URL;
  if (!key || !url) return null;
  const kop = { apikey: key, authorization: `Bearer ${key}` };
  const beheer = await fetch(`${url}/rest/v1/boa_ambassadeur?mail_local=eq.${encodeURIComponent(local)}&actief=eq.true&select=organisatie_id,voornaam,achternaam`, { headers: kop }).then((r) => r.json()).catch(() => []);
  const id = beheer?.[0]?.organisatie_id;
  if (!id) return null;
  const org = await fetch(`${url}/rest/v1/boa_organisatie?id=eq.${id}&select=slug,naam,mail_geheim`, { headers: kop }).then((r) => r.json()).catch(() => []);
  if (!org?.[0]?.slug) return null;
  return { slug: org[0].slug, naam: org[0].naam, pass: org[0].mail_geheim || "", voornaam: beheer[0].voornaam || "", achternaam: beheer[0].achternaam || "" };
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
      const org = await orgVan(open.email);
      const token = verzegel({ email: open.email, pass: nieuw, exp: Date.now() + 12 * 60 * 60 * 1000, org: org?.slug || "", orgPass: org?.pass || "", voornaam: org?.voornaam || "", achternaam: org?.achternaam || "" });
      await mailLog("MAIL_LOGIN", local, "mailwachtwoord gewijzigd", "geslaagd", ip);
      return antwoord(200, profiel(open.email, org || {}), { "set-cookie": koekje(token, 12 * 60 * 60) });
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
      const org = await orgVan(open.email);
      const token = verzegel({ email: open.email, pass: open.pass, exp: Date.now() + 12 * 60 * 60 * 1000, org: org?.slug || "", orgPass: org?.pass || "", voornaam: org?.voornaam || "", achternaam: org?.achternaam || "" });
      await mailLog("MAIL_LOGIN", local, "ingelogd", "geslaagd", ip);
      return antwoord(200, profiel(open.email, org || {}), { "set-cookie": koekje(token, 12 * 60 * 60) });
    }
    const adres = naarAdres(body.email);
    const local = adres.split("@")[0];
    if (!geldigAdres(adres)) return antwoord(400, { fout: "Gebruik voornaam.achternaam, of het volledige adres voornaam.achternaam@ambassadeur.boaportaal.nl." });
    if (DIENST.has(local) || adres === "support@ambassadeur.boaportaal.nl") return antwoord(403, { fout: "Dit is een gedeelde postbus. Log in met uw eigen adres." });
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
    const org = await orgVan(adres);
    if (org?.weiger) return antwoord(403, { fout: "Dit is de organisatiebus. Log in met uw volledige adres: voornaam.achternaam@ambassadeur.boaportaal.nl." });
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
    const token = verzegel({ email: adres, pass: geheim, exp: Date.now() + 12 * 60 * 60 * 1000, org: org?.slug || "", orgPass: org?.pass || "", voornaam: org?.voornaam || "", achternaam: org?.achternaam || "" });
    await mailLog("MAIL_LOGIN", local, beheer.letop ? "ingelogd zonder tweede stap" : "ingelogd", "geslaagd", ip);
    return antwoord(200, { ...profiel(adres, org || {}), letop: beheer.letop || "" }, { "set-cookie": koekje(token, 12 * 60 * 60) });
  } catch (err) {
    if (String(err?.message || "") === "geen sleutel") {
      return antwoord(503, { fout: "De mailserver mist een sessiesleutel. Zet op de Netlify-site van mail dezelfde SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY als bij systeem, of een SESSION_SECRET van minstens 24 tekens." });
    }
    return antwoord(500, { fout: "Inloggen lukt nu niet. Probeer het opnieuw." });
  }
}
