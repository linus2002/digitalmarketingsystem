-- 013: people who came back after opting out (or after declining) were asked for consent again while their old
-- consent still counted, so retention never removed their data. Consent no longer counts until they agree again.
UPDATE leads SET consent_given = false, consent_at = NULL, updated_at = now()
WHERE consent_given
  AND anonymized_at IS NULL
  AND bot_state IN ('consent', 'declined')
  AND status IN ('awaiting_consent', 'closed');
