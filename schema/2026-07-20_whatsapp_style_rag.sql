-- Prerequisite schema for the isolated WhatsApp style-RAG index.
-- Apply to the same Supabase/Postgres project as the private second brain.
-- This index is deliberately separate from the generic document-chunk table.

create extension if not exists vector;

create table if not exists public.onyankopon_whatsapp_style_examples (
  id uuid primary key default gen_random_uuid(),
  source_outbound_message_id text not null unique,
  incoming_text text not null,
  outgoing_text text not null,
  retrieval_text text not null,
  language text not null default 'unknown',
  chat_kind text not null check (chat_kind in ('direct', 'group')),
  intent text not null default 'casual',
  eligible_for_retrieval boolean not null default true,
  is_sensitive boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  embedding vector(384) not null,
  embedding_model text not null,
  embedded_at timestamptz not null,
  content_hash text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists onyankopon_whatsapp_style_examples_embedding_hnsw_idx
  on public.onyankopon_whatsapp_style_examples
  using hnsw (embedding vector_cosine_ops)
  where eligible_for_retrieval = true and is_sensitive = false;

create index if not exists onyankopon_whatsapp_style_examples_filters_idx
  on public.onyankopon_whatsapp_style_examples (language, chat_kind, intent)
  where eligible_for_retrieval = true and is_sensitive = false;

create or replace function public.onyankopon_whatsapp_style_examples_touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at = now();
  return new;
end;
$$;

drop trigger if exists onyankopon_whatsapp_style_examples_touch_updated_at
  on public.onyankopon_whatsapp_style_examples;
create trigger onyankopon_whatsapp_style_examples_touch_updated_at
before update on public.onyankopon_whatsapp_style_examples
for each row execute function public.onyankopon_whatsapp_style_examples_touch_updated_at();

-- No anon/authenticated read access: only the local bridge service role can
-- insert and retrieve approved, redacted examples.
alter table public.onyankopon_whatsapp_style_examples enable row level security;
revoke all on table public.onyankopon_whatsapp_style_examples from anon, authenticated;
grant select, insert, update, delete on table public.onyankopon_whatsapp_style_examples to service_role;

create or replace function public.onyankopon_whatsapp_style_search(
  query_embedding vector(384),
  match_count integer default 4,
  filter_language text default null,
  filter_chat_kind text default null
)
returns table (
  incoming_text text,
  outgoing_text text,
  language text,
  chat_kind text,
  intent text,
  similarity double precision
)
language sql
stable
security invoker
set search_path = public
as $$
  select
    s.incoming_text,
    s.outgoing_text,
    s.language,
    s.chat_kind,
    s.intent,
    1 - (s.embedding <=> query_embedding) as similarity
  from public.onyankopon_whatsapp_style_examples s
  where s.eligible_for_retrieval = true
    and s.is_sensitive = false
    and (filter_language is null or s.language = filter_language or s.language = 'unknown')
    and (filter_chat_kind is null or s.chat_kind = filter_chat_kind)
  order by s.embedding <=> query_embedding
  limit greatest(1, least(match_count, 6));
$$;

revoke all on function public.onyankopon_whatsapp_style_search(vector, integer, text, text) from public;
grant execute on function public.onyankopon_whatsapp_style_search(vector, integer, text, text) to service_role;
