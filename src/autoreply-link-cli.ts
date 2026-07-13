// Terminal preview for the autoreply link/URL context extractor.
//
//   npm run autoreply:link -- "check this https://youtu.be/abc123"
//   npm run autoreply:link -- https://example.com/article
//
// Prints exactly the "linked content context" the drafter would build for the
// given message text - useful for sanity-checking transcript/page extraction
// (and the SSRF guard) without sending a real WhatsApp message.

import './autoreply-env.js' // side effect: load .env into process.env
import { buildLinkContext } from './autoreply-link-context.js'

async function main(): Promise<void> {
  const text = process.argv.slice(2).join(' ').trim()
  if (!text) {
    console.error('usage: npm run autoreply:link -- "<message text or url>"')
    process.exit(1)
  }
  const context = await buildLinkContext(text)
  if (!context) {
    console.log('(no links found / no context extracted)')
    return
  }
  console.log(context)
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error))
  process.exit(1)
})
