import { antwoord, berichten, controleerLogin, geldigAdres, ipVan, koekje, leesJson, mailLog, openToken, verzegel } from "./lib.mjs";
import { bevestigBeheer, mailMoetWijzigen, mailWachtwoordGezet, startBeheer, zoekAccount } from "./beheer.mjs";

const DIENST = new Set(["support", "info", "ambassadeur"]);

async function postErbij(sessie, map) {
  try {
    const data = await berichten(sessie, map);
    return data.berichten || [];
  } catch {
    return [];
  }
}

function logLater(soort, local, tekst, uitslag, ip) {
  mailLog(soort, local, tekst, uitslag, ip).catch(() => {});
}

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

function mailFout(tekst) {
  const ruw = String(tekst || "");
  const dagen = ruw.match(/Current crack time:\s*(\d+)\s*days/i);
  if (/30 days to crack|crack time/i.test(ruw)) {
    return `Het wachtwoord is te makkelijk voor de mailserver. Die eist minstens 30 dagen kraaktijd. Dit wachtwoord zit op ${dagen?.[1] || "0"} dagen. Kies een lange zin van minstens vier willekeurige woorden.`;
  }
  return ruw;
}

async function portalWachtwoord(email, geheim) {
  const login = await fetch("https://ofzyqwpztohflxdhqgbb.supabase.co/auth/v1/token?grant_type=password", {
    method: "POST",
    headers: { apikey: "sb_publishable_x8nU8ype6b1KOL6K8lS2Iw_DDjz4Olr", "content-type": "application/json" },
    body: JSON.stringify({ email, password: geheim }),
  });
  return login.ok;
}

function naamAlsPostbus(meta) {
  const schoon = (waarde) => String(waarde || "").toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]+/g, "");
  const voor = schoon(meta?.voornaam);
  const achter = schoon(meta?.achternaam);
  return voor && achter ? `${voor}.${achter}` : "";
}

function zelfdePersoon(a, b) {
  if (!a || !b || a === b) return a === b && Boolean(a);
  const [voor, ...rest] = a.split(".");
  const [ander, ...rest2] = b.split(".");
  const achter = rest.join(".");
  const achter2 = rest2.join(".");
  if (!achter || achter !== achter2) return false;
  return ander === voor || ander === voor[0] || voor === ander[0];
}

async function herstelPortaal(adres, geheim) {
  if (!String(adres).endsWith("@boaportaal.nl")) return false;
  const local = adres.split("@")[0];
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (!key || !process.env.SUPABASE_URL) return { fout: "De mailserver mist de koppeling met het accountsysteem." };
  const user = await zoekAccount(local, adres);
  const email = String(user?.email || "").trim().toLowerCase();
  if (!email) return { fout: `De postbus ${adres} bestaat. Er hangt geen portaalaccount aan, dus het wachtwoord van boaportaal.nl kan hier niet gebruikt worden.` };
  if (!(await portalWachtwoord(email, geheim))) {
    return { fout: `De postbus ${adres} bestaat. Dit is niet het wachtwoord van het portaalaccount ${email}.` };
  }
  const gezet = await fetch("https://systeem.boaportaal.nl/.netlify/functions/postbus", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ local, password: geheim, domain: "boaportaal.nl" }),
  });
  const data = await gezet.json().catch(() => ({}));
  if (!gezet.ok || !data.ok) return { fout: mailFout(data.fout) || "Het wachtwoord van de postbus is niet gelijkgesteld." };
  await mailWachtwoordGezet(local);
  try {
    await controleerLogin(adres, geheim);
    return true;
  } catch (e) {
    return { fout: `Het wachtwoord van ${adres} is gelijkgesteld aan het portaal. De mailserver laat u er nog niet in. ${e?.message || "Probeer het over een minuut opnieuw."}` };
  }
}

