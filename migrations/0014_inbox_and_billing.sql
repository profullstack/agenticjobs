-- The inbox, and the invoices that travel through it.
--
-- A board where the only way to reach somebody is a public comment box gets
-- used as one: ugig.net's comments filled up with invoices, because an invoice
-- has to go *somewhere* and that was the only somewhere. So there is no public
-- commenting here at all. A conversation is private to the people in it, and
-- an invoice is a message in that conversation with money attached.
--
-- Two things are in the schema rather than in a validator:
--
--   - A message is bounded. 4000 characters is a long letter; it is not room
--     for a pasted document, which belongs on a resume or a listing.
--   - An invoice has one payee and one amount, and its status moves forward.
--     It is never edited after it is sent: a changed invoice is a new one.

-- A conversation. The subject is the one line the list page shows.
create table if not exists threads (
  id              uuid primary key default gen_random_uuid(),
  subject         text not null check (length(subject) between 1 and 140),
  -- The listing this is about, when it is about one. Kept when the listing
  -- is deleted: the conversation still happened.
  job_id          uuid references jobs (id) on delete set null,
  created_by      uuid not null references users (id) on delete cascade,
  created_at      timestamptz not null default now(),
  -- Denormalised so the inbox sorts without touching messages.
  last_message_at timestamptz not null default now()
);

-- Who is in it. A person is in a conversation either as themselves or as a
-- member of an employer; `org_id` says which, and is what the other side sees
-- as the name. Every member of the employer is a participant, so a message to
-- "Acme" reaches whoever at Acme is around.
create table if not exists thread_participants (
  thread_id    uuid not null references threads (id) on delete cascade,
  user_id      uuid not null references users (id) on delete cascade,
  org_id       uuid references organisations (id) on delete set null,
  -- Unread is "a message newer than this". Null means never opened.
  last_read_at timestamptz,
  -- When this person was last emailed about this thread, so a burst of ten
  -- messages is one email rather than ten.
  notified_at  timestamptz,
  primary key (thread_id, user_id)
);

create index if not exists thread_participants_user_idx on thread_participants (user_id);
create index if not exists thread_participants_org_idx on thread_participants (org_id)
  where org_id is not null;
create index if not exists threads_job_idx on threads (job_id) where job_id is not null;

-- An invoice. Its money is settled on CoinPay, to the payee's own wallet; the
-- board never holds funds. The row here is the source of truth for *which*
-- conversation it belongs to and *whether it has been paid*; the CoinPay
-- payment is the source of truth for the chain-level facts, and is re-minted
-- when a quote expires unpaid, so `coinpay_payment_id` changes over time and
-- `status` does not move backwards.
create table if not exists invoices (
  id                  uuid primary key default gen_random_uuid(),
  thread_id           uuid not null references threads (id) on delete cascade,
  -- Who gets paid. Always a person: a payout goes to a wallet somebody
  -- connected, and an employer does not have one.
  payee_id            uuid not null references users (id) on delete cascade,
  amount_usd          numeric(12, 2) not null check (amount_usd > 0),
  -- The chain the payee chose to be paid on, in CoinPay's spelling:
  -- BTC, ETH, SOL, USDC_POL and so on.
  currency            text not null,
  -- The payee's address for that chain, copied at send time. An invoice
  -- settles to the wallet it was sent with, whatever is connected later.
  wallet_address      text not null,
  description         text not null default '' check (length(description) <= 1000),
  status              text not null default 'sent'
                      check (status in ('sent', 'paid', 'cancelled')),
  coinpay_payment_id  text,
  payment_address     text,
  amount_crypto       text,
  payment_expires_at  timestamptz,
  paid_at             timestamptz,
  paid_by             uuid references users (id) on delete set null,
  tx_hash             text,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now()
);

create index if not exists invoices_thread_idx on invoices (thread_id, created_at desc);
create index if not exists invoices_payee_idx on invoices (payee_id, created_at desc);
-- The webhook looks a payment up by CoinPay's id and nothing else.
create unique index if not exists invoices_payment_key on invoices (coinpay_payment_id)
  where coinpay_payment_id is not null;

-- A message. `kind` says whether it is words or an invoice; an invoice message
-- carries the invoice and its body is the description, so a thread reads
-- top to bottom without joining.
create table if not exists messages (
  id          uuid primary key default gen_random_uuid(),
  thread_id   uuid not null references threads (id) on delete cascade,
  sender_id   uuid not null references users (id) on delete cascade,
  kind        text not null default 'text' check (kind in ('text', 'invoice')),
  body        text not null check (length(body) between 1 and 4000),
  invoice_id  uuid references invoices (id) on delete set null,
  created_at  timestamptz not null default now(),
  constraint messages_invoice_kind check (
    (kind = 'invoice' and invoice_id is not null) or (kind = 'text' and invoice_id is null)
  )
);

create index if not exists messages_thread_idx on messages (thread_id, created_at);

-- A CoinPay account somebody connected, so the board can read which wallets
-- they can be paid to. The tokens are theirs, for their account: the board
-- reads `userinfo` with them and nothing else.
--
-- One CoinPay account attaches to one person here, and the unique index is
-- what says so. Without it the first account to connect a wallet would be the
-- one every later profile quietly pays out to.
create table if not exists coinpay_accounts (
  user_id       uuid primary key references users (id) on delete cascade,
  coinpay_sub   text not null unique,
  email         text,
  name          text,
  access_token  text not null,
  refresh_token text,
  scope         text not null default '',
  expires_at    timestamptz not null,
  -- What userinfo last said: [{ address, chain, label }]. Refreshed on
  -- connect and on request, never trusted to be more current than that.
  wallets       jsonb not null default '[]'::jsonb,
  connected_at  timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

-- An authorization in flight. Server-side rather than in a cookie so the same
-- flow works from a terminal, and so a state is single-use by deletion.
create table if not exists coinpay_oauth_states (
  state         text primary key,
  user_id       uuid not null references users (id) on delete cascade,
  code_verifier text not null,
  redirect      text,
  expires_at    timestamptz not null
);
