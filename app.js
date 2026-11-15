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
let wacht = null;
let tips = [];
let tipTimer = null;
let tellers = {};
let zoek = "";

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

function mappenHtml() {
  const knop = (id, label) => {
    const n = Number(tellers[id] || 0);
    const badge = n > 0 ? `<span class="map-teller">${n > 99 ? "99+" : n}</span>` : "";
    return `<button class="mapknop ${map === id ? "aan" : ""}" data-map="${id}" type="button"><span>${label}</span>${badge}</button>`;
  };
  const gedeeld = [knop("support", "Support"), knop("info", "Info")];
  if (gebruiker.account) gedeeld.push(knop("account", "Account"));
  return `<p class="mapgroep-titel">Persoonlijk</p>
    ${knop("in", "Postvak IN")}
    <div class="submappen">
      ${knop("concepten", "Concepten")}
      ${knop("verzonden", "Verzonden")}
      ${knop("archief", "Archief")}
      ${knop("prullenbak", "Prullenbak")}
    </div>
    <p class="mapgroep-titel">Gedeeld</p>
    ${gedeeld.join("")}`;
}

function korteNaam(item) {
  return item.vanKort || String(item.van || "").replace(/<[^>]*>/g, "").trim() || item.van || "";
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
      <div><b>BOA Portaal</b><span>Voor BOA's, door BOA's</span><a href="https://boaportaal.nl">boaportaal.nl</a><a href="https://faq.boaportaal.nl">Veelgestelde vragen</a></div>
    </div>
  </div>`;
}

function formaat(bytes) {
  const n = Number(bytes) || 0;
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${Math.round(n / 1024)} kB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

async function leesBijlagen(bestanden) {
  const files = [...bestanden].filter((file) => file && file.size).slice(0, 5);
  let totaal = 0;
  const bijlagen = [];
  for (const file of files) {
    totaal += file.size;
    if (totaal > 3500000) throw new Error("De bijlagen zijn samen te groot. Maximaal 3,5 MB.");
    const data = await new Promise((resolve, reject) => {
      const lezer = new FileReader();
      lezer.onload = () => resolve(String(lezer.result || "").split(",")[1] || "");
      lezer.onerror = () => reject(new Error("De bijlage kon niet worden gelezen."));
      lezer.readAsDataURL(file);
    });
    bijlagen.push({ naam: file.name, type: file.type || "application/octet-stream", data });
  }
  return bijlagen;
}

function huidig() { return berichten.find((b) => b.id === openId) || null; }

function leegtekst() {
  if (fout) return fout;
  if (laden) return "Bezig met ophalen…";
  if (zoek.trim()) return "Niets in deze map met die zoekterm. Er worden de laatste 40 berichten doorzocht.";
  if (map === "in") return "Je privépost staat hier.";
  if (map === "concepten") return "Nog niet verzonden. Open een concept en kies Verder schrijven.";
  if (map === "archief") return "Bewaarde berichten, uit de drukte.";
  if (map === "prullenbak") return "Verwijderde berichten. Terugzetten kan nog.";
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
  else if (gedeeld && vanMij) actie = `<p class="meta"><span class="chip ok">Geclaimd door jou</span></p><div class="rij"><button class="primair smal" id="antwoord" type="button">Antwoorden</button><button class="secundair" id="unclaim" type="button">Claim loslaten</button></div>`;
  else if (gedeeld) actie = `<p class="meta"><span class="chip">Geclaimd door ${esc(b.claim.naam)}</span> Alleen die persoon antwoordt.</p>`;
  else if (map !== "verzonden" && map !== "concepten" && map !== "prullenbak" && b.vanAdres) actie = `<div class="rij"><button class="primair smal" id="antwoord" type="button">Antwoorden</button></div>`;
  const eigen = map === "in" || map === "verzonden" || map === "concepten" || map === "archief" || map === "prullenbak";
  if (eigen) {
    const knoppen = [];
    if (map === "concepten" && b.tekst != null) knoppen.push(`<button class="primair smal" id="verder" type="button">Verder schrijven</button>`);
    if (map !== "archief") knoppen.push(`<button class="secundair" data-naar="archief" type="button">Archiveren</button>`);
    if (map !== "prullenbak") knoppen.push(`<button class="secundair" data-naar="prullenbak" type="button">Prullenbak</button>`);
    if (map === "archief" || map === "prullenbak") knoppen.push(`<button class="secundair" data-naar="in" type="button">Terug naar postvak</button>`);
    if (knoppen.length) actie += `<div class="rij">${knoppen.join("")}</div>`;
  }
  const tekst = b.tekst == null ? "Bezig met openen…" : b.tekst;
  const bijlagen = (b.bijlagen || []).map((stuk) => `<li><button class="tekst" type="button" data-bijlage="${stuk.id}">${esc(stuk.naam)} · ${esc(formaat(stuk.grootte))}</button></li>`).join("");
  return `<h2>${esc(b.onderwerp)}</h2>
    <p class="meta">Van ${esc(b.van)} · aan ${esc(b.aan)} · ${esc(new Date(b.tijd).toLocaleString("nl-NL"))}</p>
    <div class="tekstblok">${esc(tekst)}</div>
    ${bijlagen ? `<ul class="bijlagen">${bijlagen}</ul>` : ""}
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
    item.bijlagen = data.bijlagen || [];
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
    <p class="sub">Je eigen postbus, op mail.boaportaal.nl. Niet op de site van de mailserver. Support en Info lees je daarna met het team.</p>
    <label>Loginnaam<input name="email" type="text" autocomplete="username" required placeholder="loginnaam" autocapitalize="none" spellcheck="false"></label>
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
      const data = await api("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ email, wachtwoord }),
      });
      if (data.stap) { wacht = data; fout = ""; teken(); return; }
      gebruiker = data;
      gebruiker.letop = data.letop || "";
      wacht = null;
      gebruiker.account = gebruiker.local === "joshua.bosma" || gebruiker.local === "beheerder";
      map = "in";
      openId = null;
      scherm = "post";
      laadTellers();
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
  const bron = scherm === "antwoord" || scherm === "verder" ? huidig() : null;
  const aan = scherm === "verder" ? (bron?.aanAdres || bron?.aan || "") : (bron?.vanAdres || "");
  const onderwerp = !bron ? "" : scherm === "verder" ? bron.onderwerp : (bron.onderwerp.startsWith("Re:") ? bron.onderwerp : `Re: ${bron.onderwerp}`);
  const tekst = scherm === "verder" ? (bron?.tekst || "") : "";
  return `<form class="opstel" id="opstel">
    <div class="kop"><h2>${scherm === "antwoord" ? "Antwoorden" : scherm === "verder" ? "Concept" : "Nieuw bericht"}</h2><button class="tekst" id="dicht" type="button">Sluiten</button></div>
    <label class="suggesties">Aan
      <input name="aan" type="text" ${scherm === "verder" ? "" : "required"} value="${esc(aan)}" placeholder="info" autocomplete="off" autocapitalize="none" spellcheck="false">
      <div class="lijstje" id="tips" hidden></div>
    </label>
    <label>Onderwerp<input name="onderwerp" ${scherm === "verder" ? "" : "required"} value="${esc(onderwerp)}"></label>
    <label>Bericht<textarea name="tekst" ${scherm === "verder" ? "" : "required"}>${esc(tekst)}</textarea></label>
    <label>Bijlagen<input name="bijlagen" type="file" multiple></label>
    <p class="sub">Bestanden meesturen mag. Samen maximaal 3,5 MB. Ontvangen bijlagen staan onder het bericht.</p>
    <p class="sub">De handtekening gaat altijd mee bij verzenden. Die staat vast, als ${esc(toonnaam(p))}. Een concept bewaart de tekst zonder handtekening.</p>
    ${handtekeningBlok(toonnaam(p))}
    <p class="fout">${esc(fout)}</p>
    <div class="rij">
      <button class="primair smal" type="submit">Verzenden</button>
      <button class="secundair" id="concept" type="button">Bewaar concept</button>
    </div>
  </form>`;
}

