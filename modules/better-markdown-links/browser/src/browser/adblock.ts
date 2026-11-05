/* eslint-disable @typescript-eslint/no-explicit-any */
/**
 * Adblock-style ELEMENT HIDDING only.
 *
 * A plugin lives in the renderer, so there is no network-layer blocking
 * available for the guest (and AdGuard-style extensions can't work without it).
 * Hiding by CSS is still worthwhile: one insertCSS call covers nodes inserted
 * later by the page, which beating a DOM sweep.
 *
 * Supported syntax (a deliberate subset, identical to the SiYuan plugin):
 *   ##selector              generic
 *   example.com##selector   domain-scoped (subdomains included)
 *   a.com,b.com##selector   several domains
 *   example.com#@#selector  exception
 *   ! comment
 */
export interface AdRules {
  generic: string[];
  byDomain: Map<string, string[]>;
  exceptions: string[];
}

function domainMatches(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase();
  const d = domain.toLowerCase();
  return host === d || host.endsWith("." + d);
}

export function parseAdRules(text: string): AdRules {
  const rules: AdRules = { generic: [], byDomain: new Map(), exceptions: [] };

  for (const rawLine of (text || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    if (line.startsWith("!")) continue;
    // A bare `#` comment — but never eat `##` or `#@#`.
    if (/^#(?![#@])/.test(line)) continue;

    let body = line;
    let exception = false;
    if (line.startsWith("#@#")) {
      exception = true;
      body = line.slice(3);
    } else if (line.includes("#@#")) {
      exception = true;
      body = line.replace("#@#", "##");
    }

    const idx = body.indexOf("##");
    if (idx < 0) continue; // network-filter rules are not supported

    const selector = body.slice(idx + 2).trim();
    if (!selector) continue;
    const domains = body
      .slice(0, idx)
      .split(",")
      .map((d) => d.trim().toLowerCase())
      .filter(Boolean);

    if (exception) {
      rules.exceptions.push(selector);
      continue;
    }
    if (domains.length === 0) {
      rules.generic.push(selector);
      continue;
    }
    for (const d of domains) {
      if (!rules.byDomain.has(d)) rules.byDomain.set(d, []);
      rules.byDomain.get(d)!.push(selector);
    }
  }
  return rules;
}

function isValidSelector(selector: string): boolean {
  try {
    document.querySelector(selector);
    return true;
  } catch {
    return false;
  }
}

/** Build the `display:none` stylesheet that applies to `url`. */
export function buildAdBlockCss(url: string, userText: string, builtinText: string): string {
  let hostname = "";
  try {
    hostname = new URL(url).hostname;
  } catch {
    return "";
  }

  const user = parseAdRules(userText);
  const builtin = parseAdRules(builtinText);

  const selectors: string[] = [];
  selectors.push(...user.generic, ...builtin.generic);
  for (const [domain, list] of user.byDomain) if (domainMatches(hostname, domain)) selectors.push(...list);
  for (const [domain, list] of builtin.byDomain) if (domainMatches(hostname, domain)) selectors.push(...list);

  const exceptions = new Set(user.exceptions);
  const out: string[] = [];
  const seen = new Set<string>();
  for (const sel of selectors) {
    if (exceptions.has(sel) || seen.has(sel)) continue;
    if (!isValidSelector(sel)) continue;
    seen.add(sel);
    out.push(`${sel}{display:none!important}`);
  }
  return out.join("\n");
}

export const BUILTIN_ADBLOCK_RULES: string = __ADBLOCK_RULES__;
