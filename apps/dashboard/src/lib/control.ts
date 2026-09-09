import type {RunEvent, RunState, ArtifactRecord} from '@nazare/wind-tunnel-domain';

const CONTROL_URL = (process.env.WIND_TUNNEL_CONTROL_URL ?? '').replace(/\/$/, '');
const CONTROL_TOKEN = process.env.WIND_TUNNEL_TOKEN ?? '';

function assertConfigured() {
  if (!CONTROL_URL) throw new Error('WIND_TUNNEL_CONTROL_URL is required');
  if (!CONTROL_TOKEN) throw new Error('WIND_TUNNEL_TOKEN is required');
}

export async function controlFetch(path: string, init: RequestInit = {}) {
  assertConfigured();
  const headers = new Headers(init.headers);
  headers.set('authorization', `Bearer ${CONTROL_TOKEN}`);
  return fetch(`${CONTROL_URL}${path}`, {...init, headers});
}

export async function controlJson<T>(path: string, init: RequestInit = {}): Promise<T> {
  const response = await controlFetch(path, init);
  if (!response.ok) throw new Error(`Control API ${response.status}: ${await response.text()}`);
  return response.json() as Promise<T>;
}

export type RunsResponse = {runs: RunState[]};
export type EventsResponse = {runId: string; events: RunEvent[]};
export type ArtifactsResponse = {runId: string; artifacts: ArtifactRecord[]};
