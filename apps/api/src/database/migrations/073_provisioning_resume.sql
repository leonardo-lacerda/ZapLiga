-- Cadastro retomado depois de o worker reiniciar (deploy, queda): a API recria o job no worker
-- com `resume`, e ele continua de onde o WhatsApp parou. `resume_count` limita as tentativas;
-- `country_code` guarda o DDI separado do número, que o worker precisa para recriar o job.
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS resume_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE provisioning_jobs ADD COLUMN IF NOT EXISTS country_code TEXT;
