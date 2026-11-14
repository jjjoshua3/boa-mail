const FOTOS = [
  ["achtergronden/dam.jpg", "Dam"],
  ["achtergronden/fiets.jpg", "Fiets"],
  ["achtergronden/trio.jpg", "Straat"],
  ["achtergronden/rug.jpg", "Rug"],
  ["achtergronden/vest.jpg", "Vest"],
  ["achtergronden/steeg.jpg", "Steeg"],
  ["achtergronden/metro.jpg", "Station"],
  ["achtergronden/portret.jpg", "Portret"],
];

let foto = (Number(localStorage.getItem("boa-mail-foto") || -1) + 1) % FOTOS.length;
let laag = 0;
let gebruiker = null;
let map = "in";
let openId = null;
let scherm = "post";
let fout = "";
let laden = false;
let berichten = [];

function esc(v) {
  return String(v ?? "").replace(/[&<>"']/g, (c) => {
    if (c === "&") return "&" + "amp;";
    if (c === "<") return "&" + "lt;";
    if (c === ">") return "&" + "gt;";
    if (c === '"') return "&" + "quot;";
    return "&" + "#39;";
  });
}

function sleutel() { return `boa-mail-profiel:${gebruiker.local}`; }
function profiel() {
  try { return JSON.parse(localStorage.getItem(sleutel())) || raden(gebruiker.local); }
  catch { return raden(gebruiker.local); }
}
function raden(local) {
  const stuk = local.split(".");
  const mooi = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : "");
  if (stuk.length >= 2 && !/^bp-/i.test(local)) {
    return { voornaam: mooi(stuk[0]), achternaam: mooi(stuk.slice(1).join(" ")), stijl: "volledig" };
  }
  return { voornaam: mooi(local.replace(/-/g, " ")), achternaam: "", stijl: "voornaam" };
}
function toonnaam(p) {
  const voor = (p.voornaam || "").trim();
  const achter = (p.achternaam || "").trim();
  if (p.stijl === "volledig" && achter) return `${voor} ${achter}`.trim();
  return voor || gebruiker.local;
}

async function api(pad, opt = {}) {
  const r = await fetch(pad, { credentials: "same-origin", ...opt });
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.fout || "Mislukt");
  return data;
}

function mappen() {
  const basis = [["in", "Postvak IN"], ["support", "Support"], ["info", "Info"]];
  if (gebruiker.account) basis.push(["account", "Account"]);
  basis.push(["verzonden", "Verzonden"]);
  return basis;
}

function toonFoto(index, direct) {
  foto = (index + FOTOS.length) % FOTOS.length;
  localStorage.setItem("boa-mail-foto", String(foto));
  const doel = laag === 0 ? "foto-b" : "foto-a";
  const weg = laag === 0 ? "foto-a" : "foto-b";
  const el = document.getElementById(doel);
  el.style.backgroundImage = `url("${FOTOS[foto][0]}")`;
  if (direct) {
    document.getElementById("foto-a").style.backgroundImage = `url("${FOTOS[foto][0]}")`;
    document.getElementById("foto-b").classList.add("uit");
    document.getElementById("foto-a").classList.remove("uit");
    laag = 0;
    return;
  }
  el.classList.remove("uit");
  document.getElementById(weg).classList.add("uit");
  laag = laag === 0 ? 1 : 0;
}

function stippen() {
  return `<div class="stippen">${FOTOS.map((f, i) => `<button class="stip ${i === foto ? "aan" : ""}" data-foto="${i}" type="button" aria-label="${esc(f[1])}"></button>`).join("")}</div>`;
}

function handtekeningBlok(naam) {
  return `<div class="hand">
    <p class="groet">Met vriendelijke groet,</p>
    <p class="naam">${esc(naam)}</p>
    <div class="slot">
      <img src="/merk.png" alt="">
      <div><b>BOA Portaal</b><span>Voor BOA's, door BOA's</span></div>
    </div>
  </div>`;
}

