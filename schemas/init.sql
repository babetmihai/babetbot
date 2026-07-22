-- RAG documents (firm FAQ + client conversation history)
create extension if not exists vector;

create table if not exists documents (
  id bigserial primary key,
  content text,
  metadata jsonb,
  embedding vector(1536)
);

create or replace function match_documents (
  query_embedding vector(1536),
  match_count int DEFAULT null,
  filter jsonb DEFAULT '{}'
) returns table (
  id bigint,
  content text,
  metadata jsonb,
  embedding jsonb,
  similarity float
)
language plpgsql
as $$
#variable_conflict use_column
begin
  return query
  select
    id,
    content,
    metadata,
    (embedding::text)::jsonb as embedding,
    1 - (documents.embedding <=> query_embedding) as similarity
  from documents
  where metadata @> filter
  order by documents.embedding <=> query_embedding
  limit match_count;
end;
$$;

-- Intake goal definitions
create table if not exists goal_definitions (
  goal_key text primary key,
  label text not null,
  description text not null,
  prompt text,
  goal_type text not null default 'collect',
  target_goal_key text,
  priority int not null default 0
);

insert into goal_definitions (goal_key, label, description, prompt, goal_type, target_goal_key, priority) values
  ('description', 'Situation description', 'A brief description of their situation or what they need help with.', null, 'collect', null, 10),
  ('consent', 'Consent', 'Whether the client agrees to share their intake information with an assigned provider, after being told they must pay an intake fee before connecting with a provider.', null, 'collect', null, 20),
  ('practice_area', 'Focus area', 'The focus area, inferred from the client''s description.', null, 'derive', 'description', 30)
on conflict (goal_key) do update set
  label = excluded.label,
  description = excluded.description,
  prompt = excluded.prompt,
  goal_type = excluded.goal_type,
  target_goal_key = excluded.target_goal_key,
  priority = excluded.priority;

-- Client intake values
create table if not exists user_goal_values (
  id bigserial primary key,
  user_id text not null,
  goal_key text not null,
  value text not null,
  updated_at timestamptz default now(),
  unique (user_id, goal_key)
);

create index if not exists idx_user_goal_values_user on user_goal_values (user_id);

-- Self-serve provider signup requests (admin approve/decline)
create table if not exists provider_signup_requests (
  id bigserial primary key,
  telegram_user_id text not null unique,
  telegram_username text,
  name text not null,
  status text not null default 'pending' check (status in ('pending', 'approved', 'declined')),
  created_at timestamptz default now(),
  resolved_at timestamptz
);

-- Providers for case routing
create table if not exists providers (
  id bigserial primary key,
  name text not null,
  telegram_user_id text not null unique,
  telegram_username text,
  bot_started_at timestamptz,
  created_at timestamptz default now()
);

-- Provider offer batches: broadcast new clients to onboarded providers
create table if not exists provider_case_offer_batches (
  id bigserial primary key,
  client_telegram_id text not null,
  client_chat_id bigint not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'exhausted')),
  accepted_provider_id bigint references providers (id),
  created_at timestamptz default now(),
  accepted_at timestamptz
);

create unique index if not exists idx_offer_batches_pending_client
  on provider_case_offer_batches (client_telegram_id) where status = 'pending';

create table if not exists provider_case_offer_messages (
  id bigserial primary key,
  batch_id bigint not null references provider_case_offer_batches (id) on delete cascade,
  provider_id bigint not null references providers (id),
  chat_id bigint not null,
  message_id int not null,
  status text not null default 'pending' check (status in ('pending', 'accepted', 'declined', 'dismissed')),
  unique (batch_id, provider_id)
);

-- Client cases: client DM relay ↔ provider bot topic
create table if not exists cases (
  id bigserial primary key,
  client_telegram_id text not null,
  client_chat_id bigint not null,
  provider_id bigint not null references providers (id),
  group_chat_id bigint not null,
  topic_id int not null,
  status text not null default 'active' check (status in ('active', 'closed')),
  intake_summary text,
  created_at timestamptz default now(),
  closed_at timestamptz
);

create index if not exists idx_cases_client_active on cases (client_telegram_id, status);
create unique index if not exists idx_cases_one_active_per_client on cases (client_telegram_id) where status = 'active';
create unique index if not exists idx_cases_topic on cases (group_chat_id, topic_id) where status = 'active';

-- Stripe payments
create table if not exists payments (
  id bigserial primary key,
  client_telegram_id text not null,
  client_chat_id bigint not null,
  case_id bigint references cases (id),
  stripe_session_id text not null unique,
  amount_cents int not null,
  currency text not null default 'ron',
  status text not null default 'pending' check (status in ('pending', 'paid', 'refunded')),
  kind text not null check (kind in ('intake_fee', 'provider_request')),
  description text not null,
  stripe_payment_intent_id text,
  created_at timestamptz default now(),
  paid_at timestamptz,
  refunded_at timestamptz
);

create index if not exists idx_payments_client on payments (client_telegram_id, kind, status);

alter table payments add column if not exists stripe_payment_intent_id text;
alter table payments add column if not exists refunded_at timestamptz;
alter table payments drop constraint if exists payments_status_check;
alter table payments add constraint payments_status_check check (status in ('pending', 'paid', 'refunded'));
