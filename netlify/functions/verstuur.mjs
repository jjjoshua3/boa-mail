import { antwoord, leesJson, openSessie, verstuur } from "./lib.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return antwoord(405, { fout: "Niet toegestaan." });
  const sessie = openSessie(event);
  if (!sessie) return antwoord(401, { fout: "Log opnieuw in." });
  try {
    const uitkomst = await verstuur(sessie, leesJson(event));
    if (uitkomst.fout) return antwoord(uitkomst.status || 400, { fout: uitkomst.fout });
    return antwoord(200, { ok: true });
  } catch {
    return antwoord(502, { fout: "Verzenden lukt nu niet. Probeer het opnieuw." });
  }
}