function huidig() { return berichten.find((b) => b.id === openId) || null; }

function leegtekst() {
  if (fout) return fout;
  if (laden) return "Bezig met ophalen…";
  if (map === "in") return "Je privépost staat hier.";
  if (map === "support" || map === "info") return "Binnenkomende post op dit adres ziet het hele team. Claim een bericht voordat je antwoordt, zodat niet iedereen tegelijk terugmailt.";
  if (map === "account") return "Automatische post van account@ komt bij Joshua binnen. De andere medewerkers zien deze map niet.";
  return "Verzonden berichten, met de handtekening eronder.";
}

function berichtHtml(b) {
  const gedeeld = map === "support" || map === "info";
  const geclaimd = Boolean(b.claim);
  const vanMij = b.claim && b.claim.vanMij;
  let actie = "";
  if (gedeeld && !geclaimd) actie = `<div class="rij"><button class="primair smal" id="claim" type="button">Claim</button></div>`;
  else if (gedeeld && vanMij) actie = `<p class="meta"><span class="chip ok">Geclaimd door jou</span></p><div class="rij"><button class="primair smal" id="antwoord" type="button">Antwoorden</button></div>`;
  else if (gedeeld) actie = `<p class="meta"><span class="chip">Geclaimd door ${esc(b.claim.naam)}</span> Alleen die persoon antwoordt.</p>`;
  else if (map !== "verzonden" && b.vanAdres) actie = `<div class="rij"><button class="primair smal" id="antwoord" type="button">Antwoorden</button></div>`;
  const tekst = b.tekst == null ? "Bezig met openen…" : b.tekst;
  return `<h2>${esc(b.onderwerp)}</h2>
    <p class="meta">Van ${esc(b.van)} · aan ${esc(b.aan)} · ${esc(new Date(b.tijd).toLocaleString("nl-NL"))}</p>
    <div class="tekstblok">${esc(tekst)}</div>
    ${actie}`;
}

async function laad() {
  laden = true;
  const gekozen = openId;
  teken();
  try {
    const data = await api(`/api/post?map=${encodeURIComponent(map)}`);
    berichten = data.berichten || [];
    fout = "";
  } catch (e) {
    berichten = [];
    fout = e.message;
  }
  laden = false;
  if (!berichten.some((b) => b.id === gekozen)) openId = null;
  teken();
  if (openId) vul();
}

async function vul() {
  const id = openId;
  const item = huidig();
  if (!item || item.tekst != null) return;
  const uid = id.split(":")[1];
  try {
    const data = await api(`/api/post?map=${encodeURIComponent(map)}&id=${encodeURIComponent(uid)}`);
    if (openId !== id) return;
    item.tekst = data.tekst || "";
    if (data.claim) item.claim = data.claim;
    teken();
  } catch (e) {
    if (openId !== id) return;
    item.tekst = e.message;
    teken();
  }
}

function tekenLogin() {
  document.getElementById("app").innerHTML = `<div class="poort"><form class="poort-kaart" id="inlog">
    <div class="merkrij"><img src="/merk.png" alt=""><div><strong>BOA Portaal</strong><span>Voor BOA's, door BOA's</span></div></div>
    <h1>Mail</h1>
    <p class="sub">Je eigen postbus. Support en Info lees je met het hele team.</p>
    <label>Adres<input name="email" type="email" autocomplete="username" required placeholder="joshua.bosma@boaportaal.nl"></label>
    <label>Wachtwoord<input name="wachtwoord" type="password" autocomplete="current-password" required></label>
    <p class="fout">${esc(fout)}</p>
    <button class="primair" type="submit">Inloggen</button>
    ${stippen()}
  </form></div>`;
  document.getElementById("inlog").addEventListener("submit", async (e) => {
    e.preventDefault();
    const formulier = new FormData(e.target);
    const email = String(formulier.get("email") || "").trim().toLowerCase();
    const wachtwoord = String(formulier.get("wachtwoord") || "");
    fout = "";
    teken();
    try {
      gebruiker = await api("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, wachtwoord }),
      });
      gebruiker.account = gebruiker.local === "joshua.bosma" || gebruiker.local === "beheerder";
      map = "in";
      openId = null;
      scherm = "post";
      await laad();
    } catch (err) {
      gebruiker = null;
      fout = err.message;
      teken();
    }
  });
  document.querySelectorAll("[data-foto]").forEach((knoop) => {
    knoop.addEventListener("click", () => toonFoto(Number(knoop.dataset.foto), true));
  });
}

