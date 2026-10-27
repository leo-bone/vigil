import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign as edSign,
  verify as edVerify,
  type KeyObject,
} from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * 账本签名。
 *
 * 哈希链只防"改中间一条"——攻击者从断点开始整条重算就能伪造一条完整的链。
 * Ed25519 签名堵死这条路：私钥离线保管，签名对每条记录的哈希生效，
 * 没有私钥就无法追加任何一条能通过验签的记录。
 *
 * 吸收自 MakerChecker / InALign 的共同设计，但更简单：
 * 只签记录哈希，不做 RFC 3161 时间戳（那是托管服务的事，本地场景不需要）。
 */
export interface SigningIdentity {
  publicKeyPem: string;
  privateKeyPem: string;
  createdAt?: string;
}

/** 生成新身份。私钥只落盘一次，之后由调用方保管。 */
export function generateSigningIdentity(): SigningIdentity {
  const { publicKey, privateKey } = generateKeyPairSync('ed25519');
  return {
    publicKeyPem: publicKey.export({ type: 'spki', format: 'pem' }).toString(),
    privateKeyPem: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
    createdAt: new Date().toISOString(),
  };
}

/** 把身份写到密钥文件（默认 .vigil/signing-key.json）。 */
export function saveSigningIdentity(identity: SigningIdentity, path: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(identity, null, 2) + '\n', 'utf8');
}

/** 读密钥文件；不存在返回 null，不静默生成 —— 密钥的出现必须是显式动作。 */
export function loadSigningIdentity(path: string): SigningIdentity | null {
  if (!existsSync(path)) return null;
  const raw = JSON.parse(readFileSync(path, 'utf8')) as SigningIdentity;
  if (!raw.publicKeyPem || !raw.privateKeyPem) {
    throw new Error(`签名密钥文件不完整：${path}`);
  }
  return raw;
}

/** 对任意字节签名，返回 base64。data 通常是记录的哈希字符串。 */
export function signBytes(privateKeyPem: string, data: string): string {
  const key: KeyObject = createPrivateKey(privateKeyPem);
  return edSign(null, Buffer.from(data, 'utf8'), key).toString('base64');
}

/** 验签。任何不对称都算失败。 */
export function verifyBytes(publicKeyPem: string, data: string, signatureBase64: string): boolean {
  try {
    const key = createPublicKey(publicKeyPem);
    return edVerify(null, Buffer.from(data, 'utf8'), key, Buffer.from(signatureBase64, 'base64'));
  } catch {
    return false;
  }
}
