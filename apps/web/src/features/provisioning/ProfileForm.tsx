import { FormEvent, useEffect, useState } from 'react';
import { Button } from '../../components/ui';
import { createObjectUrl as createPreviewUrl, revokeObjectUrl as revokePreviewUrl } from './objectUrl';
import { validateProfilePhoto } from './provisioning.labels';

type Props = { onSubmit: (input: { name: string; photo: File | null }) => Promise<unknown> };

const NAME_MAX = 25; // limite do WhatsApp para o nome do perfil

/** Nome (obrigatório) e foto opcional (JPEG/PNG até 2 MB, conferida aqui antes do envio). */
export function ProfileForm({ onSubmit }: Props) {
  const [name, setName] = useState('');
  const [photo, setPhoto] = useState<File | null>(null);
  const [preview, setPreview] = useState('');
  const [photoError, setPhotoError] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => () => revokePreviewUrl(preview), [preview]);

  const pickPhoto = (file: File | undefined) => {
    setPhotoError('');
    if (!file) { setPhoto(null); setPreview(''); return; }
    const error = validateProfilePhoto(file);
    if (error) { setPhoto(null); setPreview(''); setPhotoError(error); return; }
    setPhoto(file);
    setPreview(createPreviewUrl(file));
  };

  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (!name.trim() || busy) return;
    setBusy(true);
    try { await onSubmit({ name: name.trim(), photo }); } finally { setBusy(false); }
  };

  return <form className="provisioning-profile-form" onSubmit={(event) => void submit(event)}>
    <div className="provisioning-number-grid">
      <label>
        <span>Nome do perfil <em>*</em></span>
        <input aria-label="Nome do perfil" value={name} maxLength={NAME_MAX} required onChange={(event) => setName(event.target.value)} placeholder="Ex.: Comercial ZapLiga" />
        <small>Aparece para os contatos no WhatsApp (até {NAME_MAX} caracteres).</small>
      </label>
      <label>
        <span>Foto <small>opcional</small></span>
        <input aria-label="Foto do perfil" type="file" accept="image/jpeg,image/png" onChange={(event) => pickPhoto(event.target.files?.[0])} />
        <small>JPEG ou PNG, até 2 MB.</small>
      </label>
    </div>
    {photoError && <p className="provisioning-field-error" role="alert">{photoError}</p>}
    {preview && <img className="provisioning-photo-preview" src={preview} alt="Prévia da foto do perfil" />}
    <div className="provisioning-inline-actions">
      <Button type="submit" icon="check" disabled={busy || !name.trim()}>{busy ? 'Salvando…' : 'Salvar perfil'}</Button>
    </div>
  </form>;
}
