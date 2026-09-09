import {createHash, timingSafeEqual} from 'node:crypto';
import {defineMiddleware} from 'astro:middleware';

const ACCESS_TOKEN = process.env.DASHBOARD_ACCESS_TOKEN ?? '';
const COOKIE = 'wt_dashboard_session';

function sessionValue() {
  return createHash('sha256').update(`wind-tunnel-dashboard:${ACCESS_TOKEN}`).digest('hex');
}

function equal(a: string, b: string) {
  const aa = Buffer.from(a);
  const bb = Buffer.from(b);
  return aa.length === bb.length && timingSafeEqual(aa, bb);
}

export const onRequest = defineMiddleware(async ({url, cookies, redirect}, next) => {
  if (!ACCESS_TOKEN) return next();
  if (url.pathname === '/login' || url.pathname === '/api/session' || url.pathname === '/health') return next();
  const cookie = cookies.get(COOKIE)?.value ?? '';
  if (!equal(cookie, sessionValue())) return redirect('/login');
  return next();
});

export {COOKIE, sessionValue, equal};
