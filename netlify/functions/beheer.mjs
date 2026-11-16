import { createClient } from "@supabase/supabase-js";
import { dienst } from "./lib.mjs";

const PUB = "sb_publishable_x8nU8ype6b1KOL6K8lS2Iw_DDjz4Olr";

function gebruikerClient() {
  const url = process.env.SUPABASE_URL;
  if (!url) return null;
  return createClient(url, PUB, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function alleGebruikers() {
  const admin = dienst();
  if (!admin) return [];
  const lijst = [];
  for (let page = 1; page <= 20; page += 1) {
    const { data, error } = await admin.auth.admin.listUsers({ page, perPage: 200 });
    if (error || !data?.users?.length) break;
    lijst.push(...data.users);
    if (data.users.length < 200) break;
  }
  return lijst;
}

async function vindGebruiker(local, adres) {
  const admin = dienst();
  if (!admin) return null;
  const users = await alleGebruikers();
  const norm = (waarde) => String(waarde || "").trim().toLowerCase();
  const direct = users.find((user) => {
    const mail = norm(user.email);
    const meta = user.user_metadata || {};
    return mail === adres || norm(meta.mail_local) === local || norm(meta.client_id) === local || mail.split("@")[0] === local;
  });
  if (direct?.email) return { email: direct.email };
  if (local !== "joshua.bosma" && local !== "beheerder") return null;
  const beheerders = users.filter((user) => norm(user.user_metadata?.rol) === "beheerder");
  if (beheerders.length !== 1 || !beheerders[0].email) return null;
  const een = beheerders[0];
  const meta = een.user_metadata || {};
  if (norm(meta.mail_local) !== local) {
    await admin.auth.admin.updateUserById(een.id, { user_metadata: { ...meta, mail_local: local } });
  }
  return { email: een.email };
}

export async function mailMoetWijzigen(local) {
  const admin = dienst();
  if (!admin) return false;
  const users = await alleGebruikers();
  const naam = String(local || "").trim().toLowerCase();
  const user = users.find((item) => {
    const meta = item.user_metadata || {};
    const mail = String(item.email || "").toLowerCase();
    return String(meta.mail_local || "").toLowerCase() === naam || String(meta.client_id || "").toLowerCase() === naam || mail.split("@")[0] === naam;
  });
  return Boolean(user?.user_metadata?.mail_moet_wijzigen);
}

export async function mailWachtwoordGezet(local) {
  const admin = dienst();
  if (!admin) return;
  const users = await alleGebruikers();
  const naam = String(local || "").trim().toLowerCase();
  const user = users.find((item) => {
    const meta = item.user_metadata || {};
    const mail = String(item.email || "").toLowerCase();
    return String(meta.mail_local || "").toLowerCase() === naam || String(meta.client_id || "").toLowerCase() === naam || mail.split("@")[0] === naam;
  });
  if (!user) return;
  const meta = { ...(user.user_metadata || {}), mail_moet_wijzigen: false };
  await admin.auth.admin.updateUserById(user.id, { user_metadata: meta });
}

export async function startBeheer(adres, pass) {
  if (!dienst() || !gebruikerClient()) return { letop: "" };
  const local = adres.split("@")[0];
  const gebruiker = await vindGebruiker(local, adres);
  if (!gebruiker) return { letop: "" };
  const sb = gebruikerClient();
  const inn = await sb.auth.signInWithPassword({ email: gebruiker.email, password: pass });
  if (inn.error || !inn.data.session) return { letop: "" };
  const lijst = await sb.auth.mfa.listFactors();
  if (lijst.error) return { letop: "" };
  const verified = (lijst.data?.totp || []).filter((factor) => factor.status === "verified" && factor.friendly_name === "beheer");
  if (!verified[0]) {
    for (const factor of lijst.data?.all || []) {
      if (factor.status !== "verified" && factor.friendly_name === "beheer") {
        await sb.auth.mfa.unenroll({ factorId: factor.id });
      }
    }
    const vers = await sb.auth.mfa.enroll({ factorType: "totp", friendlyName: "beheer", issuer: "BOA Beheer" });
    if (vers.error || !vers.data?.totp?.qr_code) return { letop: "" };
    return {
      stap: "setup",
      factorId: vers.data.id,
      qr: vers.data.totp.qr_code,
      secret: vers.data.totp.secret || "",
      access_token: inn.data.session.access_token,
      refresh_token: inn.data.session.refresh_token,
    };
  }
  return {
    stap: "code",
    factorId: verified[0].id,
    qr: "",
    secret: "",
    access_token: inn.data.session.access_token,
    refresh_token: inn.data.session.refresh_token,
  };
}

export async function bevestigBeheer(open, code) {
  const sb = gebruikerClient();
  if (!sb || !open?.access_token || !open?.factorId) return { fout: "De tweede stap is verlopen. Log opnieuw in." };
  const gezet = await sb.auth.setSession({ access_token: open.access_token, refresh_token: open.refresh_token });
  if (gezet.error) return { fout: "De tweede stap is verlopen. Log opnieuw in." };
  const uitdaging = await sb.auth.mfa.challenge({ factorId: open.factorId });
  if (uitdaging.error || !uitdaging.data) return { fout: "De code kon niet worden gevraagd. Probeer het opnieuw." };
  const check = await sb.auth.mfa.verify({
    factorId: open.factorId,
    challengeId: uitdaging.data.id,
    code: String(code || "").replace(/\s/g, ""),
  });
  if (check.error) return { fout: "De code uit de authenticator klopt niet." };
  return { ok: true };
}