function instelHtml(p) {
  return `<form class="instel" id="instel">
    <div class="kop"><h2>Handtekening</h2><button class="tekst" id="dicht" type="button">Sluiten</button></div>
    <p class="sub">Elke mail krijgt dezelfde handtekening. Je kiest alleen hoe je naam er staat.</p>
    <label>Voornaam<input name="voornaam" required value="${esc(p.voornaam)}"></label>
    <label>Achternaam<input name="achternaam" value="${esc(p.achternaam)}"></label>
    <label class="vink"><input type="checkbox" name="zoek_naam" ${p.zoek_naam ? "checked" : ""}> Collega's mogen mij ook vinden op voor- en achternaam. Het adres blijft mijn Client-ID.</label>
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
  const q = zoek.trim().toLowerCase();
  const items = q ? berichten.filter((item) => `${item.van || ""} ${item.vanKort || ""} ${item.onderwerp || ""} ${item.aan || ""}`.toLowerCase().includes(q)) : berichten;
  const b = huidig();
  const p = profiel();
  document.getElementById("app").innerHTML = `<div class="app">
    <header class="balk">
      <img src="/merk.png" alt="">
      <strong>Mail</strong>
      <span class="wie">${esc(gebruiker.email)}</span>
      <div class="acties">
        <button class="primair smal" id="nieuw" type="button">Nieuw bericht</button>
        <button class="secundair" id="naar-hand" type="button">Handtekening</button>
        <button class="tekst" id="uit" type="button">Afmelden</button>
      </div>
    </header>
    ${gebruiker.letop ? `<p class="letop">${esc(gebruiker.letop)}</p>` : ""}
    <div class="werk">
      <nav class="mappen">${mappenHtml()}</nav>
      <div class="lijst">
        <div class="zoek"><input id="zoek" type="search" placeholder="Zoek in deze map" value="${esc(zoek)}"></div>
        ${items.length ? items.map((item) => `<button class="item ${item.id === openId ? "aan" : ""} ${item.gezien ? "" : "ongelezen"}" data-id="${esc(item.id)}" type="button"><strong>${item.gezien ? "" : `<i class="bol"></i>`}${esc(korteNaam(item))}</strong><em>${esc(item.onderwerp)}</em><small>${esc(new Date(item.tijd).toLocaleString("nl-NL"))}</small></button>`).join("") : `<p class="leeg" style="padding:16px;">${esc(laden ? "Bezig met ophalen…" : "Geen berichten in deze map.")}</p>`}
      </div>
      <article class="lees">${b ? berichtHtml(b) : `<p class="leeg">${esc(leegtekst())}</p>`}</article>
    </div>
    ${scherm === "nieuw" || scherm === "antwoord" || scherm === "verder" ? opstelHtml(p) : ""}
    ${scherm === "hand" ? instelHtml(p) : ""}
  </div>`;
  bind(p);
}

function bind(p) {
  document.querySelectorAll("[data-map]").forEach((knoop) => knoop.addEventListener("click", () => {
    map = knoop.dataset.map;
    openId = null;
    scherm = "post";
    zoek = "";
    fout = "";
    laad();
  }));
  document.querySelectorAll("[data-id]").forEach((knoop) => knoop.addEventListener("click", () => {
    openId = knoop.dataset.id;
    const item = huidig();
    if (item && !item.gezien) {
      item.gezien = true;
      if (tellers[map] > 0) tellers[map] -= 1;
    }
    scherm = "post";
    teken();
    vul();
  }));
  document.getElementById("nieuw")?.addEventListener("click", () => { fout = ""; scherm = "nieuw"; teken(); });
  document.getElementById("naar-hand")?.addEventListener("click", async () => {
    try {
      const data = await api("/api/adres");
      if (data.ik) {
        const huidig = profiel();
        localStorage.setItem(sleutel(), JSON.stringify({
          voornaam: data.ik.voornaam || huidig.voornaam,
          achternaam: data.ik.achternaam || huidig.achternaam,
          stijl: huidig.stijl || "voornaam",
          zoek_naam: Boolean(data.ik.zoek_naam),
        }));
      }
    } catch {}
    scherm = "hand";
    teken();
  });
  document.getElementById("uit")?.addEventListener("click", async () => {
    await api("/api/uit", { method: "POST" }).catch(() => {});
    gebruiker = null;
    berichten = [];
    openId = null;
    scherm = "post";
    teken();
  });
  document.getElementById("dicht")?.addEventListener("click", () => { scherm = "post"; fout = ""; teken(); });
  document.getElementById("unclaim")?.addEventListener("click", async () => {
    try {
      await api("/api/claim", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ map, id: openId, los: true }),
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
  document.getElementById("verder")?.addEventListener("click", () => { fout = ""; scherm = "verder"; teken(); });
  document.querySelectorAll("[data-naar]").forEach((knoop) => knoop.addEventListener("click", async () => {
    const naar = knoop.dataset.naar;
    const id = openId;
    knoop.disabled = true;
    try {
      await api("/api/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ van: map, id, naar }),
      });
      openId = null;
      fout = "";
      await laad();
      laadTellers();
    } catch (e) {
      fout = e.message;
      teken();
    }
  }));
  const zoekveld = document.getElementById("zoek");
  zoekveld?.addEventListener("input", () => {
    zoek = zoekveld.value;
    const start = zoekveld.selectionStart;
    teken();
    const opnieuw = document.getElementById("zoek");
    if (opnieuw) {
      opnieuw.focus();
      opnieuw.setSelectionRange(start, start);
    }
  });
  document.querySelectorAll("[data-bijlage]").forEach((knoop) => knoop.addEventListener("click", async () => {
    const uid = String(openId || "").split(":")[1];
    try {
      const data = await api(`/api/post?map=${encodeURIComponent(map)}&id=${encodeURIComponent(uid)}&bijlage=${encodeURIComponent(knoop.dataset.bijlage)}`);
      const bin = atob(data.data || "");
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i += 1) bytes[i] = bin.charCodeAt(i);
      const url = URL.createObjectURL(new Blob([bytes], { type: data.type || "application/octet-stream" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = data.naam || "bijlage";
      link.click();
      URL.revokeObjectURL(url);
    } catch (e) {
      fout = e.message;
      teken();
    }
  }));
  document.getElementById("opstel")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const knop = e.target.querySelector("button[type=submit]");
    knop.disabled = true;
    try {
      const bron = scherm === "antwoord" ? huidig() : null;
      const bijlagen = await leesBijlagen(e.target.bijlagen?.files || []);
      await api("/api/verstuur", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          aan: String(f.get("aan") || ""),
          onderwerp: String(f.get("onderwerp") || ""),
          tekst: String(f.get("tekst") || ""),
          bijlagen,
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
      zoek = "";
      await laad();
      laadTellers();
    } catch (err) {
      fout = err.message;
      knop.disabled = false;
      teken();
    }
  });
  document.getElementById("instel")?.addEventListener("submit", async (e) => {
    e.preventDefault();
    const f = new FormData(e.target);
    const vers = {
      voornaam: String(f.get("voornaam") || "").trim(),
      achternaam: String(f.get("achternaam") || "").trim(),
      stijl: String(f.get("stijl") || "voornaam"),
      zoek_naam: Boolean(f.get("zoek_naam")),
    };
    localStorage.setItem(sleutel(), JSON.stringify(vers));
    try {
      await api("/api/adres", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ voornaam: vers.voornaam, achternaam: vers.achternaam, zoek_naam: vers.zoek_naam }),
      });
    } catch (err) {
      fout = err.message;
    }
    scherm = "post";
    teken();
  });
  document.getElementById("concept")?.addEventListener("click", async () => {
    const formulier = document.getElementById("opstel");
    const f = new FormData(formulier);
    const knop = document.getElementById("concept");
    knop.disabled = true;
    try {
      await api("/api/map", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          actie: "concept",
          aan: String(f.get("aan") || ""),
          onderwerp: String(f.get("onderwerp") || ""),
          tekst: String(f.get("tekst") || ""),
          voornaam: profiel().voornaam,
          achternaam: profiel().achternaam,
          stijl: profiel().stijl,
        }),
      });
      fout = "";
      scherm = "post";
      map = "concepten";
      openId = null;
      zoek = "";
      await laad();
      laadTellers();
    } catch (err) {
      fout = err.message;
      knop.disabled = false;
      teken();
    }
  });
  const aanVeld = document.querySelector("#opstel [name=aan]");
  const tipBox = document.getElementById("tips");
  const toonTips = () => {
    if (!tipBox) return;
    if (!tips.length) { tipBox.hidden = true; tipBox.innerHTML = ""; return; }
    tipBox.hidden = false;
    tipBox.innerHTML = tips.map((item, i) => `<button type="button" data-tip="${i}"><strong>${esc(item.label)}</strong><em>${esc(item.adres)}</em><small>${esc(item.toelichting || "")}</small></button>`).join("");
    tipBox.querySelectorAll("[data-tip]").forEach((knoop) => knoop.addEventListener("click", () => {
      aanVeld.value = tips[Number(knoop.dataset.tip)].adres;
      tips = [];
      toonTips();
    }));
  };
  aanVeld?.addEventListener("input", () => {
    clearTimeout(tipTimer);
    const q = aanVeld.value.trim();
    if (q.length < 2) { tips = []; toonTips(); return; }
    tipTimer = setTimeout(async () => {
      try {
        const data = await api(`/api/adres?q=${encodeURIComponent(q)}`);
        tips = data.treffers || [];
        toonTips();
      } catch { tips = []; toonTips(); }
    }, 160);
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

function tekenTotp() {
  const setup = wacht.stap === "setup";
  document.getElementById("app").innerHTML = `<div class="poort"><form class="poort-kaart" id="totp">
    <div class="merkrij"><img src="/merk.png" alt=""><div><strong>BOA Portaal</strong><span>Voor BOA's, door BOA's</span></div></div>
    <h1>${setup ? "Beheer-authenticator instellen" : "Beheer-authenticator"}</h1>
    <p class="sub">${setup ? "Scan de code en noem hem BOA Beheer. Dezelfde code geldt daarna voor systeem, de behandelaar op de servicedesk en deze mail. Niet de code van boaportaal.nl." : "Vul de 6 cijfers van BOA Beheer in. Dezelfde code als op systeem en als behandelaar. Niet de code van boaportaal.nl."}</p>
    ${setup && wacht.qr ? `<img class="qr" src="${esc(wacht.qr)}" alt="QR-code voor de authenticator">` : ""}
    ${setup && wacht.secret ? `<p class="sub">Lukt scannen niet, typ dan deze sleutel: ${esc(wacht.secret)}</p>` : ""}
    <label>Code<input name="code" inputmode="numeric" autocomplete="one-time-code" required placeholder="123456"></label>
    <p class="fout">${esc(fout)}</p>
    <button class="primair" type="submit">Bevestigen</button>
    <button class="tekst" id="terug" type="button">Terug</button>
  </form></div>`;
  document.getElementById("terug").addEventListener("click", () => { wacht = null; fout = ""; teken(); });
  document.getElementById("totp").addEventListener("submit", async (e) => {
    e.preventDefault();
    const code = new FormData(e.target).get("code");
    fout = "";
    try {
      gebruiker = await api("/api/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ ticket: wacht.ticket, code }),
      });
      gebruiker.account = gebruiker.local === "joshua.bosma" || gebruiker.local === "beheerder";
      wacht = null;
      map = "in";
      openId = null;
      scherm = "post";
      laadTellers();
      await laad();
    } catch (err) {
      fout = err.message;
      teken();
    }
  });
}

function laadTellers() {
  api("/api/post?overzicht=1").then((data) => {
    tellers = data.tellers || {};
    if (gebruiker && !wacht && scherm === "post") teken();
  }).catch(() => {});
}

function teken() {
  if (wacht) tekenTotp();
  else if (!gebruiker) tekenLogin();
  else tekenPost();
}

toonFoto(foto, true);
setInterval(() => toonFoto(foto + 1, false), 8000);
api("/api/ik").then(async (ik) => {
  gebruiker = ik;
  laadTellers();
  await laad();
}).catch(() => teken());
