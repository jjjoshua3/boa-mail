import { antwoord, dienst, leesJson, openSessie, schoneRegel } from "./lib.mjs";

const VAST = [
  { local: "info", label: "Info", toelichting: "Gedeelde postbus", voornaam: "info", achternaam: "", zoek_naam: true },
  { local: "support", label: "Support", toelichting: "Gedeelde postbus", voornaam: "support", achternaam: "", zoek_naam: true },
  { local: "account", label: "Account", toelichting: "Automatische post", voornaam: "account", achternaam: "", zoek_naam: true },
  { local: "beheerder", label: "Beheerder", toelichting: "Hoofdbeheer", voornaam: "beheer", achternaam: "beheerder", zoek_naam: true },
  { local: "joshua.bosma", label: "Joshua Bosma", toelichting: "Eigen postbus", voornaam: "joshua", achternaam: "bosma", zoek_naam: true },
];

function past(item, q) {
  if (!q) return false;
  const velden = [item.local, item.label, item.voornaam, item.achternaam, `${item.voornaam || ""} ${item.achternaam || ""}`.trim()];
  return velden.some((veld) => String(veld || "").toLowerCase().includes(q));
}

function regel(item) {
  const naam = [item.voornaam, item.achternaam].filter(Boolean).map((deel) => deel.slice(0, 1).toUpperCase() + deel.slice(1)).join(" ");
  return {
    label: naam || item.label || item.local,
    adres: `${item.local}@boaportaal.nl`,
    toelichting: item.toelichting || "Medewerker",
  };
}

export async function totpStaat(email) {
  const sb = dienst();
  const local = String(email || "").split("@")[0];
  if (!sb) return { overgeslagen: true, geheim: "", bevestigd: false, local };
  const { data, error } = await sb.from("boa_mail_totp").select("geheim, bevestigd").eq("local", local).maybeSingle();
  if (error) return { overgeslagen: true, geheim: "", bevestigd: false, local };
  return { geheim: data?.geheim || "", bevestigd: Boolean(data?.bevestigd), local };
}

export async function bewaarGeheim(local, geheim, bevestigd) {
  const sb = dienst();
  if (!sb) return { fout: "geen sleutel" };
  const { error } = await sb.from("boa_mail_totp").upsert({
    local,
    geheim,
    bevestigd,
    bijgewerkt: new Date().toISOString(),
  });
  if (error) return { fout: error.message };
  return { ok: true };
}

async function boek() {
  const sb = dienst();
  if (!sb) return [];
  const { data, error } = await sb.from("boa_mail_adres").select("local, voornaam, achternaam, zoek_naam");
  if (error || !Array.isArray(data)) return [];
  return data.map((rij) => ({
    local: rij.local,
    voornaam: rij.voornaam || "",
    achternaam: rij.achternaam || "",
    zoek_naam: Boolean(rij.zoek_naam),
    label: rij.local,
    toelichting: "Eigen postbus",
  }));
}

export async function handler(event) {
  const sessie = openSessie(event);
  if (!sessie) return antwoord(401, { fout: "Log opnieuw in." });
  const local = sessie.email.split("@")[0];
  if (event.httpMethod === "GET") {
    const q = String(event.queryStringParameters?.q || "").trim().toLowerCase().replace(/@boaportaal\.nl$/, "");
    if (!q) {
      const sb = dienst();
      let ik = { voornaam: "", achternaam: "", zoek_naam: false };
      if (sb) {
        const { data } = await sb.from("boa_mail_adres").select("voornaam, achternaam, zoek_naam").eq("local", local).maybeSingle();
        if (data) ik = { voornaam: data.voornaam || "", achternaam: data.achternaam || "", zoek_naam: Boolean(data.zoek_naam) };
      }
      return antwoord(200, { ik });
    }
    const extra = await boek();
    const gezien = new Set();
    const treffers = [];
    for (const item of [...VAST, ...extra]) {
      if (gezien.has(item.local) || !past(item, q)) continue;
      gezien.add(item.local);
      treffers.push(regel(item));
      if (treffers.length >= 8) break;
    }
    return antwoord(200, { treffers });
  }
  if (event.httpMethod !== "POST") return antwoord(405, { fout: "Niet toegestaan." });
  const sb = dienst();
  if (!sb) return antwoord(503, { fout: "Het adresboek is nog niet gekoppeld. Draai schema-0008.sql." });
  const body = leesJson(event);
  const voornaam = schoneRegel(body.voornaam, 40);
  const achternaam = schoneRegel(body.achternaam, 60);
  const zoekNaam = Boolean(body.zoek_naam);
  const { error } = await sb.from("boa_mail_adres").upsert({
    local,
    voornaam,
    achternaam,
    zoek_naam: zoekNaam,
    bijgewerkt: new Date().toISOString(),
  });
  if (error) return antwoord(500, { fout: "Opslaan lukt niet. Draai schema-0008.sql." });
  return antwoord(200, { ok: true });
}
