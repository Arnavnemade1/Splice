/**
 * WebBotAuth — cryptographic bot identity for cooperative sites.
 *
 * Implements the Web Bot Auth pattern (IETF draft-meunier-web-bot-auth-*):
 * the agent holds an Ed25519 keypair and signs outbound requests using
 * RFC 9421 HTTP Message Signatures. An origin that trusts the agent's key
 * (published as a JWK Set at a directory URL) can verify the signature and
 * grant access WITHOUT a CAPTCHA — even though the traffic is automated.
 *
 * This is the honest counterpart to fingerprint stealth: rather than hiding
 * that a bot is present, the agent proves *which* bot it is and that it is
 * authorized. Splice never uses it to impersonate a human or a browser.
 *
 * Signature covers @authority, @method, and (when a directory is configured)
 * the signature-agent header, with created/expires/keyid/alg/tag parameters.
 */

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const KEY_FILENAME = 'webbotauth.key';
/** Default signature validity window (seconds). Kept short like the drafts. */
const DEFAULT_TTL_SECONDS = 300;

function base64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export interface SignedHeaders {
  'signature-input': string;
  signature: string;
  'signature-agent'?: string;
}

export interface WebBotAuthDirectory {
  keys: Array<Record<string, string>>;
}

export class WebBotAuth {
  private privateKey: crypto.KeyObject;
  private publicKey: crypto.KeyObject;
  private keyPath: string;
  private cachedKid: string | null = null;
  /** Directory URL published in the Signature-Agent header (optional). */
  public signatureAgentUrl: string | null;

  constructor(spliceDir: string, signatureAgentUrl?: string) {
    this.keyPath = path.join(spliceDir, KEY_FILENAME);
    this.signatureAgentUrl =
      signatureAgentUrl || process.env.SPLICE_WEB_BOT_AUTH_DIRECTORY || null;
    const { privateKey, publicKey } = this.loadOrGenerate();
    this.privateKey = privateKey;
    this.publicKey = publicKey;
  }

  private loadOrGenerate(): { privateKey: crypto.KeyObject; publicKey: crypto.KeyObject } {
    // An operator can pin the identity key via env for reproducible signing
    // across machines (e.g. a shared verified-bot identity).
    const envKey = process.env.SPLICE_WEB_BOT_AUTH_KEY;
    if (envKey) {
      const pem = envKey.includes('BEGIN') ? envKey : Buffer.from(envKey, 'base64').toString('utf8');
      const privateKey = crypto.createPrivateKey(pem);
      return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
    }

    if (fs.existsSync(this.keyPath)) {
      const pem = fs.readFileSync(this.keyPath, 'utf8');
      const privateKey = crypto.createPrivateKey(pem);
      return { privateKey, publicKey: crypto.createPublicKey(privateKey) };
    }

    const { privateKey, publicKey } = crypto.generateKeyPairSync('ed25519');
    const pem = privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
    fs.writeFileSync(this.keyPath, pem, { mode: 0o600 });
    console.error(`[Splice WebBotAuth] Generated Ed25519 identity key at ${this.keyPath}`);
    console.error('[Splice WebBotAuth] Publish the directory (get_stealth_profile) so origins can verify you.');
    return { privateKey, publicKey };
  }

  /** Public key as an RFC 7517 OKP JWK, including the RFC 7638 thumbprint kid. */
  getPublicJwk(): Record<string, string> {
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    return {
      kty: jwk.kty,          // "OKP"
      crv: jwk.crv,          // "Ed25519"
      x: jwk.x,              // base64url raw public key
      kid: this.keyId(),
      use: 'sig',
      alg: 'Ed25519',
    };
  }

  /** The JWK Set an origin fetches from the Signature-Agent directory URL. */
  getDirectory(): WebBotAuthDirectory {
    return { keys: [this.getPublicJwk()] };
  }

