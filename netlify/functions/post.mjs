import { antwoord, bericht, berichten, openSessie } from "./lib.mjs";

export async function handler(event) {
  const sessie = openSessie(event);
  if (!sessie) return antwoord(401, { fout: "Log opnieuw in." });
  const q = event.queryStringParameters || {};
  const map = String(q.map || "in");
  try {
    const uitkomst = q.id ? await bericht(sessie, map, q.id, q.bijlage) : await berichten(sessie, map);
    if (uitkomst.fout) return antwoord(uitkomst.status || 400, { fout: uitkomst.fout });
    return antwoord(200, uitkomst);
  } catch {
    return antwoord(502, { fout: "De postbus reageert niet. Probeer het opnieuw." });
  }
}
