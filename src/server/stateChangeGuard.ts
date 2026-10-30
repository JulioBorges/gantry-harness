import type { IncomingMessage } from 'node:http';

/**
 * Browser CSRF guard for state-changing routes.
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
 */
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
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end <= 1) return null;
    const rest = host.slice(end + 1);
    if (!rest.startsWith(':')) return null;
    const port = Number(rest.slice(1));
    if (!Number.isInteger(port)) return null;
    return { hostname: host.slice(1, end).toLowerCase(), port };
  }
  const colon = host.lastIndexOf(':');
  if (colon <= 0) return null;
  const port = Number(host.slice(colon + 1));
  if (!Number.isInteger(port)) return null;
  return { hostname: host.slice(0, colon).toLowerCase(), port };
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

  const hostname = normalizeHost(origin.hostname);
  if (LOOPBACK_HOSTS.has(hostname)) return true;

  const bind = normalizeHost(context.bindHost);
  if (bind && bind !== '0.0.0.0' && bind !== '::' && hostname === bind) return true;
  if (bind !== '0.0.0.0' && bind !== '::') return false;

  const requestHost = parseHostHeader(requestHostHeader);
  return requestHost !== null
    && requestHost.port === context.port
    && requestHost.hostname === hostname
    && isIpLiteral(hostname);
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
