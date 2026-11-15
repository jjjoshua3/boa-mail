import { antwoord, bewaarConcept, leesJson, openSessie, verplaats } from "./lib.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return antwoord(405, { fout: "Niet toegestaan." });
  const sessie = openSessie(event);
  if (!sessie) return antwoord(401, { fout: "Log opnieuw in." });
  try {
    const body = leesJson(event);
    const uitkomst = body.actie === "concept"
      ? await bewaarConcept(sessie, body)
      : await verplaats(sessie, String(body.van || ""), body.id, String(body.naar || ""));
    if (uitkomst.fout) return antwoord(uitkomst.status || 400, { fout: uitkomst.fout });
    return antwoord(200, { ok: true });
  } catch {
    return antwoord(502, { fout: "De postbus reageert niet. Probeer het opnieuw." });
  }
}