function opstelHtml(p) {
  const bron = scherm === "antwoord" ? huidig() : null;
  const aan = bron?.vanAdres || "";
  const onderwerp = bron ? (bron.onderwerp.startsWith("Re:") ? bron.onderwerp : `Re: ${bron.onderwerp}`) : "";
  return `<form class="opstel" id="opstel">
    <div class="kop"><h2>${scherm === "antwoord" ? "Antwoorden" : "Nieuw bericht"}</h2><button class="tekst" id="dicht" type="button">Sluiten</button></div>
    <label>Aan<input name="aan" type="email" required value="${esc(aan)}"></label>
    <label>Onderwerp<input name="onderwerp" required value="${esc(onderwerp)}"></label>
    <label>Bericht<textarea name="tekst" required></textarea></label>
    <p class="sub">De handtekening gaat altijd mee. Die staat vast, als ${esc(toonnaam(p))}.</p>
    ${handtekeningBlok(toonnaam(p))}
    <p class="fout">${esc(fout)}</p>
    <button class="primair" type="submit">Verzenden</button>
  </form>`;
}

function instelHtml(p) {
  return `<form class="instel" id="instel">
    <div class="kop"><h2>Handtekening</h2><button class="tekst" id="dicht" type="button">Sluiten</button></div>
    <p class="sub">Elke mail krijgt dezelfde handtekening. Je kiest alleen hoe je naam er staat.</p>
    <label>Voornaam<input name="voornaam" required value="${esc(p.voornaam)}"></label>
    <label>Achternaam<input name="achternaam" value="${esc(p.achternaam)}"></label>
    <div class="keuze">
      <button class="secundair ${p.stijl !== "volledig" ? "aan" : ""}" type="button" data-stijl="voornaam">Alleen voornaam</button>
      <button class="secundair ${p.stijl === "volledig" ? "aan" : ""}" type="button" data-stijl="volledig">Voornaam en achternaam</button>
    </div>
    <input type="hidden" name="stijl" value="${esc(p.stijl || "voornaam")}">
    ${handtekeningBlok(toonnaam(p))}
    <button class="primair" type="submit">Bewaren</button>
  </form>`;
}

function tekenPost() {
  const items = berichten;
  const b = huidig();
  const p = profiel();
  document.getElementById("app").innerHTML = `<div class="app">
    <header class="balk">
      <img src="/merk.png" alt="">
      <strong>Mail</strong>
      <span class="wie">${esc(gebruiker.email)}</span>
      <div class="acties">
        <button class="secundair" id="nieuw" type="button">Nieuw bericht</button>
        <button class="secundair" id="naar-hand" type="button">Handtekening</button>
        <button class="tekst" id="uit" type="button">Afmelden</button>
      </div>
    </header>
    <div class="werk">
      <nav class="mappen">${mappen().map(([id, label]) => `<button class="mapknop ${map === id ? "aan" : ""}" data-map="${id}" type="button">${label}</button>`).join("")}</nav>
      <div class="lijst">${items.length ? items.map((item) => `<button class="item ${item.id === openId ? "aan" : ""}" data-id="${esc(item.id)}" type="button"><strong>${esc(item.van)}</strong><em>${esc(item.onderwerp)}</em><small>${esc(new Date(item.tijd).toLocaleString("nl-NL"))}</small></button>`).join("") : `<p class="leeg" style="padding:16px;">${esc(laden ? "Bezig met ophalen…" : "Geen berichten in deze map.")}</p>`}</div>
      <article class="lees">${b ? berichtHtml(b) : `<p class="leeg">${esc(leegtekst())}</p>`}</article>
    </div>
    ${scherm === "nieuw" || scherm === "antwoord" ? opstelHtml(p) : ""}
    ${scherm === "hand" ? instelHtml(p) : ""}
  </div>`;
  bind(p);
}

