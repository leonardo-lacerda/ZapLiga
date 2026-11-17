import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, vi } from 'vitest';
import { ProfileForm } from './ProfileForm';

const originalUrl = { create: URL.createObjectURL, revoke: URL.revokeObjectURL };
afterEach(() => { URL.createObjectURL = originalUrl.create; URL.revokeObjectURL = originalUrl.revoke; });

const file = (name: string, type: string, bytes: number) => new File([new Uint8Array(bytes)], name, { type });

it('recusa foto maior que 2 MB ou fora de JPEG/PNG e mostra a prévia da foto válida', async () => {
  const createObjectURL = vi.fn(() => 'blob:preview-1');
  const revokeObjectURL = vi.fn();
  URL.createObjectURL = createObjectURL; URL.revokeObjectURL = revokeObjectURL;
  const user = userEvent.setup({ applyAccept: false });
  const onSubmit = vi.fn().mockResolvedValue(true);
  const { unmount } = render(<ProfileForm onSubmit={onSubmit} />);
  const input = screen.getByLabelText('Foto do perfil');

  await user.upload(input, file('grande.png', 'image/png', 2 * 1024 * 1024 + 1));
  expect(screen.getByRole('alert')).toHaveTextContent('A foto precisa ter no máximo 2 MB.');
  expect(screen.queryByAltText('Prévia da foto do perfil')).not.toBeInTheDocument();

  await user.upload(input, file('animada.gif', 'image/gif', 1000));
  expect(screen.getByRole('alert')).toHaveTextContent('A foto precisa ser JPEG ou PNG.');

  const ok = file('perfil.jpg', 'image/jpeg', 2 * 1024 * 1024);
  await user.upload(input, ok);
  expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  expect(screen.getByAltText('Prévia da foto do perfil')).toHaveAttribute('src', 'blob:preview-1');

  await user.type(screen.getByLabelText('Nome do perfil'), '  Comercial  ');
  await user.click(screen.getByRole('button', { name: 'Salvar perfil' }));
  expect(onSubmit).toHaveBeenCalledWith({ name: 'Comercial', photo: ok });

  unmount();
  expect(revokeObjectURL).toHaveBeenCalledWith('blob:preview-1');
});