  /**
   * Write the public directory (JWK Set) to a file the operator can host at
   * the Signature-Agent URL so cooperating origins can fetch and trust the
   * key. Public material only — never the private key. Returns the path.
   */
  writeDirectory(filePath: string): string {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify(this.getDirectory(), null, 2), { mode: 0o644 });
    return filePath;
  }

  /**
   * Prove the identity round-trips: sign a sample request and verify it with
   * this same key. A verifying origin performs the mirror of this check, so a
   * passing self-test means a correctly-configured origin will accept us.
   */
  selfTest(sampleUrl = 'https://example.com/'): { signed: SignedHeaders; verified: boolean } {
    const signed = this.signRequest(sampleUrl, 'GET');
    return { signed, verified: this.verify(sampleUrl, 'GET', signed) };
  }

  /** RFC 7638 JWK thumbprint (SHA-256, base64url) — stable key identifier. */
  keyId(): string {
    if (this.cachedKid) return this.cachedKid;
    const jwk = this.publicKey.export({ format: 'jwk' }) as Record<string, string>;
    // Canonical form: members lexicographically ordered, no whitespace.
    const canonical = JSON.stringify({ crv: jwk.crv, kty: jwk.kty, x: jwk.x });
    this.cachedKid = base64url(crypto.createHash('sha256').update(canonical).digest());
    return this.cachedKid;
  }

  /** Export the private identity key (PKCS8 PEM) for backup/pinning. */
  exportPrivateKeyPem(): string {
    return this.privateKey.export({ type: 'pkcs8', format: 'pem' }) as string;
  }

  /**
   * Build the RFC 9421 signature base and the covered-component list for a
   * request. Exposed so tests and verifiers can reconstruct it exactly.
   */
  buildSignatureBase(
    url: string,
    method: string,
    params: { created: number; expires: number }
  ): { base: string; signatureParams: string } {
    const u = new URL(url);
    const authority = u.host.toLowerCase();
    const components: string[] = ['@authority', '@method'];
    const lines: string[] = [
      `"@authority": ${authority}`,
      `"@method": ${method.toUpperCase()}`,
    ];

    if (this.signatureAgentUrl) {
      // The Signature-Agent header value is an sf-string (quoted).
      components.push('signature-agent');
      lines.push(`"signature-agent": "${this.signatureAgentUrl}"`);
    }

    const inner = components.map(c => `"${c}"`).join(' ');
    const signatureParams =
      `(${inner});created=${params.created};expires=${params.expires}` +
      `;keyid="${this.keyId()}";alg="ed25519";tag="web-bot-auth"`;

    lines.push(`"@signature-params": ${signatureParams}`);
    return { base: lines.join('\n'), signatureParams };
  }

  /**
   * Sign a request. Returns the headers to attach: Signature-Input, Signature,
   * and (when configured) Signature-Agent.
   */
  signRequest(
    url: string,
    method: string = 'GET',
    opts: { created?: number; ttlSeconds?: number } = {}
  ): SignedHeaders {
    const created = opts.created ?? Math.floor(Date.now() / 1000);
    const expires = created + (opts.ttlSeconds ?? DEFAULT_TTL_SECONDS);
    const { base, signatureParams } = this.buildSignatureBase(url, method, { created, expires });

    const signature = crypto.sign(null, Buffer.from(base, 'utf8'), this.privateKey);
    const headers: SignedHeaders = {
      'signature-input': `sig1=${signatureParams}`,
      signature: `sig1=:${signature.toString('base64')}:`,
    };
    if (this.signatureAgentUrl) headers['signature-agent'] = `"${this.signatureAgentUrl}"`;
    return headers;
  }

  /**
   * Verify a set of signed headers against this key — used by the test suite
   * and by anyone running Splice as its own verifier. Reconstructs the base
   * from the declared signature params and checks the Ed25519 signature.
   */
  verify(url: string, method: string, headers: SignedHeaders): boolean {
    try {
      const input = headers['signature-input'];
      const sig = headers.signature;
      if (!input || !sig) return false;

      const created = Number(/created=(\d+)/.exec(input)?.[1]);
      const expires = Number(/expires=(\d+)/.exec(input)?.[1]);
      if (!Number.isFinite(created) || !Number.isFinite(expires)) return false;

      const { signatureParams } = this.buildSignatureBase(url, method, { created, expires });
      // The reconstructed params must match what was declared (covered set,
      // keyid, alg, tag) — otherwise a component was tampered with.
      if (`sig1=${signatureParams}` !== input) return false;

      const { base } = this.buildSignatureBase(url, method, { created, expires });
      const b64 = /:([^:]+):/.exec(sig)?.[1];
      if (!b64) return false;
      return crypto.verify(null, Buffer.from(base, 'utf8'), this.publicKey, Buffer.from(b64, 'base64'));
    } catch {
      return false;
    }
  }
}
