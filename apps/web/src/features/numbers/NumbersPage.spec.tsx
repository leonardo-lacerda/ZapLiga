import { FormEvent, useState } from 'react';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { vi } from 'vitest';
import { NumbersPage } from './NumbersPage';

function Harness({ onCreate }: { onCreate: (payload: Record<string, unknown>) => void }) {
  const [numberForm, setNumberForm] = useState({
    label: '',
    phone: '',
    maxConcurrentCalls: 1,
    cooldownSeconds: 60,
    maxCallsPerWindow: 3,
    callWindowSeconds: 180,
  });
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
    />
  );
}

it('mostra labels claros no formulário de adicionar número', () => {
  render(<Harness onCreate={vi.fn()} />);

  expect(screen.getByText('Adicionar número')).toBeInTheDocument();
  expect(screen.getByText('Identificação')).toBeInTheDocument();
  expect(screen.getByText('Proteção da linha')).toBeInTheDocument();

  expect(screen.getByLabelText(/Nome da linha/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Telefone/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Chamadas simultâneas/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Espera entre chamadas/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Tentativas na janela/i)).toBeInTheDocument();
  expect(screen.getByLabelText(/Janela de proteção/i)).toBeInTheDocument();

  expect(screen.getByText(/Apelido interno para identificar a sessão/i)).toBeInTheDocument();
  expect(screen.getByText(/Pausa mínima após cada chamada/i)).toBeInTheDocument();
  expect(screen.getByText(/Máximo de tentativas nesta linha/i)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Criar sessão/i })).toBeInTheDocument();
});

it('envia os campos preenchidos ao criar a sessão', async () => {
  const onCreate = vi.fn();
  render(<Harness onCreate={onCreate} />);

  await userEvent.type(screen.getByLabelText(/Nome da linha/i), 'Comercial SP');
  await userEvent.type(screen.getByLabelText(/Telefone/i), '5511999999999');
  await userEvent.clear(screen.getByLabelText(/Chamadas simultâneas/i));
  await userEvent.type(screen.getByLabelText(/Chamadas simultâneas/i), '2');
  await userEvent.click(screen.getByRole('button', { name: /Criar sessão/i }));

  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({
    label: 'Comercial SP',
    phone: '5511999999999',
    maxConcurrentCalls: 2,
    cooldownSeconds: 60,
    maxCallsPerWindow: 3,
    callWindowSeconds: 180,
  }));
});
