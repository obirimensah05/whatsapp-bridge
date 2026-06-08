import './env.js'
import { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import {
  CallToolRequestSchema,
  ListToolsRequestSchema,
} from '@modelcontextprotocol/sdk/types.js'

const API_BASE = process.env.WHATSAPP_BRIDGE_URL ?? 'http://127.0.0.1:8080'
const TOKEN = process.env.API_TOKEN

if (!TOKEN) {
  process.stderr.write('API_TOKEN not set — start the whatsapp-bridge daemon first\n')
  process.exit(1)
}

async function api<T = unknown>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    throw new Error(`whatsapp-bridge API ${res.status}: ${await res.text()}`)
  }
  return res.json() as Promise<T>
}

const server = new Server(
  { name: 'whatsapp-bridge', version: '0.5.0' },
  { capabilities: { tools: {} } },
)

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'list_sessions',
      description:
        'List paired WhatsApp sessions (e.g. "main", "personal"). Use this to discover which numbers are available before reading or sending.',
      inputSchema: { type: 'object', properties: {}, required: [] },
    },
    {
      name: 'list_conversations',
      description:
        'List recent conversations for a WhatsApp session, sorted by most recent message first. Each entry includes chat_jid, push_name, last message body and timestamp.',
      inputSchema: {
        type: 'object',
        properties: {
          session: {
            type: 'string',
            description: 'Session name. Default: "main".',
          },
          limit: {
            type: 'integer',
            description: 'Max conversations to return. Default 100, max 500.',
          },
        },
      },
    },
    {
      name: 'read_conversation',
      description:
        'Read message history for one conversation. Returns most-recent messages first. Paginate older messages with the "before" param (unix ms).',
      inputSchema: {
        type: 'object',
        properties: {
          jid: {
            type: 'string',
            description:
              'Chat JID. Either "<digits>@s.whatsapp.net" (1-on-1 by phone) or "<id>@lid" (LID-addressed user) or "<id>@g.us" (group).',
          },
          session: { type: 'string', description: 'Session name. Default: "main".' },
          limit: {
            type: 'integer',
            description: 'Max messages. Default 50, max 500.',
          },
          before: {
            type: 'integer',
            description:
              'Unix ms timestamp. Only return messages older than this — used for paging back through history.',
          },
        },
        required: ['jid'],
      },
    },
    {
      name: 'send_message',
      description:
        'Send a text WhatsApp message from a session. Returns the WA message id and timestamp on success. Confirm with the user before sending unless they have already authorized this specific send.',
      inputSchema: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description:
              'Recipient. Either a phone number in international format (digits only, no "+") which will be normalized to "<digits>@s.whatsapp.net", or a full JID ending in @s.whatsapp.net / @lid / @g.us.',
          },
          text: { type: 'string', description: 'Message body.' },
          session: {
            type: 'string',
            description: 'Session name to send from. Default: "main".',
          },
        },
        required: ['to', 'text'],
      },
    },
    {
      name: 'list_aliases',
      description:
        'List all JID aliases for a session. Each entry maps an alias JID (typically @lid) to a canonical JID (typically @s.whatsapp.net), so the same person shows up as one conversation regardless of which form WhatsApp used.',
      inputSchema: {
        type: 'object',
        properties: {
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
      },
    },
    {
      name: 'resolve_contact',
      description:
        'Resolve a single query to a contact. The query can be (a) a JID — "<digits>@s.whatsapp.net", "<id>@lid", or "<id>@g.us"; (b) a phone number in international format ("+49…" or just digits); or (c) a saved contact-name substring (case-insensitive). Returns the canonical PN-form JID, display name, phone, and every known alias JID for that person. Use this to answer "who is <lid>?" or "what JID do I send to for <name>?".',
      inputSchema: {
        type: 'object',
        properties: {
          q: {
            type: 'string',
            description: 'JID, phone (digits or +digits), or contact-name substring.',
          },
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
        required: ['q'],
      },
    },
    {
      name: 'search_contacts',
      description:
        'Search saved contacts by name substring (case-insensitive). Returns up to `limit` distinct people, each with the same shape as resolve_contact (canonical JID, display name, phone, alias JIDs). Use when the operator gives an ambiguous name and you want to enumerate candidates.',
      inputSchema: {
        type: 'object',
        properties: {
          q: { type: 'string', description: 'Name substring to match.' },
          limit: { type: 'integer', description: 'Max distinct people. Default 20, max 100.' },
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
        required: ['q'],
      },
    },
    {
      name: 'merge_jids',
      description:
        'Mark two JIDs as the same person. After merging, list_conversations collapses them and read_conversation returns combined history regardless of which JID is queried. Pass the @lid form as alias and the @s.whatsapp.net form as canonical, so phone-number metadata is preserved.',
      inputSchema: {
        type: 'object',
        properties: {
          alias: {
            type: 'string',
            description: 'The JID to map FROM (typically the @lid form).',
          },
          canonical: {
            type: 'string',
            description: 'The JID to map TO (typically the @s.whatsapp.net form, which exposes the phone number).',
          },
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
        required: ['alias', 'canonical'],
      },
    },
    {
      name: 'unmerge_jid',
      description: 'Remove a previously-set alias mapping for a JID.',
      inputSchema: {
        type: 'object',
        properties: {
          alias: { type: 'string', description: 'The alias JID to unmap.' },
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
        required: ['alias'],
      },
    },
    {
      name: 'send_media',
      description:
        'Send a media message (image, video, audio, or document). Supply the file via either media_url (server fetches it) or media_base64. Confirm with the user before sending.',
      inputSchema: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient JID or phone number.' },
          media_kind: { type: 'string', enum: ['image', 'video', 'audio', 'document'] },
          media_url: { type: 'string', description: 'Public URL for the server to fetch.' },
          media_base64: { type: 'string', description: 'Base64-encoded file bytes (no data: prefix).' },
          mime: { type: 'string', description: 'MIME type. Auto-detected when fetching by URL.' },
          filename: { type: 'string', description: 'For documents only; the original file name.' },
          caption: { type: 'string', description: 'Optional caption for image/video/document.' },
          quoted_id: { type: 'string', description: 'Reply to this message id.' },
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
        required: ['to', 'media_kind'],
      },
    },
    {
      name: 'send_reaction',
      description:
        'React to a message with a single emoji. Pass an empty string for emoji to remove an existing reaction.',
      inputSchema: {
        type: 'object',
        properties: {
          chat_jid: { type: 'string', description: 'JID of the chat the message is in.' },
          message_id: { type: 'string', description: 'Full message id ("<session>:<msg_key_id>" or just msg_key_id).' },
          emoji: { type: 'string', description: 'A single emoji, or empty string to remove.' },
          session: { type: 'string', description: 'Session name. Default: "main".' },
        },
        required: ['chat_jid', 'message_id', 'emoji'],
      },
    },
    {
      name: 'delete_message',
      description:
        'Delete (un-send) a previously sent message. Defaults to from_me=true (only your own messages).',
      inputSchema: {
        type: 'object',
        properties: {
          chat_jid: { type: 'string' },
          message_id: { type: 'string' },
          from_me: { type: 'boolean', description: 'Default true.' },
          participant: { type: 'string', description: 'Group: original sender JID; required only if deleting someone else\'s message as admin.' },
          session: { type: 'string' },
        },
        required: ['chat_jid', 'message_id'],
      },
    },
    {
      name: 'send_typing',
      description:
        'Send a presence indicator. State "composing" shows typing, "paused" stops it, "recording" shows recording voice, "available"/"unavailable" set general presence.',
      inputSchema: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          state: { type: 'string', enum: ['composing', 'paused', 'recording', 'available', 'unavailable'] },
          session: { type: 'string' },
        },
        required: ['jid'],
      },
    },
    {
      name: 'mark_read',
      description: 'Mark a list of inbound messages as read on the WhatsApp side (sender sees blue ticks).',
      inputSchema: {
        type: 'object',
        properties: {
          jid: { type: 'string', description: 'Chat JID the messages are in.' },
          message_ids: { type: 'array', items: { type: 'string' }, description: 'Message ids to mark.' },
          session: { type: 'string' },
        },
        required: ['jid', 'message_ids'],
      },
    },
    {
      name: 'check_number',
      description:
        'Check whether a phone number is registered on WhatsApp. Returns the WhatsApp JID if it exists.',
      inputSchema: {
        type: 'object',
        properties: {
          phone: { type: 'string', description: 'Phone number, digits only or with "+" — both accepted.' },
          session: { type: 'string' },
        },
        required: ['phone'],
      },
    },
    {
      name: 'group_info',
      description: 'Fetch group metadata (name, description, participants).',
      inputSchema: {
        type: 'object',
        properties: { jid: { type: 'string' }, session: { type: 'string' } },
        required: ['jid'],
      },
    },
    {
      name: 'group_invite_link',
      description: 'Generate a https://chat.whatsapp.com/... invite link for a group.',
      inputSchema: {
        type: 'object',
        properties: { jid: { type: 'string' }, session: { type: 'string' } },
        required: ['jid'],
      },
    },
    {
      name: 'group_leave',
      description: 'Leave a group. Cannot be undone without an invite link.',
      inputSchema: {
        type: 'object',
        properties: { jid: { type: 'string' }, session: { type: 'string' } },
        required: ['jid'],
      },
    },
    {
      name: 'group_participants',
      description:
        'Add, remove, promote, or demote group participants. Only works if the session is a group admin (for add/remove/promote/demote).',
      inputSchema: {
        type: 'object',
        properties: {
          jid: { type: 'string' },
          participants: { type: 'array', items: { type: 'string' } },
          action: { type: 'string', enum: ['add', 'remove', 'promote', 'demote'] },
          session: { type: 'string' },
        },
        required: ['jid', 'participants', 'action'],
      },
    },
    {
      name: 'refresh_profile_pic',
      description: 'Fetch the current profile picture URL for a JID and persist it.',
      inputSchema: {
        type: 'object',
        properties: { jid: { type: 'string' }, session: { type: 'string' } },
        required: ['jid'],
      },
    },
  ],
}))

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const { name, arguments: rawArgs } = req.params
  const args = (rawArgs ?? {}) as Record<string, unknown>
  const session = (args.session as string | undefined) ?? 'main'

  try {
    if (name === 'list_sessions') {
      const data = await api<{ sessions: string[] }>('/v1/health')
      return {
        content: [{ type: 'text', text: JSON.stringify(data.sessions, null, 2) }],
      }
    }

    if (name === 'list_conversations') {
      const limit = Math.min(Number(args.limit ?? 100), 500)
      const data = await api<{ conversations: unknown[] }>(
        `/v1/conversations?session=${encodeURIComponent(session)}&limit=${limit}`,
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(data.conversations, null, 2) }],
      }
    }

    if (name === 'read_conversation') {
      const jid = String(args.jid ?? '')
      if (!jid) throw new Error('jid is required')
      const limit = Math.min(Number(args.limit ?? 50), 500)
      const params = new URLSearchParams({
        session,
        jid,
        limit: String(limit),
      })
      if (args.before) params.set('before', String(args.before))
      const data = await api<{ messages: unknown[] }>(`/v1/messages?${params}`)
      return {
        content: [{ type: 'text', text: JSON.stringify(data.messages, null, 2) }],
      }
    }

    if (name === 'send_message') {
      const to = String(args.to ?? '')
      const text = String(args.text ?? '')
      if (!to || !text) throw new Error('to and text are required')
      const data = await api<unknown>('/v1/send', {
        method: 'POST',
        body: JSON.stringify({ session, to, text }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'list_aliases') {
      const data = await api<{ aliases: unknown }>(
        `/v1/aliases?session=${encodeURIComponent(session)}`,
      )
      return {
        content: [{ type: 'text', text: JSON.stringify(data.aliases, null, 2) }],
      }
    }

    if (name === 'resolve_contact') {
      const q = String(args.q ?? '')
      if (!q) throw new Error('q is required')
      const data = await api<unknown>(
        `/v1/contacts/resolve?session=${encodeURIComponent(session)}&q=${encodeURIComponent(q)}`,
      )
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'search_contacts') {
      const q = String(args.q ?? '')
      if (!q) throw new Error('q is required')
      const limit = Math.min(Number(args.limit ?? 20), 100)
      const data = await api<unknown>(
        `/v1/contacts/search?session=${encodeURIComponent(session)}&q=${encodeURIComponent(q)}&limit=${limit}`,
      )
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'merge_jids') {
      const alias = String(args.alias ?? '')
      const canonical = String(args.canonical ?? '')
      if (!alias || !canonical) throw new Error('alias and canonical are required')
      const data = await api<unknown>('/v1/aliases', {
        method: 'POST',
        body: JSON.stringify({ session, alias, canonical }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'unmerge_jid') {
      const alias = String(args.alias ?? '')
      if (!alias) throw new Error('alias is required')
      const data = await api<unknown>('/v1/aliases', {
        method: 'DELETE',
        body: JSON.stringify({ session, alias }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'send_media') {
      const to = String(args.to ?? '')
      const media_kind = args.media_kind as string
      if (!to || !media_kind) throw new Error('to and media_kind are required')
      const body = {
        session, to, media_kind,
        media_url: args.media_url, media_base64: args.media_base64,
        mime: args.mime, filename: args.filename,
        caption: args.caption, quoted_id: args.quoted_id,
      }
      const data = await api<unknown>('/v1/send', { method: 'POST', body: JSON.stringify(body) })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'send_reaction') {
      const data = await api<unknown>('/v1/react', {
        method: 'POST',
        body: JSON.stringify({
          session,
          chat_jid: args.chat_jid,
          message_id: args.message_id,
          emoji: args.emoji,
        }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'delete_message') {
      const data = await api<unknown>('/v1/messages', {
        method: 'DELETE',
        body: JSON.stringify({
          session,
          chat_jid: args.chat_jid,
          message_id: args.message_id,
          from_me: args.from_me ?? true,
          participant: args.participant,
        }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'send_typing') {
      const data = await api<unknown>('/v1/typing', {
        method: 'POST',
        body: JSON.stringify({ session, jid: args.jid, state: args.state ?? 'composing' }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'mark_read') {
      const data = await api<unknown>('/v1/read', {
        method: 'POST',
        body: JSON.stringify({ session, jid: args.jid, message_ids: args.message_ids }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'check_number') {
      const phone = encodeURIComponent(String(args.phone ?? ''))
      const data = await api<unknown>(
        `/v1/check?session=${encodeURIComponent(session)}&phone=${phone}`,
      )
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'group_info') {
      const jid = encodeURIComponent(String(args.jid ?? ''))
      const data = await api<unknown>(
        `/v1/groups/info?session=${encodeURIComponent(session)}&jid=${jid}`,
      )
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'group_invite_link') {
      const jid = encodeURIComponent(String(args.jid ?? ''))
      const data = await api<unknown>(
        `/v1/groups/invite?session=${encodeURIComponent(session)}&jid=${jid}`,
      )
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'group_leave') {
      const data = await api<unknown>('/v1/groups/leave', {
        method: 'POST',
        body: JSON.stringify({ session, jid: args.jid }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'group_participants') {
      const data = await api<unknown>('/v1/groups/participants', {
        method: 'POST',
        body: JSON.stringify({
          session,
          jid: args.jid,
          participants: args.participants,
          action: args.action,
        }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    if (name === 'refresh_profile_pic') {
      const data = await api<unknown>('/v1/profile_pic/refresh', {
        method: 'POST',
        body: JSON.stringify({ session, jid: args.jid }),
      })
      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] }
    }

    return {
      content: [{ type: 'text', text: `unknown tool: ${name}` }],
      isError: true,
    }
  } catch (err) {
    return {
      content: [{ type: 'text', text: `error: ${(err as Error).message}` }],
      isError: true,
    }
  }
})

const transport = new StdioServerTransport()
await server.connect(transport)
process.stderr.write('[mcp] whatsapp-bridge MCP server listening on stdio\n')
