import crypto from "crypto";
import dotenv from "dotenv";
import { Buffer } from "node:buffer";

dotenv.config();

export class CryptoService {
  private readonly keyPassword = "@Buddhika#1996@"; // Replace with env var or secure config
  private readonly salt = "my-salt"; // Must match frontend
  private readonly iterations = 100000;
  private readonly keyLength = 32; // 256 bits
  private readonly algorithm = "aes-256-gcm";
  private readonly ivLength = 12;
  private readonly authTagLength = 16;

  constructor() {}

  /**
   * Derive key using PBKDF2 with SHA-256
   */
  private async deriveKey(): Promise<Buffer> {
    return new Promise((resolve, reject) => {
      crypto.pbkdf2(
        this.keyPassword,
        this.salt,
        this.iterations,
        this.keyLength,
        "sha256",
        (err, derivedKey) => {
          if (err) return reject(err);
          resolve(derivedKey);
        }
      );
    });
  }

  /**
   * Encrypt a JS object or string into a base64 URL-safe string
   */
  public async encrypt(data: any): Promise<string> {
    const key = await this.deriveKey();
    const iv = crypto.randomBytes(this.ivLength);
    const json = typeof data === "string" ? data : JSON.stringify(data);

    const cipher = crypto.createCipheriv(this.algorithm, key, iv);
    const encrypted = Buffer.concat([
      cipher.update(json, "utf8"),
      cipher.final(),
    ]);
    const authTag = cipher.getAuthTag();

    const combined = Buffer.concat([iv, authTag, encrypted]);

    return combined
      .toString("base64")
      .replace(/\+/g, "-")
      .replace(/\//g, "_")
      .replace(/=+$/, "");
  }

  /**
   * Decrypt base64 URL-safe string back to original object or string
   */
  public async decrypt(cipherText: string): Promise<any> {
    const key = await this.deriveKey();

    const padded = cipherText
      .replace(/-/g, "+")
      .replace(/_/g, "/")
      .padEnd(cipherText.length + ((4 - (cipherText.length % 4)) % 4), "=");

    const raw = Buffer.from(padded, "base64");

    const iv = raw.subarray(0, this.ivLength);
    const authTag = raw.subarray(
      this.ivLength,
      this.ivLength + this.authTagLength
    );
    const encrypted = raw.subarray(this.ivLength + this.authTagLength);

    const decipher = crypto.createDecipheriv(this.algorithm, key, iv);
    decipher.setAuthTag(authTag);

    const decrypted = Buffer.concat([
      decipher.update(encrypted),
      decipher.final(),
    ]);

    const text = decrypted.toString("utf8");
    try {
      return JSON.parse(text);
    } catch {
      return text; // fallback if not JSON
    }
  }

  /**
   * Generates a 64-char secure random token with 24-hour expiry
   */
  public generateEmailVerificationToken(): { token: string; expires: Date } {
    const token = crypto.randomBytes(32).toString("hex");
    const expires = new Date(Date.now() + 24 * 60 * 60 * 1000);
    return { token, expires };
  }
}
