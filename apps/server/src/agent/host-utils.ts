/**
 * Host extraction helpers — used by add-endpoint to denormalize a `host`
 * column on `endpoints`, and by buildTargetMemoryContext to look up
 * cross-session memory by host.
 *
 * Heuristics, not strict — we err on the side of returning *something*
 * usable as a memory key, rather than returning null and losing the lookup.
 */

const IPV4_RE = /\b\d{1,3}(?:\.\d{1,3}){3}\b/
const DOMAIN_RE = /(?<![\w.-])[a-z0-9-]+(?:\.[a-z0-9-]+){1,}(?![\w-])/i

/**
 * Best-effort hostname extraction.
 *
 *   "https://api.example.com/v1/users" → "api.example.com"
 *   "扫一下 https://x.com 看看"          → "x.com"
 *   "192.168.1.1:8080/admin"            → "192.168.1.1"
 *   "目标是 example.com，扫接口"          → "example.com"
 *   "你好"                                → null
 *
 * Notes:
 * - Returns lowercased hostname (canonical form for indexing).
 * - For IPv4 + bare-domain matches in the same string, prefer URL-prefixed
 *   matches first (most reliable), then IPv4, then the longest domain match.
 * - Returns null when nothing looks host-shaped.
 */
export function extractHost(input: string | null | undefined): string | null {
  if (!input) return null
  const t = input.trim()
  if (!t) return null

  // 1. Try parsing the first http(s) URL we see.
  const urlMatch = t.match(/https?:\/\/[^\s'"<>`]+/i)
  if (urlMatch) {
    try {
      const u = new URL(urlMatch[0])
      if (u.hostname) return u.hostname.toLowerCase()
    } catch { /* fall through */ }
  }

  // 2. Try parsing as a URL by prepending scheme — handles "example.com/path".
  const tokenMatch = t.match(/[a-z0-9][a-z0-9.-]*[a-z0-9](?::\d+)?(?:\/\S*)?/i)
  if (tokenMatch) {
    try {
      const u = new URL(`http://${tokenMatch[0]}`)
      if (u.hostname && (u.hostname.includes('.') || /^\d/.test(u.hostname))) {
        return u.hostname.toLowerCase()
      }
    } catch { /* fall through */ }
  }

  // 3. Bare IPv4 anywhere in the text.
  const ip = t.match(IPV4_RE)
  if (ip) return ip[0]

  // 4. Bare domain. Pick the longest match (more specific wins).
  const domains = [...t.matchAll(new RegExp(DOMAIN_RE, 'gi'))].map(m => m[0])
  if (domains.length) {
    domains.sort((a, b) => b.length - a.length)
    return domains[0].toLowerCase()
  }

  return null
}
