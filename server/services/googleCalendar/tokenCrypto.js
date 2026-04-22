const crypto = require("crypto");

const ALGORITHM = "aes-256-gcm";

function getKey() {
  const raw = process.env.TOKEN_ENCRYPTION_KEY;
  if (!raw) {
    throw new Error("Missing TOKEN_ENCRYPTION_KEY");
  }

  // If you already have a 64-char hex key, use it directly.
  if (/^[0-9a-fA-F]{64}$/.test(raw)) {
    return Buffer.from(raw, "hex");
  }

  // Otherwise derive a 32-byte key from the string.
  return crypto.createHash("sha256").update(raw).digest();
}

function encrypt(text) {
  const key = getKey();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);

  const encrypted = Buffer.concat([
    cipher.update(text, "utf8"),
    cipher.final(),
  ]);

  const authTag = cipher.getAuthTag();

  return JSON.stringify({
    iv: iv.toString("hex"),
    authTag: authTag.toString("hex"),
    content: encrypted.toString("hex"),
  });
}

function decrypt(payload) {
  const key = getKey();
  const parsed = JSON.parse(payload);

  const decipher = crypto.createDecipheriv(
    ALGORITHM,
    key,
    Buffer.from(parsed.iv, "hex")
  );

  decipher.setAuthTag(Buffer.from(parsed.authTag, "hex"));

  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(parsed.content, "hex")),
    decipher.final(),
  ]);

  return decrypted.toString("utf8");
}

module.exports = {
  encrypt,
  decrypt,
};