function bind(p) {
  document.querySelectorAll("[data-map]").forEach((knoop) => knoop.addEventListener("click", () => {
    map = knoop.dataset.map;
    openId = null;
    scherm = "post";
    fout = "";
    laad();
  }));
  document.querySelectorAll("[data-id]").forEach((knoop) => knoop.addEventListener("click", () => {
    openId = knoop.dataset.id;
    scherm = "post";
    teken();
    vul();
  }));
  document.getElementById("nieuw")?.addEventListener("click", () => { fout = ""; scherm = "nieuw"; teken(); });
  document.getElementById("naar-hand")?.addEventListener("click", () => { scherm = "hand"; teken(); });
  document.getElementById("uit")?.addEventListener("click", async () => {
    await api("/api/uit", { method: "POST" }).catch(() => {});
    gebruiker = null;
    berichten = [];
    openId = null;
    scherm = "post";
    teken();
  });
  document.getElementById("dicht")?.addEventListener("click", () => { scherm = "post"; fout = ""; teken(); });
  document.getElementById("claim")?.addEventListener("click", async () => {
    try {
      await api("/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ map, id: openId }),
      });
      const id = openId;
      await laad();
      openId = id;
      teken();
      vul();
    } catch (e) {
      fout = e.message;
      teken();
    }
  });
  document.getElementById("antwoord")?.addEventListener("click", () => { fout = ""; scherm = "antwoord"; teken(); });
  document.getElementById("opstel")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const knop = e.target.querySelector("button[type=submit]");
    knop.disabled = true;
    try {
      const bron = scherm === "antwoord" ? huidig() : null;
      await api("/api/verstuur", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          aan: String(f.get("aan") || ""),
          onderwerp: String(f.get("onderwerp") || ""),
          tekst: String(f.get("tekst") || ""),
          voornaam: profiel().voornaam,
          achternaam: profiel().achternaam,
          stijl: profiel().stijl,
          bronMap: bron ? map : "",
          bronId: bron ? bron.id : "",
        }),
      });
      fout = "";
      scherm = "post";
      map = "verzonden";
      openId = null;
      await laad();
    } catch (err) {
      fout = err.message;
      knop.disabled = false;
      teken();
    }
  });
  document.getElementById("instel")?.addEventListener("submit", (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    localStorage.setItem(sleutel(), JSON.stringify({
      voornaam: String(f.get("voornaam") || "").trim(),
      achternaam: String(f.get("achternaam") || "").trim(),
      stijl: String(f.get("stijl") || "voornaam"),
    }));
    scherm = "post";
    teken();
  });
  document.querySelectorAll("[data-stijl]").forEach((knoop) => knoop.addEventListener("click", () => {
    const vers = {
      voornaam: document.querySelector("#instel [name=voornaam]").value,
      achternaam: document.querySelector("#instel [name=achternaam]").value,
      stijl: knoop.dataset.stijl,
    };
    localStorage.setItem(sleutel(), JSON.stringify(vers));
    teken();
  }));
}

function teken() {
  if (!gebruiker) tekenLogin();
  else tekenPost();
}

toonFoto(foto, true);
setInterval(() => toonFoto(foto + 1, false), 8000);
api("/api/ik").then(async (ik) => {
  gebruiker = ik;
  await laad();
}).catch(() => teken());
