import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const ALGORITHM = 'aes-256-gcm';
const KEY_LENGTH = 32; // 256 bits
const IV_LENGTH = 12;  // 96 bits for GCM
const AUTH_TAG_LENGTH = 16;

export class CryptoManager {
  private key: Buffer;
  private keyPath: string;

  constructor(spliceDir: string) {
    this.keyPath = path.join(spliceDir, '.key');
    this.key = this.loadOrGenerateKey();
  }

  private loadOrGenerateKey(): Buffer {
    // Priority 1: environment variable
    if (process.env.SPLICE_ENCRYPTION_KEY) {
      const keyHex = process.env.SPLICE_ENCRYPTION_KEY;
      if (keyHex.length !== 64) {
        throw new Error('SPLICE_ENCRYPTION_KEY must be a 64-character hex string (32 bytes).');
      }
      return Buffer.from(keyHex, 'hex');
    }

    // Priority 2: auto-generated local key file
    if (fs.existsSync(this.keyPath)) {
      const keyHex = fs.readFileSync(this.keyPath, 'utf8').trim();
      console.error(`[Splice Vault] Loaded encryption key from ${this.keyPath}`);
      return Buffer.from(keyHex, 'hex');
    }

    // Generate a new key
    const newKey = crypto.randomBytes(KEY_LENGTH);
    fs.writeFileSync(this.keyPath, newKey.toString('hex'), { mode: 0o600 }); // owner-readable only
    console.error(`[Splice Vault] Generated new AES-256 encryption key at ${this.keyPath}`);
    console.error(`[Splice Vault] IMPORTANT: Back up this key to restore your snapshots.`);
    return newKey;
  }

  encrypt(plaintext: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Format: iv(hex) + ':' + authTag(hex) + ':' + ciphertext(hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(ciphertext: string): string {
    const parts = ciphertext.split(':');
    if (parts.length !== 3) throw new Error('Invalid encrypted format.');
    const [ivHex, authTagHex, encryptedHex] = parts;
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const encryptedData = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]).toString('utf8');
  }

  /** Encrypt and write a file */
  writeEncrypted(filePath: string, content: string): void {
    fs.writeFileSync(filePath, this.encrypt(content));
  }

  /** Read and decrypt a file */
  readDecrypted(filePath: string): string {
    const raw = fs.readFileSync(filePath, 'utf8');
    // Support legacy unencrypted files (plain JSON) by checking if it's valid JSON first
    try {
      JSON.parse(raw);
      return raw; // Legacy plain JSON — return as-is
    } catch {
      return this.decrypt(raw); // Encrypted — decrypt first
    }
  }
}
