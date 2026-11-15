import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import { ImapFlow } from "imapflow";
import { simpleParser } from "mailparser";
import nodemailer from "nodemailer";

const DOMEIN = "boaportaal.nl";
const DIENST = new Set(["support", "info", "account"]);
const MERK = "https://boaportaal.nl/boa-mark.png";
const KOEKJE = "boa_mail";

const GEDEELD = {
  support: "support@boaportaal.nl",
  info: "info@boaportaal.nl",
  account: "account@boaportaal.nl",
};

export function antwoord(status, data, extra = {}) {
  return {
    statusCode: status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
      ...extra,
    },
    body: JSON.stringify(data),
  };
}

export function leesJson(event) {
  const ruw = event.isBase64Encoded
    ? Buffer.from(event.body || "", "base64").toString("utf8")
    : event.body || "";
  if (!ruw) return {};
  return JSON.parse(ruw);
}

function sleutel() {
  const geheim = process.env.SESSION_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY || "";
  if (geheim.length < 24) return null;
  return createHash("sha256").update(`boa-mail-sessie:${geheim}`).digest();
}

export function verzegel(sessie) {
  const key = sleutel();
  if (!key) throw new Error("geen sleutel");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const cijfer = Buffer.concat([cipher.update(JSON.stringify(sessie), "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, cijfer]).toString("base64url");
}

export function openSessie(event) {
  const key = sleutel();
  if (!key) return null;
  const kop = event.headers?.cookie || event.headers?.Cookie || "";
  const stuk = kop.split(";").map((d) => d.trim()).find((d) => d.startsWith(`${KOEKJE}=`));
  if (!stuk) return null;
  try {
    const buf = Buffer.from(decodeURIComponent(stuk.slice(KOEKJE.length + 1)), "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const cijfer = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const sessie = JSON.parse(Buffer.concat([decipher.update(cijfer), decipher.final()]).toString("utf8"));
    if (!sessie.exp || sessie.exp < Date.now()) return null;
    if (sessie.ticket) return null;
    if (!geldigAdres(sessie.email) || DIENST.has(sessie.email.split("@")[0])) return null;
    return sessie;
  } catch {
    return null;
  }
}

export function koekje(waarde, maxAge) {
  const veilig = "HttpOnly; Secure; SameSite=Lax; Path=/";
  if (!waarde) return `${KOEKJE}=; ${veilig}; Max-Age=0`;
  return `${KOEKJE}=${encodeURIComponent(waarde)}; ${veilig}; Max-Age=${maxAge}`;
}

export function geldigAdres(email) {
  return /^[a-z0-9][a-z0-9._-]{0,62}@boaportaal\.nl$/.test(String(email || ""));
}

export function schoneRegel(waarde, max = 120) {
  return String(waarde || "").replace(/[\r\n<>]/g, " ").replace(/\s+/g, " ").trim().slice(0, max);
}

function vlagVan(local) {
  return `c1${Buffer.from(local, "utf8").toString("hex")}`;
}

function localVanVlag(vlag) {
  const ruw = String(vlag || "");
  if (!/^c1[0-9a-f]+$/i.test(ruw) || (ruw.length - 2) % 2) return "";
  const tekst = Buffer.from(ruw.slice(2), "hex").toString("utf8");
  if (!/^[a-z0-9._-]{1,63}$/.test(tekst)) return "";
  return tekst;
}

function envWachtwoord(local) {
  const naam = `PURELYMAIL_${local.toUpperCase()}_PASSWORD`;
  return process.env[naam] || "";
}

const PERSOONLIJK = new Set(["in", "verzonden", "concepten", "archief", "prullenbak"]);
const STANDAARD_PAD = {
  in: "INBOX",
  verzonden: "Sent",
  concepten: "Drafts",
  archief: "Archive",
  prullenbak: "Trash",
};

function gezienUit(flags) {
  for (const vlag of flags || []) {
    if (String(vlag).toLowerCase() === "\\seen") return true;
  }
  return false;
}

function kortAdres(tekst, adres) {
  const naam = String(tekst || "").replace(/<[^>]*>/g, "").replace(/^"|"$/g, "").trim();
  if (naam && !naam.includes("@")) return naam;
  return String(adres || naam).split("@")[0] || naam || "";
}

async function padenVan(client) {
  if (client._paden) return client._paden;
  let lijst = [];
  try { lijst = await client.list(); } catch { lijst = []; }
  const uit = { ...STANDAARD_PAD };
  const speciaal = { "\\Sent": "verzonden", "\\Drafts": "concepten", "\\Archive": "archief", "\\Trash": "prullenbak" };
  const namen = {
    verzonden: ["sent", "sent items", "verzonden"],
    concepten: ["drafts", "concepten"],
    archief: ["archive", "archief"],
    prullenbak: ["trash", "prullenbak", "deleted", "deleted items"],
  };
  for (const box of lijst) {
    const sleutel = speciaal[box.specialUse];
    if (sleutel) uit[sleutel] = box.path;
  }
  for (const [sleutel, opties] of Object.entries(namen)) {
    if (lijst.some((box) => box.path === uit[sleutel])) continue;
    const gevonden = lijst.find((box) => opties.includes(String(box.path).split("/").pop().toLowerCase()));
    if (gevonden) uit[sleutel] = gevonden.path;
  }
  client._paden = uit;
  client._padlijst = lijst.map((box) => box.path);
  return uit;
}

async function padVan(client, map) {
  const paden = await padenVan(client);
  return paden[map] || STANDAARD_PAD[map] || "INBOX";
}

async function zorgPad(client, map) {
  const pad = await padVan(client, map);
  if (pad === "INBOX" || (client._padlijst || []).includes(pad)) return pad;
  try { await client.mailboxCreate(pad); } catch { /* bestaat al */ }
  client._paden = null;
  return padVan(client, map);
}

export function toonnaam(profiel, local) {
  const voor = schoneRegel(profiel?.voornaam, 40);
  const achter = schoneRegel(profiel?.achternaam, 40);
  if (profiel?.stijl === "volledig" && achter) return `${voor} ${achter}`.trim();
  return voor || local;
}

export function handtekeningHtml(naam) {
  const veilig = schoneRegel(naam, 80);
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:22px;border-collapse:collapse;">
    <tr><td style="font-family:Georgia,Palatino,serif;font-size:16px;line-height:1.4;color:#1c1917;">Met vriendelijke groet,</td></tr>
    <tr><td style="font-family:Georgia,Palatino,serif;font-size:22px;line-height:1.3;color:#0f2537;padding:8px 0 16px;">${veilig}</td></tr>
    <tr><td style="border-top:1px solid #e3d9cc;padding-top:14px;">
      <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
        <td style="padding-right:12px;vertical-align:middle;"><img src="${MERK}" width="42" height="42" alt="" style="display:block;border:0;width:42px;height:42px;"></td>
        <td style="vertical-align:middle;font-family:Segoe UI,Trebuchet MS,sans-serif;">
          <div style="font-size:12px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#0f2537;">BOA Portaal</div>
          <div style="font-family:Georgia,serif;font-style:italic;font-size:14px;color:#3d4c59;padding-top:2px;">Voor BOA's, door BOA's</div>
          <div style="padding-top:4px;font-size:13px;line-height:1.3;"><a href="https://boaportaal.nl" style="color:#0f2537;text-decoration:none;">boaportaal.nl</a></div>
        </td>
      </tr></table>
    </td></tr>
  </table>`;
}

export function handtekeningTekst(naam) {
  return `\n\nMet vriendelijke groet,\n\n${schoneRegel(naam, 80)}\n\nBOA Portaal\nVoor BOA's, door BOA's\nhttps://boaportaal.nl\n`;
}

async function metPostbus(email, pass, werk) {
  const client = new ImapFlow({
    host: "imap.purelymail.com",
    port: 993,
    secure: true,
    auth: { user: email, pass },
    logger: false,
    greetingTimeout: 12000,
    socketTimeout: 20000,
  });
  await client.connect();
  try { return await werk(client); }
  finally { await client.logout().catch(() => client.close()); }
}

export async function controleerLogin(email, pass) {
  await metPostbus(email, pass, async () => true);
}

function doel(map, sessie) {
  if (PERSOONLIJK.has(map)) return { email: sessie.email, pass: sessie.pass, persoonlijk: true, map };
  if (!GEDEELD[map]) return null;
  if (map === "account") {
    const local = sessie.email.split("@")[0];
    if (local !== "joshua.bosma" && local !== "beheerder") return { geweigerd: true };
  }
  const pass = envWachtwoord(map);
  if (!pass) return { ontbreekt: true };
  return { email: GEDEELD[map], pass, mapnaam: "INBOX" };
}

function headerVeld(bron, naam) {
  const tekst = Buffer.isBuffer(bron) ? bron.toString("utf8") : String(bron || "");
  const kop = tekst.split(/\r?\n\r?\n/)[0] || "";
  const gevouwen = kop.replace(/\r?\n[ \t]+/g, " ");
  return gevouwen.match(new RegExp(`^${naam}:\\s*(.*)$`, "im"))?.[1]?.trim() || "";
}

function adresUit(tekst) {
  const bron = String(tekst || "");
  const tussen = bron.match(/<([^>]+)>/);
  const kandidaat = (tussen ? tussen[1] : bron).trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+$/.test(kandidaat) ? kandidaat : "";
}
function adresVan(lijst) {
  if (!lijst?.length) return { tekst: "", adres: "" };
  const eerste = lijst[0];
  const adres = eerste.address || "";
  const tekst = lijst.map((a) => a.name ? `${a.name} <${a.address}>` : a.address).filter(Boolean).join(", ");
  return { tekst, adres };
}

function claimsUit(flags) {
  const locals = [];
  for (const vlag of flags || []) {
    const gevonden = localVanVlag(String(vlag));
    if (gevonden && !locals.includes(gevonden)) locals.push(gevonden);
  }
  return locals;
}

function claimUit(flags, eigen) {
  const locals = claimsUit(flags);
  if (!locals.length) return null;
  const ander = locals.find((local) => local !== eigen);
  if (ander && locals.includes(eigen)) return { local: ander, naam: ander, vanMij: false };
  const local = locals[0];
  return { local, naam: local, vanMij: local === eigen };
}

export async function berichten(sessie, map) {
  const gekozen = doel(map, sessie);
  if (!gekozen) return { fout: "Onbekende map.", status: 400 };
  if (gekozen.geweigerd) return { fout: "Alleen Joshua en de beheerder zien Account.", status: 403 };
  if (gekozen.ontbreekt) return { fout: "Deze gedeelde postbus is nog niet gekoppeld.", status: 503 };
  return metPostbus(gekozen.email, gekozen.pass, async (client) => {
    const pad = gekozen.mapnaam || await padVan(client, map);
    let lock;
    try { lock = await client.getMailboxLock(pad); }
    catch { return { berichten: [] }; }
    try {
      const uids = await client.search({ all: true }, { uid: true });
      const laatste = (uids || []).slice(-40);
      const lijst = [];
      if (laatste.length) {
        for await (const msg of client.fetch(laatste.join(","), { uid: true, envelope: true, flags: true, internalDate: true, source: { start: 0, maxLength: 8192 } }, { uid: true })) {
          const van = adresVan(msg.envelope?.from);
          const aan = adresVan(msg.envelope?.to);
          const bronVan = headerVeld(msg.source, "from");
          const bronAan = headerVeld(msg.source, "to");
          const vanTekst = van.tekst || bronVan || gekozen.email;
          const vanAdres = van.adres || adresUit(bronVan);
          const aanTekst = aan.tekst || bronAan;
          lijst.push({
            id: `${map}:${msg.uid}`,
            uid: msg.uid,
            van: vanTekst,
            vanAdres,
            vanKort: kortAdres(vanTekst, vanAdres),
            aan: aanTekst,
            aanAdres: aan.adres || adresUit(bronAan),
            onderwerp: msg.envelope?.subject || headerVeld(msg.source, "subject") || "(geen onderwerp)",
            tijd: msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
            gezien: gezienUit(msg.flags),
            claim: (map === "support" || map === "info") ? claimUit(msg.flags, sessie.email.split("@")[0]) : null,
          });
        }
      }
      lijst.sort((a, b) => b.tijd - a.tijd);
      return { berichten: lijst };
    } finally { lock.release(); }
  });
}

function bijlagenVan(parsed) {
  return (parsed.attachments || []).filter((stuk) => stuk.filename || stuk.contentDisposition === "attachment");
}

function schoonBestand(naam, index) {
  const basis = String(naam || `bijlage-${index + 1}`).split(/[/\\]/).pop().replace(/[^\w.\- ()]/g, "_").slice(0, 120);
  return basis || `bijlage-${index + 1}`;
}

export async function bericht(sessie, map, uid, bijlage) {
  const gekozen = doel(map, sessie);
  if (!gekozen || gekozen.geweigerd || gekozen.ontbreekt) return { fout: "Geen toegang.", status: 403 };
  const nummer = Number(uid);
  if (!Number.isInteger(nummer) || nummer < 1) return { fout: "Onbekend bericht.", status: 400 };
  return metPostbus(gekozen.email, gekozen.pass, async (client) => {
    const pad = gekozen.mapnaam || await padVan(client, map);
    let lock;
    try { lock = await client.getMailboxLock(pad); }
    catch { return { fout: "Deze map bestaat nog niet.", status: 404 }; }
    try {
      const msg = await client.fetchOne(String(nummer), { source: true, flags: true }, { uid: true });
      if (!msg?.source) return { fout: "Bericht niet gevonden.", status: 404 };
      if (!gezienUit(msg.flags)) {
        await client.messageFlagsAdd(String(nummer), ["\\Seen"], { uid: true }).catch(() => {});
      }
      const parsed = await simpleParser(msg.source);
      const alle = bijlagenVan(parsed);
      if (bijlage !== undefined && bijlage !== null && bijlage !== "") {
        const index = Number(bijlage);
        const stuk = alle[index];
        if (!stuk?.content) return { fout: "Bijlage niet gevonden.", status: 404 };
        return {
          naam: schoonBestand(stuk.filename, index),
          type: stuk.contentType || "application/octet-stream",
          data: stuk.content.toString("base64"),
        };
      }
      const tekst = parsed.text || String(parsed.html || "").replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n").trim();
      return {
        tekst,
        bijlagen: alle.map((stuk, index) => ({
          id: index,
          naam: schoonBestand(stuk.filename, index),
          type: stuk.contentType || "application/octet-stream",
          grootte: stuk.size || stuk.content?.length || 0,
        })),
        claim: (map === "support" || map === "info") ? claimUit(msg.flags, sessie.email.split("@")[0]) : null,
      };
    } finally { lock.release(); }
  });
}

export async function claim(sessie, map, uid, los = false, ip = "") {
  if (map !== "support" && map !== "info") return { fout: "Alleen Support en Info claim je.", status: 400 };
  const gekozen = doel(map, sessie);
  if (!gekozen || gekozen.ontbreekt) return { fout: "Deze gedeelde postbus is nog niet gekoppeld.", status: 503 };
  const nummer = Number(uid);
  const local = sessie.email.split("@")[0];
  return metPostbus(gekozen.email, gekozen.pass, async (client) => {
    const lock = await client.getMailboxLock("INBOX");
    try {
      const msg = await client.fetchOne(String(nummer), { flags: true }, { uid: true });
      if (!msg) return { fout: "Bericht niet gevonden.", status: 404 };
      const bestaand = claimUit(msg.flags, local);
      if (los) {
        if (!bestaand?.vanMij) return { fout: "Je kunt alleen je eigen claim loslaten.", status: 403 };
        await client.messageFlagsRemove(String(nummer), [vlagVan(local)], { uid: true });
        await mailLog("MAIL_UNCLAIM", local, `${map} losgelaten`, "geslaagd", ip);
        return { ok: true };
      }
      if (bestaand && !bestaand.vanMij) return { fout: `Al geclaimd door ${bestaand.local}.`, status: 409 };
      if (!bestaand) {
        await client.messageFlagsAdd(String(nummer), [vlagVan(local)], { uid: true });
        const na = await client.fetchOne(String(nummer), { flags: true }, { uid: true });
        const opnieuw = claimUit(na?.flags, local);
        if (opnieuw && !opnieuw.vanMij) {
          await client.messageFlagsRemove(String(nummer), [vlagVan(local)], { uid: true });
          return { fout: `Al geclaimd door ${opnieuw.local}.`, status: 409 };
        }
      }
      await mailLog("MAIL_CLAIM", local, `${map} geclaimd`, "geslaagd", ip);
      return { ok: true };
    } finally { lock.release(); }
  });
}

export async function verstuur(sessie, invoer) {
  let aan = String(invoer.aan || "").trim().toLowerCase();
  if (aan && !aan.includes("@")) aan = `${aan}@boaportaal.nl`;
  const onderwerp = schoneRegel(invoer.onderwerp, 180);
  const tekst = String(invoer.tekst || "").replace(/\r/g, "").slice(0, 20000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(aan)) return { fout: "Vul een geldig adres in.", status: 400 };
  if (!onderwerp || !tekst.trim()) return { fout: "Onderwerp en bericht zijn verplicht.", status: 400 };
  const bijlagen = Array.isArray(invoer.bijlagen) ? invoer.bijlagen.slice(0, 5) : [];
  const attachments = [];
  let totaal = 0;
  for (const stuk of bijlagen) {
    const buf = Buffer.from(String(stuk?.data || ""), "base64");
    if (!buf.length) continue;
    totaal += buf.length;
    if (totaal > 3_500_000) return { fout: "De bijlagen zijn samen te groot. Maximaal 3,5 MB.", status: 400 };
    attachments.push({
      filename: schoonBestand(stuk.naam, attachments.length),
      content: buf,
      contentType: String(stuk.type || "application/octet-stream").slice(0, 120),
    });
  }
  const local = sessie.email.split("@")[0];
  const naam = toonnaam(invoer, local);
  const bronMap = String(invoer.bronMap || "");
  if ((bronMap === "support" || bronMap === "info") && invoer.bronId) {
    const uid = String(invoer.bronId).split(":")[1];
    const huidig = await bericht(sessie, bronMap, uid);
    if (huidig.fout) return huidig;
    if (!huidig.claim?.vanMij) return { fout: "Claim het bericht eerst. Daarna kun jij als enige antwoorden.", status: 403 };
  }
  const mail = {
    from: { name: naam, address: sessie.email },
    to: aan,
    subject: onderwerp,
    text: `${tekst.trim()}${handtekeningTekst(naam)}`,
    html: `<div style="font-family:Segoe UI,Trebuchet MS,sans-serif;font-size:15px;line-height:1.55;color:#1c1917;">${tekst.trim().replace(/&/g, "&" + "amp;").replace(/</g, "&" + "lt;").replace(/>/g, "&" + "gt;").replace(/\n/g, "<br>")}</div>${handtekeningHtml(naam)}`,
    attachments,
  };
  if (bronMap === "support" || bronMap === "info") mail.bcc = GEDEELD[bronMap];
  const smtp = nodemailer.createTransport({
    host: "smtp.purelymail.com",
    port: 465,
    secure: true,
    auth: { user: sessie.email, pass: sessie.pass },
  });
  await smtp.sendMail(mail);
  try {
    const ruw = await new Promise((resolve, reject) => {
      const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
      stream.sendMail(mail, (err, info) => (err ? reject(err) : resolve(info.message)));
    });
    await metPostbus(sessie.email, sessie.pass, async (client) => {
      await client.append("Sent", ruw, ["\\Seen"]);
    });
  } catch {
    await mailLog("MAIL_VERZONDEN", local, `naar ${aan}`, "geslaagd", invoer.ip || "");
    return { ok: true, kopie: false };
  }
  await mailLog("MAIL_VERZONDEN", local, `naar ${aan}`, "geslaagd", invoer.ip || "");
  return { ok: true };
}

export async function tellers(sessie) {
  const uit = {};
  const local = sessie.email.split("@")[0];
  try {
    await metPostbus(sessie.email, sessie.pass, async (client) => {
      const paden = await padenVan(client);
      for (const id of PERSOONLIJK) {
        try {
          const st = await client.status(paden[id], { unseen: true });
          uit[id] = st.unseen || 0;
        } catch { uit[id] = 0; }
      }
    });
  } catch { /* tellers blijven leeg */ }
  const gedeeld = ["support", "info"];
  if (local === "joshua.bosma" || local === "beheerder") gedeeld.push("account");
  await Promise.all(gedeeld.map(async (id) => {
    const pass = envWachtwoord(id);
    if (!pass) return;
    try {
      await metPostbus(GEDEELD[id], pass, async (client) => {
        const st = await client.status("INBOX", { unseen: true });
        uit[id] = st.unseen || 0;
      });
    } catch { uit[id] = 0; }
  }));
  return { tellers: uit };
}

export async function verplaats(sessie, van, uid, naar) {
  if (!PERSOONLIJK.has(van) || !PERSOONLIJK.has(naar) || van === naar) {
    return { fout: "Alleen je eigen post verplaats je, tussen Postvak IN, Concepten, Verzonden, Archief en Prullenbak.", status: 400 };
  }
  const nummer = Number(String(uid).split(":").pop());
  if (!Number.isInteger(nummer) || nummer < 1) return { fout: "Onbekend bericht.", status: 400 };
  return metPostbus(sessie.email, sessie.pass, async (client) => {
    const bron = await padVan(client, van);
    const doelpad = await zorgPad(client, naar);
    const lock = await client.getMailboxLock(bron);
    try {
      const weg = await client.messageMove(String(nummer), doelpad, { uid: true });
      if (!weg) return { fout: "Verplaatsen lukte niet.", status: 502 };
      return { ok: true };
    } finally { lock.release(); }
  });
}

export async function bewaarConcept(sessie, invoer) {
  let aan = String(invoer.aan || "").trim().toLowerCase();
  if (aan && !aan.includes("@")) aan = `${aan}@boaportaal.nl`;
  if (aan && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(aan)) return { fout: "Dat adres klopt niet.", status: 400 };
  const onderwerp = schoneRegel(invoer.onderwerp, 180) || "(concept)";
  const tekst = String(invoer.tekst || "").replace(/\r/g, "").slice(0, 20000);
  const local = sessie.email.split("@")[0];
  const naam = toonnaam(invoer, local);
  const mail = {
    from: { name: naam, address: sessie.email },
    to: aan || sessie.email,
    subject: onderwerp,
    text: tekst,
  };
  const ruw = await new Promise((resolve, reject) => {
    const stream = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: "windows" });
    stream.sendMail(mail, (err, info) => (err ? reject(err) : resolve(info.message)));
  });
  await metPostbus(sessie.email, sessie.pass, async (client) => {
    const pad = await zorgPad(client, "concepten");
    await client.append(pad, ruw, ["\\Draft"]);
  });
  return { ok: true };
}

export function dienst() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

export function ipVan(event) {
  const koppen = event.headers || {};
  const lees = (naam) => {
    const sleutel = Object.keys(koppen).find((k) => k.toLowerCase() === naam);
    return sleutel ? String(koppen[sleutel] || "") : "";
  };
  return lees("x-nf-client-connection-ip") || lees("cf-connecting-ip") || lees("x-forwarded-for").split(",")[0].trim();
}

export function openToken(token) {
  const key = sleutel();
  if (!key || !token) return null;
  try {
    const buf = Buffer.from(String(token), "base64url");
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const cijfer = buf.subarray(28);
    const decipher = createDecipheriv("aes-256-gcm", key, iv);
    decipher.setAuthTag(tag);
    const sessie = JSON.parse(Buffer.concat([decipher.update(cijfer), decipher.final()]).toString("utf8"));
    if (!sessie.exp || sessie.exp < Date.now() || !sessie.ticket) return null;
    if (!geldigAdres(sessie.email)) return null;
    return sessie;
  } catch {
    return null;
  }
}

export async function mailLog(soort, local, reden, resultaat, ip) {
  const sb = dienst();
  if (!sb) return { fout: "geen sleutel" };
  const naam = String(local || "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9._-]{0,62}$/.test(naam)) return { fout: "onbekende postbus" };
  const cid = /^bp-[0-9]{4}-[a-z]{2}$/.test(naam) ? naam.toUpperCase() : naam;
  const soortNorm = String(soort || "").trim().toUpperCase();
  const ipSchoon = String(ip || "").replace(/[^0-9a-fA-F:.]/g, "").slice(0, 64);
  if (soortNorm === "MAIL_LOGIN") {
    let user_id = null;
    let pv_naam = "";
    if (/^BP-/.test(cid)) {
      const { data } = await sb.from("boa_identiteit").select("user_id, pv_naam").eq("client_id", cid).maybeSingle();
      if (data) {
        user_id = data.user_id ?? null;
        pv_naam = data.pv_naam || "";
      }
    }
    const uitkomst = String(resultaat || "").toLowerCase() === "geslaagd" ? "geslaagd" : "mislukt";
    const { error } = await sb.from("boa_inlog").insert({
      user_id,
      client_id: cid,
      pv_naam,
      bron: "mail",
      resultaat: uitkomst,
      ip: ipSchoon,
    });
    if (error) return { fout: error.message };
    return { ok: true };
  }
  if (!["MAIL_VERZONDEN", "MAIL_CLAIM", "MAIL_UNCLAIM"].includes(soortNorm)) return { fout: "onbekende soort" };
  const { error } = await sb.from("boa_audit").insert({
    beheerder_id: cid,
    beheerder_naam: naam,
    doel_client_id: "",
    doel_pv_naam: "",
    ticketnummer: "",
    reden: String(reden || "").slice(0, 240),
    soort: soortNorm,
    niveau: "INFO",
    bron: "mail",
  });
  if (error) return { fout: error.message };
  return { ok: true };
}
