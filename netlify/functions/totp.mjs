import { createHmac, randomBytes } from "node:crypto";
import QRCode from "qrcode";

const ALFABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function nieuwGeheim() {
  const bytes = randomBytes(20);
  let bits = 0;
  let waarde = 0;
  let uit = "";
  for (const b of bytes) {
    waarde = (waarde << 8) | b;
    bits += 8;
    while (bits >= 5) {
      uit += ALFABET[(waarde >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits) uit += ALFABET[(waarde << (5 - bits)) & 31];
  return uit;
}

function decode(geheim) {
  const schoon = String(geheim || "").replace(/=+$/g, "").toUpperCase().replace(/[^A-Z2-7]/g, "");
  let bits = 0;
  let waarde = 0;
  const uit = [];
  for (const c of schoon) {
    const i = ALFABET.indexOf(c);
    if (i < 0) continue;
    waarde = (waarde << 5) | i;
    bits += 5;
    if (bits >= 8) {
      uit.push((waarde >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(uit);
}

export function codes(geheim, tijd = Date.now()) {
  const teller = Math.floor(tijd / 30000);
  const sleutel = decode(geheim);
  const lijst = [];
  for (let delta = -1; delta <= 1; delta += 1) {
    const buf = Buffer.alloc(8);
    buf.writeBigUInt64BE(BigInt(teller + delta));
    const hmac = createHmac("sha1", sleutel).update(buf).digest();
    const offset = hmac[hmac.length - 1] & 15;
    const bin = ((hmac[offset] & 127) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3];
    lijst.push(String(bin % 1000000).padStart(6, "0"));
  }
  return lijst;
}

export function klopt(geheim, code) {
  const invoer = String(code || "").replace(/\s/g, "");
  if (!/^\d{6}$/.test(invoer)) return false;
  return codes(geheim).includes(invoer);
}

export async function qrData(geheim, local) {
  const uri = `otpauth://totp/BOA%20Mail:${encodeURIComponent(local)}?secret=${geheim}&issuer=BOA%20Mail&algorithm=SHA1&digits=6&period=30`;
  return QRCode.toDataURL(uri, { margin: 1, width: 220 });
}
