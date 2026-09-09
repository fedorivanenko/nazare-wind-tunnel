import type {APIRoute} from 'astro';
import {controlFetch} from '../../lib/control';

export const ALL: APIRoute = async ({request, params}) => {
  const path = params.path ?? '';
  const incoming = new URL(request.url);
  const body = request.method === 'GET' || request.method === 'HEAD' ? undefined : await request.arrayBuffer();
  const headers = new Headers();
  const contentType = request.headers.get('content-type');
  if (contentType) headers.set('content-type', contentType);
  const upstream = await controlFetch(`/${path}${incoming.search}`, {method: request.method, headers, body});
  const responseHeaders = new Headers();
  for (const name of ['content-type','cache-control','content-disposition']) {
    const value = upstream.headers.get(name);
    if (value) responseHeaders.set(name, value);
  }
  if (upstream.headers.get('content-type')?.includes('text/event-stream')) {
    responseHeaders.set('connection', 'keep-alive');
    responseHeaders.set('x-accel-buffering', 'no');
  }
  return new Response(upstream.body, {status: upstream.status, headers: responseHeaders});
};
