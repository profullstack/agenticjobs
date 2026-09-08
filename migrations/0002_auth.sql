-- Sessions, magic links, passkeys and the device flow.
--
-- Nothing here stores a credential in a form that is useful if the table
-- leaks: every token is kept as a SHA-256 of the value that was handed out,
-- so the only copy of the real token is the one on the member's machine.

create table if not exists sessions (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references users (id) on delete cascade,
  token_hash   text not null unique,
  -- What the member sees in their session list: "Firefox on Linux", "CLI on
  -- workstation". A token they cannot recognise is a token they cannot revoke.
  label        text not null default 'session',
  -- True for a token minted by the device flow. Such a token is never allowed
  -- to reach the admin routes, no matter whose account it belongs to.
  via_token    boolean not null default false,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  expires_at   timestamptz not null
);

create index if not exists sessions_user_idx on sessions (user_id, created_at desc);
create index if not exists sessions_expiry_idx on sessions (expires_at);

create table if not exists magic_links (
  token_hash text primary key,
  email      text not null,
  -- Where to send the member once the link is followed. Same-origin paths
  -- only; validated before it is written, not when it is used.
  redirect   text,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null,
  used_at    timestamptz
);

create index if not exists magic_links_email_idx on magic_links (lower(email), created_at desc);

create table if not exists passkeys (
  id             uuid primary key default gen_random_uuid(),
  user_id        uuid not null references users (id) on delete cascade,
  credential_id  text not null unique,
  public_key     text not null,
  -- The authenticator's signature counter. A value that goes backwards means
  -- the credential has been cloned.
  counter        bigint not null default 0,
  transports     text[] not null default '{}',
  label          text not null default 'passkey',
  created_at     timestamptz not null default now(),
  last_used_at   timestamptz
);

create index if not exists passkeys_user_idx on passkeys (user_id);

-- Held between a challenge being issued and the browser answering it. Rows
-- are short lived and swept on read.
create table if not exists webauthn_challenges (
  challenge  text primary key,
  email      text,
  user_id    uuid references users (id) on delete cascade,
  purpose    text not null,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);

-- The device flow, for anything without a browser: the CLI, the TUI, MCP.
create table if not exists device_codes (
  device_code_hash text primary key,
  -- Short, typed by a human, so it is generated from an alphabet with no
  -- characters that look like each other.
  user_code        text not null unique,
  label            text not null default 'terminal',
  status           text not null default 'pending',
  user_id          uuid references users (id) on delete cascade,
  -- Set exactly once, when the code is approved, and cleared the first time
  -- the waiting client collects it.
  token            text,
  interval_seconds integer not null default 2,
  created_at       timestamptz not null default now(),
  expires_at       timestamptz not null
);

create index if not exists device_codes_expiry_idx on device_codes (expires_at);
