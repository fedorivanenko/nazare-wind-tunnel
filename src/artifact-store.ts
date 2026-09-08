import {createHash, createHmac} from 'node:crypto';
import {registerArtifact} from './postgres-store';
import type {Arm, ArtifactRecord} from './domain';

const BUCKET = process.env.WIND_TUNNEL_S3_BUCKET ?? '';
const ENDPOINT = process.env.WIND_TUNNEL_S3_ENDPOINT ?? '';
const REGION = process.env.WIND_TUNNEL_S3_REGION ?? 'auto';
const ACCESS_KEY = process.env.WIND_TUNNEL_S3_ACCESS_KEY ?? '';
const SECRET_KEY = process.env.WIND_TUNNEL_S3_SECRET_KEY ?? '';
const FORCE_PATH_STYLE = process.env.WIND_TUNNEL_S3_FORCE_PATH_STYLE === '1';
const SERVICE = 's3';

function sha256(value: Buffer | string) {
  return createHash('sha256').update(value).digest('hex');
}

function hmac(key: Buffer | string, value: string) {
  return createHmac('sha256', key).update(value).digest();
}

function awsDate(now = new Date()) {
  const iso = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return {amzDate: iso, dateStamp: iso.slice(0, 8)};
}

function requireConfig() {
  if (!BUCKET || !ENDPOINT || !ACCESS_KEY || !SECRET_KEY) {
    throw new Error('Wind Tunnel S3 configuration is incomplete');
  }
}

function encodePath(value: string) {
  return value.split('/').map(segment => encodeURIComponent(segment)).join('/');
}

function objectUrl(key: string) {
  const url = new URL(ENDPOINT);
  if (FORCE_PATH_STYLE) {
    const base = url.pathname.replace(/\/$/, '');
    url.pathname = `${base}/${encodeURIComponent(BUCKET)}/${encodePath(key)}`;
  } else {
    url.hostname = `${BUCKET}.${url.hostname}`;
    url.pathname = `/${encodePath(key)}`;
  }
  url.search = '';
  return url;
}

async function signedFetch(method: 'GET' | 'PUT', key: string, body?: Buffer, mediaType = 'application/octet-stream') {
  requireConfig();
  const url = objectUrl(key);
  const payloadHash = sha256(body ?? Buffer.alloc(0));
  const {amzDate, dateStamp} = awsDate();
  const canonicalUri = url.pathname;
  const canonicalQuery = url.searchParams.toString();
  const canonicalHeaders = `host:${url.host}\nx-amz-content-sha256:${payloadHash}\nx-amz-date:${amzDate}\n`;
  const signedHeaders = 'host;x-amz-content-sha256;x-amz-date';
  const canonicalRequest = [method, canonicalUri, canonicalQuery, canonicalHeaders, signedHeaders, payloadHash].join('\n');
  const scope = `${dateStamp}/${REGION}/${SERVICE}/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', amzDate, scope, sha256(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${SECRET_KEY}`, dateStamp);
  const kRegion = hmac(kDate, REGION);
  const kService = hmac(kRegion, SERVICE);
  const kSigning = hmac(kService, 'aws4_request');
  const signature = createHmac('sha256', kSigning).update(stringToSign).digest('hex');
  const authorization = `AWS4-HMAC-SHA256 Credential=${ACCESS_KEY}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;

  const response = await fetch(url, {
    method,
    headers: {
      authorization,
      'x-amz-date': amzDate,
      'x-amz-content-sha256': payloadHash,
      ...(method === 'PUT' ? {'content-type': mediaType} : {}),
    },
    body: method === 'PUT' && body ? new Uint8Array(body) : undefined,
  });
  if (!response.ok) throw new Error(`S3 ${method} ${key} failed: ${response.status} ${await response.text()}`);
  return response;
}

function secretValues() {
  const values = new Set<string>();
  for (const [name, value] of Object.entries(process.env)) {
    if (!value || value.length < 8) continue;
    if (/(TOKEN|SECRET|PASSWORD|API_KEY|ACCESS_KEY|DATABASE_URL)/i.test(name)) values.add(value);
  }
  return [...values].sort((a, b) => b.length - a.length);
}

export function redactText(text: string) {
  let redacted = text;
  for (const secret of secretValues()) redacted = redacted.split(secret).join('[REDACTED]');
  redacted = redacted.replace(/(Bearer\s+)[A-Za-z0-9._~+\/-]{16,}/gi, '$1[REDACTED]');
  return redacted;
}

export async function putArtifact(input: {
  runId: string;
  arm?: Arm | null;
  type: string;
  name: string;
  mediaType: string;
  content: string | Buffer;
  redact?: boolean;
}) {
  const raw = Buffer.isBuffer(input.content) ? input.content : Buffer.from(input.content);
  const content = input.redact === false || Buffer.isBuffer(input.content)
    ? raw
    : Buffer.from(redactText(raw.toString('utf8')));
  const digest = sha256(content);
  const key = `${input.runId}/${input.arm ?? 'run'}/${digest}/${input.name}`;
  await signedFetch('PUT', key, content, input.mediaType);
  const record: ArtifactRecord = {
    runId: input.runId,
    arm: input.arm ?? null,
    type: input.type,
    key,
    mediaType: input.mediaType,
    bytes: content.byteLength,
    sha256: digest,
    createdAt: new Date().toISOString(),
  };
  await registerArtifact(record);
  return record;
}

export async function getArtifact(record: ArtifactRecord, maxBytes = 400_000) {
  const response = await signedFetch('GET', record.key);
  const buffer = Buffer.from(await response.arrayBuffer());
  const textual = record.mediaType.startsWith('text/') || record.mediaType.includes('json');
  if (!textual) return {...record, inline: null, truncated: false};
  const truncated = buffer.byteLength > maxBytes;
  const visible = truncated ? buffer.subarray(buffer.byteLength - maxBytes) : buffer;
  return {...record, inline: visible.toString('utf8'), truncated};
}