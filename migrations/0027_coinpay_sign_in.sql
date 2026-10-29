-- Sign in with CoinPay.
--
-- CoinPay is the fleet's master account: a person can sign in here with it, not
-- only connect it to an account they already have. A sign-in has no account
-- yet when it starts, so a pending authorization may carry no user. Every
-- authorization also carries an OIDC nonce now, checked against the id_token
-- CoinPay returns.
--
-- The account is found by coinpay_accounts.coinpay_sub (already unique), never
-- by the CoinPay email: CoinPay does not verify addresses.

alter table coinpay_oauth_states alter column user_id drop not null;
alter table coinpay_oauth_states add column if not exists mode text not null default 'connect';
alter table coinpay_oauth_states add column if not exists nonce text;
