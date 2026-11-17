import { FormEvent, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { NumbersPage } from './NumbersPage';

function Harness({ onCreate, canProvision = false, onOpenProvisioning }: { onCreate: (payload: Record<string, unknown>) => void; canProvision?: boolean; onOpenProvisioning?: () => void }) {
  const [numberForm, setNumberForm] = useState({ label: '', phone: '' });
  const createNumber = (event: FormEvent) => {
    event.preventDefault();
    onCreate(numberForm);
  };
  return (
    <NumbersPage
      numbers={[]}
      numbersTotal={0}
      numbersOffset={0}
      onNumbersPageChange={() => undefined}
      numberForm={numberForm}
      setNumberForm={setNumberForm}
      createNumber={createNumber}
      showQr={() => undefined}
      reconnectNumber={() => undefined}
      removeNumber={() => undefined}
      qrLoading={false}
      qr={null}
      closeQr={() => undefined}
      canManageNumbers
      canProvision={canProvision}
      onOpenProvisioning={onOpenProvisioning}
    />
  );
}

it('esconde o botão do GeeLark sem a flag/permissão e abre o cadastro com ela', async () => {
  const { unmount } = render(<Harness onCreate={vi.fn()} />);
  expect(screen.queryByRole('button', { name: /Cadastrar número no GeeLark/i })).not.toBeInTheDocument();
  unmount();

  const onOpenProvisioning = vi.fn();
  render(<Harness onCreate={vi.fn()} canProvision onOpenProvisioning={onOpenProvisioning} />);
  await userEvent.click(screen.getByRole('button', { name: /Cadastrar número no GeeLark/i }));
  expect(onOpenProvisioning).toHaveBeenCalled();
});

it('mostra labels claros no formulário de adicionar número, sem duplicar Configurações do discador', () => {
  render(<Harness onCreate={vi.fn()} />);

  expect(screen.getByText('Adicionar número')).toBeInTheDocument();
  expect(screen.getByText('Identificação')).toBeInTheDocument();
  expect(screen.queryByText('Proteção da linha')).not.toBeInTheDocument();

  expect(screen.getByLabelText(/Nome da linha/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Telefone/i)).toBeInTheDocument();
  expect(screen.queryByLabelText(/Chamadas simultâneas/i)).not.toBeInTheDocument();

  expect(screen.getByText(/Apelido interno para identificar a sessão/i)).toBeInTheDocument();
  expect(screen.getByText(/Configurações do discador/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Criar sessão/i })).toBeInTheDocument();
});

it('envia apenas nome e telefone ao criar a sessão', async () => {
  const onCreate = vi.fn();
  render(<Harness onCreate={onCreate} />);

  await userEvent.type(screen.getByLabelText(/Nome da linha/i), 'Comercial SP');
  await userEvent.type(screen.getByLabelText(/Telefone/i), '5511999999999');
  await userEvent.click(screen.getByRole('button', { name: /Criar sessão/i }));

  expect(onCreate).toHaveBeenCalledWith({ label: 'Comercial SP', phone: '5511999999999' });
});
