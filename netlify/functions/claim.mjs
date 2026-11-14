import { antwoord, claim, leesJson, openSessie } from "./lib.mjs";

export async function handler(event) {
  if (event.httpMethod !== "POST") return antwoord(405, { fout: "Niet toegestaan." });
  const sessie = openSessie(event);
  if (!sessie) return antwoord(401, { fout: "Log opnieuw in." });
  try {
    const { map, id } = leesJson(event);
    const uid = String(id || "").split(":")[1] || id;
    const uitkomst = await claim(sessie, String(map || ""), uid);
    if (uitkomst.fout) return antwoord(uitkomst.status || 400, { fout: uitkomst.fout });
    return antwoord(200, { ok: true });
  } catch {
    return antwoord(502, { fout: "Claimen lukt nu niet." });
  }
}
