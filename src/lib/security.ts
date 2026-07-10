import { NextResponse } from "next/server";

/**
 * The server binds 127.0.0.1 only (see package.json scripts), but a bound socket alone does not
 * stop DNS rebinding: a public hostname can resolve to 127.0.0.1 and a browser will happily send
 * the attacker's hostname in `Host`. Validating the hostname closes that hole. The port is
 * deliberately NOT checked — PORT is configurable and carries no security value here.
 */
const ALLOWED_HOSTNAMES = new Set(["127.0.0.1", "localhost"]);

/** Distinguishable so route handlers can map only this failure to 403 and let real bugs surface as 500. */
export class LocalOnlyError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "LocalOnlyError";
  }
}

/**
 * Extracts the hostname from a `Host` header value, rejecting anything malformed.
 * Handles `host`, `host:port`, and the IPv6 literal form `[::1]:port`.
 */
function hostnameFromHostHeader(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end > 1 ? trimmed.slice(1, end) : null;
  }

  const separator = trimmed.indexOf(":");
  if (separator < 0) {
    return trimmed;
  }

  const hostname = trimmed.slice(0, separator);
  const port = trimmed.slice(separator + 1);
  if (!hostname || !/^\d+$/.test(port)) {
    return null;
  }

  return hostname;
}

/** `Origin` is a serialized origin (`scheme://host[:port]`) or the literal string "null". */
function hostnameFromOrigin(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed || trimmed === "null") {
    return null;
  }

  try {
    return new URL(trimmed).hostname;
  } catch {
    return null;
  }
}

/**
 * Throws when the request did not originate from this machine's loopback interface.
 * `Origin` is absent on most same-origin fetches and on curl — that is expected and allowed;
 * it is only rejected when present AND pointing somewhere other than loopback.
 */
export function assertLocalRequest(request: Request): void {
  const host = request.headers.get("host");
  if (!host) {
    throw new LocalOnlyError("Host 헤더가 없어 로컬 요청인지 확인할 수 없습니다.");
  }

  const hostname = hostnameFromHostHeader(host);
  if (!hostname || !ALLOWED_HOSTNAMES.has(hostname)) {
    throw new LocalOnlyError(`허용되지 않은 Host 헤더입니다: ${host}`);
  }

  const origin = request.headers.get("origin");
  if (origin === null) {
    return;
  }

  const originHostname = hostnameFromOrigin(origin);
  if (!originHostname || !ALLOWED_HOSTNAMES.has(originHostname)) {
    throw new LocalOnlyError(`허용되지 않은 Origin 헤더입니다: ${origin}`);
  }
}

/**
 * Route-handler entry point: returns a 403 response to hand straight back to Next.js, or null
 * when the request is allowed. Non-LocalOnlyError failures are rethrown so they surface as 500s.
 */
export function guardLocalRequest(request: Request): NextResponse | null {
  try {
    assertLocalRequest(request);
    return null;
  } catch (error) {
    if (error instanceof LocalOnlyError) {
      return NextResponse.json({ error: error.message }, { status: 403 });
    }
    throw error;
  }
}
