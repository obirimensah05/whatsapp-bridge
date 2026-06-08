import { randomBytes } from 'node:crypto'

// CSP helpers for the single-file web UI. Kept side-effect-free so they can be
// unit-tested without booting the API. The UI's one inline <script> is allowed
// via a per-request nonce instead of 'unsafe-inline'; inline styles still need
// 'unsafe-inline' (the inline <style> block + style= attributes).

export function makeNonce(): string {
  return randomBytes(16).toString('base64url')
}

export function cspWithNonce(nonce: string): string {
  return (
    "default-src 'self'; " +
    "img-src 'self' blob: data: https:; " +
    "media-src 'self' blob:; " +
    "connect-src 'self'; " +
    `script-src 'self' 'nonce-${nonce}'; ` +
    "style-src 'self' 'unsafe-inline'; " +
    "object-src 'none'; " +
    "base-uri 'self'; " +
    "frame-ancestors 'none'"
  )
}

// Inject the per-request nonce into the cached index HTML's single <script> tag.
export function renderIndexWithNonce(html: string, nonce: string): string {
  return html.replace('<script>', `<script nonce="${nonce}">`)
}
