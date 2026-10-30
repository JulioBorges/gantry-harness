import type { IncomingMessage } from 'node:http';

/**
 * Browser CSRF guard for every state-changing HTTP method.
 *
 * An app origin is an `http` origin (this server does not terminate TLS) whose
 * port is the listening port and whose host is loopback, the concrete bind
 * host, or — only when the process is bound to a wildcard — the IP literal in
 * this request's Host header. That last case covers the operator opening the
 * same server over a LAN or Tailscale address. DNS names that are not the bind
 * host are refused, including a rebinding name pointed at loopback.
 *
 * A missing Origin is refused. Cross-site browser POSTs always send Origin, and
 * same-origin `fetch` from the page served by this process does too. Absence is
 * not an app origin; `Origin: null` (sandboxed or opaque documents) is refused
 * for the same reason. Non-browser callers opt in by sending the app origin.
 * The browser sets Origin itself; page script cannot.
 */
export const STATE_CHANGING_METHODS = ['POST', 'PUT', 'PATCH', 'DELETE'] as const;

export function isStateChangingMethod(method: string | undefined): boolean {
  return method !== undefined && (STATE_CHANGING_METHODS as readonly string[]).includes(method);
}

export interface StateChangeGuardContext {
  bindHost: string;
  port: number;
}

export interface StateChangeRequestHeaders {
  origin?: string;
  contentType?: string;
  host?: string;
}

export interface GuardRejection {
  statusCode: 403 | 415;
  error: string;
}

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1']);

export function singleHeader(value: string | string[] | undefined): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function normalizeHost(value: string): string {
  const trimmed = value.trim().toLowerCase();
  if (trimmed.startsWith('[') && trimmed.endsWith(']')) return trimmed.slice(1, -1);
  return trimmed;
}

function isIpLiteral(hostname: string): boolean {
  if (hostname.includes(':')) return true;
  const parts = hostname.split('.');
  return parts.length === 4 && parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function parseHostHeader(host: string | undefined): { hostname: string; port: number } | null {
  if (!host) return null;
  const trimmed = host.trim();
  if (!trimmed || /\s/.test(trimmed)) return null;
  if (trimmed.startsWith('[')) {
    const end = trimmed.indexOf(']');
    if (end <= 1) return null;
    const rest = trimmed.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    if (!Number.isInteger(port)) return null;
    return { hostname: trimmed.slice(1, end).toLowerCase(), port };
  }
  const colon = trimmed.lastIndexOf(':');
  if (colon <= 0) return null;
  const port = Number(trimmed.slice(colon + 1));
  if (!Number.isInteger(port)) return null;
  return { hostname: trimmed.slice(0, colon).toLowerCase(), port };
}

/**
 * True when `hostname` is an authority this process serves: loopback, the
 * concrete bind host, or — only for a wildcard bind — an IP literal that is
 * also the host of `hostHeader`.
 */
function hostIsAppAuthority(hostname: string, hostHeader: string | undefined, context: StateChangeGuardContext): boolean {
  const normalized = normalizeHost(hostname);
  if (LOOPBACK_HOSTS.has(normalized)) return true;
  const bind = normalizeHost(context.bindHost);
  if (bind && bind !== '0.0.0.0' && bind !== '::' && normalized === bind) return true;
  if (bind !== '0.0.0.0' && bind !== '::') return false;
  const requestHost = parseHostHeader(hostHeader);
  return requestHost !== null
    && requestHost.port === context.port
    && requestHost.hostname === normalized
    && isIpLiteral(normalized);
}

/**
 * The Host header (or :authority) must name this process. A DNS name that is
 * not the bind host is not an app host, including one that merely resolves here.
 * A missing port is not the listening port.
 */
export function isAppHost(hostHeader: string | undefined, context: StateChangeGuardContext): boolean {
  const parsed = parseHostHeader(hostHeader);
  if (!parsed || parsed.port !== context.port) return false;
  return hostIsAppAuthority(parsed.hostname, hostHeader, context);
}

export const HOST_REJECTION = { statusCode: 421 as const, error: 'Host recusado.' };

export function isLoopbackRemote(address: string | undefined): boolean {
  return address === '127.0.0.1' || address === '::1' || address === '::ffff:127.0.0.1';
}

export function isAppOrigin(
  originHeader: string | undefined,
  requestHostHeader: string | undefined,
  context: StateChangeGuardContext,
): boolean {
  if (!originHeader || originHeader === 'null') return false;
  let origin: URL;
  try {
    origin = new URL(originHeader);
  } catch {
    return false;
  }
  if (origin.protocol !== 'http:') return false;
  if (origin.username || origin.password) return false;
  if (origin.pathname !== '/' && origin.pathname !== '') return false;
  if (origin.search || origin.hash) return false;
  const originPort = origin.port === '' ? 80 : Number(origin.port);
  if (!Number.isInteger(originPort) || originPort !== context.port) return false;

  return hostIsAppAuthority(origin.hostname, requestHostHeader, context);
}

export function hasJsonContentType(contentType: string | undefined): boolean {
  if (!contentType) return false;
  const [type, ...params] = contentType.split(';');
  if (!type || type.trim().toLowerCase() !== 'application/json') return false;
  return params.every((param) => {
    const trimmed = param.trim();
    return trimmed.length > 0 && !trimmed.includes(',') && trimmed.includes('=');
  });
}

export function evaluateStateChangeGuard(
  headers: StateChangeRequestHeaders,
  context: StateChangeGuardContext,
): GuardRejection | null {
  if (!isAppOrigin(headers.origin, headers.host, context)) {
    return { statusCode: 403, error: 'Origem recusada.' };
  }
  if (!hasJsonContentType(headers.contentType)) {
    return { statusCode: 415, error: 'Content-Type deve ser application/json.' };
  }
  return null;
}

export function evaluateIncomingStateChange(
  req: IncomingMessage,
  context: StateChangeGuardContext,
): GuardRejection | null {
  return evaluateStateChangeGuard({
    origin: singleHeader(req.headers.origin),
    contentType: singleHeader(req.headers['content-type']),
    host: singleHeader(req.headers.host),
  }, context);
}
