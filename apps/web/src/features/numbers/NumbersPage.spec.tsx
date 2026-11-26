import { FormEvent, useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { NumbersPage } from './NumbersPage';

function Harness({ onCreate, canProvision = false, onOpenProvisioning, numbers = [], canManageStealth = false }: { onCreate: (payload: Record<string, unknown>) => void; canProvision?: boolean; onOpenProvisioning?: () => void; numbers?: Record<string, unknown>[]; canManageStealth?: boolean }) {
  const [numberForm, setNumberForm] = useState<Record<string, unknown>>({ label: '', phone: '' });
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
      canManageStealth={canManageStealth}
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

it('mostra por que a linha caiu, as ligações de hoje da linha jovem e as reconexões', () => {
  render(<Harness onCreate={vi.fn()} numbers={[
    { id: 'n1', label: 'Previtas 7', status: 'disconnected', loss_reason: 'device_removed', removal_count: 1, canary_status: 'pending' },
    { id: 'n2', label: 'Previtas 8', status: 'disconnected', loss_reason: 'account_locked', removal_count: 2, canary_status: 'pending' },
    { id: 'n3', label: 'Previtas 12', status: 'connected', canary_status: 'passed', young: true, calls_today: 12, reconnects_24h: 3 },
  ]} />);
  expect(screen.getByText(/Removida pelo WhatsApp/)).toBeInTheDocument();
  expect(screen.getByText(/Aposentada: o WhatsApp tirou este número 2 vezes/)).toBeInTheDocument();
  expect(screen.getByText('12/40')).toBeInTheDocument();
  expect(screen.getByText('Reconexões em 24 h')).toBeInTheDocument();
});

it('conduz o canário: manda a mensagem e liga para o celular da equipe devolvido', async () => {
  const canaryCall = vi.fn(async () => undefined);
  server.use(http.post('/api/numbers/n4/canary/message', () => HttpResponse.json({ phone: '5527999990000' })));
  render(<NumbersPage numbers={[{ id: 'n4', label: 'Previtas 13', status: 'connected', canary_status: 'pending' }]} numbersTotal={1} numbersOffset={0} onNumbersPageChange={() => undefined} numberForm={{ label: '', phone: '' }} setNumberForm={() => undefined} createNumber={() => undefined} showQr={() => undefined} reconnectNumber={() => undefined} removeNumber={() => undefined} qrLoading={false} qr={null} closeQr={() => undefined} canManageNumbers canaryCall={canaryCall} stationReady />);
  expect(screen.getByText('Aguardando canário')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /1\. Enviar mensagem/ }));
  await userEvent.click(await screen.findByRole('button', { name: /2\. Ligar para 5527999990000/ }));
  expect(canaryCall).toHaveBeenCalledWith('n4', '5527999990000');
});

it('não oferece o canário enquanto a linha está no bloqueio de 24 h', () => {
  render(<Harness onCreate={vi.fn()} numbers={[{ id: 'n5', label: 'Previtas 14', status: 'connected', canary_status: 'pending', flagged_until: new Date(Date.now() + 3_600_000).toISOString() }]} />);
  expect(screen.getByText('Aguardando canário')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: /Enviar mensagem/ })).not.toBeInTheDocument();
});

it('libera pelo painel uma linha no bloqueio sem a ligação de teste', async () => {
  let released = false;
  server.use(http.post('/api/numbers/n6/canary/pass', () => { released = true; return HttpResponse.json({ id: 'n6', canary_status: 'passed' }); }));
  vi.spyOn(window, 'confirm').mockReturnValue(true);
  render(<Harness onCreate={vi.fn()} numbers={[{ id: 'n6', label: 'Previtas 15', status: 'connected', canary_status: 'pending', flagged_until: new Date(Date.now() + 3_600_000).toISOString() }]} />);
  await userEvent.click(screen.getByRole('button', { name: /Liberar sem teste/ }));
  await waitFor(() => expect(released).toBe(true));
  expect(screen.queryByText('Aguardando canário')).not.toBeInTheDocument();
});

it('esconde a camuflagem de quem não é admin do ZapLiga', () => {
  render(<Harness onCreate={vi.fn()} numbers={[{ id: 'n7', label: 'Previtas 16', status: 'connected', canary_status: 'passed' }]} />);
  expect(screen.queryByText('Camuflagem de navegador (teste)')).not.toBeInTheDocument();
});

it('cria a linha já com a camuflagem quando o admin marca a opção', async () => {
  const onCreate = vi.fn();
  render(<Harness onCreate={onCreate} canManageStealth />);
  await userEvent.type(screen.getByPlaceholderText('Ex.: Comercial SP'), 'Previtas 20');
  await userEvent.click(screen.getByRole('checkbox', { name: /Camuflagem de navegador/ }));
  await userEvent.click(screen.getByRole('button', { name: 'Criar sessão' }));
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ label: 'Previtas 20', stealth: true }));
});

it('liga a camuflagem de uma linha e avisa quando ela só vale no login', async () => {
  let body: unknown;
  server.use(http.patch('/api/numbers/n8/stealth', async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: 'n8', stealth_enabled: true, stealth_coverage: 'PARTIAL' }); }));
  render(<NumbersPage numbers={[{ id: 'n8', label: 'Previtas 17', status: 'connected', canary_status: 'passed' }]} numbersTotal={1} numbersOffset={0} onNumbersPageChange={() => undefined} numberForm={{ label: '', phone: '' }} setNumberForm={() => undefined} createNumber={() => undefined} showQr={() => undefined} reconnectNumber={() => undefined} removeNumber={() => undefined} qrLoading={false} qr={null} closeQr={() => undefined} canManageStealth />);
  await userEvent.click(screen.getByRole('checkbox', { name: /Camuflagem de navegador/ }));
  expect(await screen.findByText('Parcial: refaça o QR para valer no registro')).toBeInTheDocument();
  expect(body).toEqual({ enabled: true });
});
