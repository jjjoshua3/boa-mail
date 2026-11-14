import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
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
  const geheim = process.env.SESSION_SECRET || "";
  if (geheim.length < 24) return null;
  return createHash("sha256").update(geheim).digest();
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
        </td>
      </tr></table>
    </td></tr>
  </table>`;
}

export function handtekeningTekst(naam) {
  return `\n\nMet vriendelijke groet,\n\n${schoneRegel(naam, 80)}\n\nBOA Portaal\nVoor BOA's, door BOA's\n`;
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
  if (map === "in" || map === "verzonden") return { email: sessie.email, pass: sessie.pass, mapnaam: map === "verzonden" ? "Sent" : "INBOX" };
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
    const lock = await client.getMailboxLock(gekozen.mapnaam);
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
          lijst.push({
            id: `${map}:${msg.uid}`,
            uid: msg.uid,
            van: van.tekst || bronVan || gekozen.email,
            vanAdres: van.adres || adresUit(bronVan),
            aan: aan.tekst || bronAan,
            onderwerp: msg.envelope?.subject || headerVeld(msg.source, "subject") || "(geen onderwerp)",
            tijd: msg.internalDate ? new Date(msg.internalDate).getTime() : Date.now(),
            claim: (map === "support" || map === "info") ? claimUit(msg.flags, sessie.email.split("@")[0]) : null,
          });
        }
      }
      lijst.sort((a, b) => b.tijd - a.tijd);
      return { berichten: lijst };
    } finally { lock.release(); }
  });
}

export async function bericht(sessie, map, uid) {
  const gekozen = doel(map, sessie);
  if (!gekozen || gekozen.geweigerd || gekozen.ontbreekt) return { fout: "Geen toegang.", status: 403 };
  const nummer = Number(uid);
  if (!Number.isInteger(nummer) || nummer < 1) return { fout: "Onbekend bericht.", status: 400 };
  return metPostbus(gekozen.email, gekozen.pass, async (client) => {
    const lock = await client.getMailboxLock(gekozen.mapnaam);
    try {
      const msg = await client.fetchOne(String(nummer), { source: true, flags: true }, { uid: true });
      if (!msg?.source) return { fout: "Bericht niet gevonden.", status: 404 };
      const parsed = await simpleParser(msg.source);
      const tekst = parsed.text || String(parsed.html || "").replace(/<[^>]+>/g, " ").replace(/\s+\n/g, "\n").trim();
      return {
        tekst,
        claim: (map === "support" || map === "info") ? claimUit(msg.flags, sessie.email.split("@")[0]) : null,
      };
    } finally { lock.release(); }
  });
}

export async function claim(sessie, map, uid) {
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
      return { ok: true };
    } finally { lock.release(); }
  });
}

export async function verstuur(sessie, invoer) {
  const aan = String(invoer.aan || "").trim().toLowerCase();
  const onderwerp = schoneRegel(invoer.onderwerp, 180);
  const tekst = String(invoer.tekst || "").replace(/\r/g, "").slice(0, 20000);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(aan)) return { fout: "Vul een geldig adres in.", status: 400 };
  if (!onderwerp || !tekst.trim()) return { fout: "Onderwerp en bericht zijn verplicht.", status: 400 };
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
    return { ok: true, kopie: false };
  }
  return { ok: true };
}
