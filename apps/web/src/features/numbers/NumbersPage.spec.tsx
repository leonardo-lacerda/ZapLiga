import { FormEvent, useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { NumbersPage } from './NumbersPage';

function Harness({ onCreate, canProvision = false, onOpenProvisioning, numbers = [] }: { onCreate: (payload: Record<string, unknown>) => void; canProvision?: boolean; onOpenProvisioning?: () => void; numbers?: Record<string, unknown>[] }) {
  const [numberForm, setNumberForm] = useState({ label: '', phone: '' });
  const createNumber = (event: FormEvent) => {
    event.preventDefault();
    onCreate(numberForm);
  };
  return (
    <NumbersPage
      numbers={numbers}
      numbersTotal={numbers.length}
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

it('conecta por código sem abrir o QR: gera o código de 8 caracteres para digitar no celular', async () => {
  const bodies: unknown[] = [];
  server.use(http.post('*/api/numbers/number-1/pair', async ({ request }) => {
    bodies.push(await request.json());
    return HttpResponse.json({ code: 'ABCDEFGH', timeout_seconds: 180 });
  }));
  const showQr = vi.fn();
  render(<Harness onCreate={vi.fn()} numbers={[
    { id: 'number-1', label: 'Comercial SP', phone: '', status: 'disconnected', max_concurrent_calls: 1 },
    { id: 'number-2', label: 'Ligada', phone: '5527999990000', status: 'connected', max_concurrent_calls: 1 },
  ]} />);

  // Só a linha desconectada oferece conectar.
  expect(screen.getAllByRole('button', { name: 'Conectar por código' })).toHaveLength(1);
  await userEvent.click(screen.getByRole('button', { name: 'Conectar por código' }));
  const dialog = screen.getByRole('dialog', { name: 'Conectar por código' });
  await userEvent.type(within(dialog).getByLabelText('Telefone do WhatsApp'), '5527981545066');
  await userEvent.click(within(dialog).getByRole('button', { name: 'Gerar código' }));

  expect(await within(dialog).findByLabelText('Código de conexão')).toHaveTextContent('ABCD-EFGH');
  expect(bodies).toEqual([{ phone: '5527981545066' }]);
  expect(showQr).not.toHaveBeenCalled();
  await userEvent.click(within(dialog).getByRole('button', { name: 'Fechar modal' }));
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

it('marca uma linha como só para verificação de WhatsApp', async () => {
  const bodies: unknown[] = [];
  server.use(http.patch('*/api/numbers/number-2/settings', async ({ request }) => {
    const body = await request.json() as Record<string, unknown>;
    bodies.push(body);
    return HttpResponse.json({ id: 'number-2', verification_only: body.verificationOnly });
  }));
  render(<Harness onCreate={vi.fn()} numbers={[
    { id: 'number-2', label: 'Telefone 4', phone: '5527999990000', status: 'connected', max_concurrent_calls: 1, verification_only: false },
  ]} />);

  const toggle = screen.getByRole('checkbox', { name: /Só para verificação de WhatsApp/ });
  expect(toggle).not.toBeChecked();
  await userEvent.click(toggle);
  await waitFor(() => expect(toggle).toBeChecked());
  expect(bodies).toEqual([{ verificationOnly: true }]);
});
