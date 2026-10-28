-- CoinPay tokens are no longer kept.
--
-- coinpay_accounts held each person's CoinPay access and refresh tokens in
-- plaintext. The board only ever used them to re-read the person's wallets,
-- and the wallets were already stored, so the board now keeps the wallets and
-- nothing that can act as the person on CoinPay. New connections write no
-- token; existing rows are converted by the boot-time sweep (one refresh, one
-- userinfo read, tokens nulled in the same update), and with
-- LEGACY_KEY_MIGRATION=off the sweep just deletes what is left.
--
-- Additive only: the columns become nullable and stay until every row is
-- clear. `agenticjobs coinpay-sweep` reports how many still hold a token.

alter table coinpay_accounts alter column access_token drop not null;
alter table coinpay_accounts alter column expires_at drop not null;
alter table coinpay_accounts add column if not exists wallets_synced_at timestamptz;

-- Every existing row read its wallets at connect time or on a later refresh,
-- both of which bumped updated_at.
update coinpay_accounts set wallets_synced_at = updated_at where wallets_synced_at is null;

comment on column coinpay_accounts.access_token is
  'Legacy (pre-0026) plaintext token. Never written now; nulled by the coinpay sweep.';
comment on column coinpay_accounts.refresh_token is
  'Legacy (pre-0026) plaintext token. Never written now; nulled by the coinpay sweep.';