async function herstelAmbassadeur(adres, geheim) {
  if (!String(adres).endsWith("@ambassadeur.boaportaal.nl") || geheim.length < 12) return false;
  const local = adres.split("@")[0];
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  const url = process.env.SUPABASE_URL || "";
  if (!key || !url) return { fout: "De mailserver mist de koppeling met het accountsysteem." };
  const kop = { apikey: key, authorization: `Bearer ${key}` };
  const beheer = await fetch(`${url}/rest/v1/boa_ambassadeur?mail_local=eq.${encodeURIComponent(local)}&actief=eq.true&select=email`, { headers: kop }).then((r) => r.json()).catch(() => []);
  const email = String(beheer?.[0]?.email || "").trim().toLowerCase();
  if (!email) return false;
  const login = await fetch(`${url}/auth/v1/token?grant_type=password`, {
    method: "POST",
    headers: { apikey: "sb_publishable_x8nU8ype6b1KOL6K8lS2Iw_DDjz4Olr", "content-type": "application/json" },
    body: JSON.stringify({ email, password: geheim }),
  });
  if (!login.ok) return false;
  const gezet = await fetch("https://systeem.boaportaal.nl/.netlify/functions/postbus", {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify({ local, password: geheim, domain: "ambassadeur.boaportaal.nl" }),
  });
  const data = await gezet.json().catch(() => ({}));
  if (!gezet.ok || !data.ok) return { fout: mailFout(data.fout) || "De postbus is niet aangemaakt. Het domein ambassadeur.boaportaal.nl moet bij de mailserver staan." };
  const org = await orgVan(adres);
  if (org?.slug && org.pass) {
    await fetch("https://systeem.boaportaal.nl/.netlify/functions/postbus", {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
      body: JSON.stringify({ local: org.slug, password: org.pass, domain: "ambassadeur.boaportaal.nl" }),
    }).catch(() => null);
  }
  try {
    await controleerLogin(adres, geheim);
    return true;
  } catch (e) {
    return { fout: `De postbus ${adres} staat, maar de mailserver laat u er niet in. ${e?.message || "Probeer het zo opnieuw."}` };
  }
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
      const sessie = { email: open.email, pass: nieuw, org: org?.slug || "", orgPass: org?.pass || "", orgNaam: org?.naam || "", voornaam: org?.voornaam || "", achternaam: org?.achternaam || "" };
      const token = verzegel({ ...sessie, exp: Date.now() + 12 * 60 * 60 * 1000 });
      const map = sessie.org ? "org" : "in";
      const binnen = await postErbij(sessie, map);
      logLater("MAIL_LOGIN", local, "mailwachtwoord gewijzigd", "geslaagd", ip);
      return antwoord(200, { ...profiel(open.email, org || {}), berichten: binnen, map }, { "set-cookie": koekje(token, 12 * 60 * 60) });
    }
    if (body.ticket) {
      const open = openToken(body.ticket);
      if (!open?.factorId) return antwoord(401, { fout: "De tweede stap is verlopen. Log opnieuw in." });
      const local = open.email.split("@")[0];
      const check = await bevestigBeheer(open, body.code);
      if (check.fout) {
        logLater("MAIL_LOGIN", local, "onjuiste authenticatorcode", "mislukt", ip);
        slaIp(ip, local).catch(() => {});
        return antwoord(401, { fout: check.fout });
      }
      const org = await orgVan(open.email);
      const sessie = { email: open.email, pass: open.pass, org: org?.slug || "", orgPass: org?.pass || "", orgNaam: org?.naam || "", voornaam: org?.voornaam || "", achternaam: org?.achternaam || "" };
      const token = verzegel({ ...sessie, exp: Date.now() + 12 * 60 * 60 * 1000 });
      const map = sessie.org ? "org" : "in";
      const binnen = await postErbij(sessie, map);
      logLater("MAIL_LOGIN", local, "ingelogd", "geslaagd", ip);
      return antwoord(200, { ...profiel(open.email, org || {}), berichten: binnen, map }, { "set-cookie": koekje(token, 12 * 60 * 60) });
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
    } catch (e) {
      const tekst = String(e?.message || "");
      if (/timeout|timed out|geen antwoord|Greeting never received|ECONN/i.test(tekst)) {
        return antwoord(503, { fout: "De mailserver reageerde niet. Probeer het opnieuw." });
      }
      const herstel = await herstelAmbassadeur(adres, geheim);
      const portaal = herstel === true ? true : await herstelPortaal(adres, geheim);
      if (portaal !== true) {
        await mailLog("MAIL_LOGIN", local, "wachtwoord onjuist", "mislukt", ip);
        await slaIp(ip, local);
        let fout = portaal?.fout || herstel?.fout || "Deze postbus bestaat niet, of het wachtwoord klopt niet.";
        if (herstel === false && portaal === false && adres.endsWith("@boaportaal.nl")) {
          const org = await orgVan(`${local}@ambassadeur.boaportaal.nl`);
          if (org?.slug) fout = `Dit is de medewerkerspostbus. Voor uw organisatie logt u in met ${local}@ambassadeur.boaportaal.nl.`;
        }
        return antwoord(401, { fout });
      }
    }
    const org = await orgVan(adres);
    if (org?.weiger) return antwoord(403, { fout: "Dit is de organisatiebus. Log in met uw volledige adres: voornaam.achternaam@ambassadeur.boaportaal.nl." });
    const [moet, beheerUit] = await Promise.all([
      mailMoetWijzigen(local),
      startBeheer(adres, geheim).catch(() => ({ letop: "" })),
    ]);
    if (moet) {
      const ticket = verzegel({ email: adres, pass: geheim, exp: Date.now() + 10 * 60 * 1000, ticket: true, wijzig: true });
      return antwoord(200, { stap: "wachtwoord", ticket, local });
    }
    const beheer = beheerUit || { letop: "" };
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
    const sessie = { email: adres, pass: geheim, org: org?.slug || "", orgPass: org?.pass || "", orgNaam: org?.naam || "", voornaam: org?.voornaam || "", achternaam: org?.achternaam || "" };
    const token = verzegel({ ...sessie, exp: Date.now() + 12 * 60 * 60 * 1000 });
    const map = sessie.org ? "org" : "in";
    const binnen = await postErbij(sessie, map);
    logLater("MAIL_LOGIN", local, beheer.letop ? "ingelogd zonder tweede stap" : "ingelogd", "geslaagd", ip);
    return antwoord(200, { ...profiel(adres, org || {}), letop: beheer.letop || "", berichten: binnen, map }, { "set-cookie": koekje(token, 12 * 60 * 60) });
  } catch (err) {
    if (String(err?.message || "") === "geen sleutel") {
      return antwoord(503, { fout: "De mailserver mist een sessiesleutel. Zet op de Netlify-site van mail dezelfde SUPABASE_URL en SUPABASE_SERVICE_ROLE_KEY als bij systeem, of een SESSION_SECRET van minstens 24 tekens." });
    }
    return antwoord(500, { fout: "Inloggen lukt nu niet. Probeer het opnieuw." });
  }
}
