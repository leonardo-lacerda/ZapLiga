import { FormEvent, useState } from 'react';
import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { NumbersPage } from './NumbersPage';

beforeEach(() => {
  server.use(http.get('*/api/numbers/loss-causes', () => HttpResponse.json({ days: 30, causes: [] })));
});

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
  expect(screen.getByText('12/60')).toBeInTheDocument();
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

const multiloginPhones = { items: [
  { id: 'ml-1', name: 'Previtas 30', androidVersion: '14', brand: 'samsung', model: 'SM-A546E', takenBy: null },
  { id: 'ml-2', name: 'Previtas 31', androidVersion: '13', brand: 'motorola', model: 'moto g54', takenBy: 'Previtas 9' },
] };

it('escolhe a nova camuflagem de uma linha com o celular da Multilogin e avisa que vale no próximo pareamento', async () => {
  let body: unknown;
  server.use(
    http.get('*/api/multilogin/phones', () => HttpResponse.json(multiloginPhones)),
    http.patch('*/api/numbers/n9/device-profile', async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: 'n9', device_profile_enabled: true, device_profile_active: false, multilogin_phone_id: 'ml-1', device_profile_state: 'pending', device_profile: { android: { manufacturer: 'samsung', device: 'SM-A546E', os_version: '14', mcc: '724', mnc: '05' } } }); }),
  );
  render(<Harness onCreate={vi.fn()} canManageStealth numbers={[{ id: 'n9', label: 'Previtas 30', status: 'connected', canary_status: 'passed' }]} />);

  expect(screen.getByRole('combobox', { name: 'Camuflagem da linha' })).toHaveValue('today');
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Camuflagem da linha' }), 'new');
  const phone = await screen.findByRole('option', { name: /Previtas 30 · samsung SM-A546E · Android 14/ });
  expect(screen.getByRole('option', { name: /usado por Previtas 9/ })).toBeDisabled();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Celular da Multilogin' }), phone);
  await userEvent.click(screen.getByRole('button', { name: 'Salvar camuflagem' }));

  expect(await screen.findByText('Vale no próximo pareamento')).toBeInTheDocument();
  expect(screen.getByText('samsung SM-A546E · Android 14 · 724/05')).toBeInTheDocument();
  expect(body).toEqual({ enabled: true, multiloginPhoneId: 'ml-1' });
});

it('volta uma linha ativa para como está hoje sem pedir celular', async () => {
  let body: unknown;
  server.use(http.patch('*/api/numbers/n10/device-profile', async ({ request }) => { body = await request.json(); return HttpResponse.json({ id: 'n10', device_profile_enabled: false, device_profile_active: true, device_profile_state: 'leaving', device_profile: { android: { manufacturer: 'samsung', device: 'SM-A546E', os_version: '14', mcc: '724', mnc: '05' } } }); }));
  render(<Harness onCreate={vi.fn()} canManageStealth numbers={[{ id: 'n10', label: 'Previtas 32', status: 'connected', canary_status: 'passed', device_profile_enabled: true, device_profile_active: true, multilogin_phone_id: 'ml-1', device_profile_state: 'active' }]} />);

  expect(screen.getByText('Ativa')).toBeInTheDocument();
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Camuflagem da linha' }), 'today');
  await userEvent.click(screen.getByRole('button', { name: 'Salvar camuflagem' }));

  expect(await screen.findByText('Ativa até o próximo pareamento')).toBeInTheDocument();
  expect(body).toEqual({ enabled: false });
});

it('cria a linha já com a nova camuflagem quando o admin escolhe o celular', async () => {
  server.use(http.get('*/api/multilogin/phones', () => HttpResponse.json(multiloginPhones)));
  const onCreate = vi.fn();
  render(<Harness onCreate={onCreate} canManageStealth />);
  await userEvent.type(screen.getByPlaceholderText('Ex.: Comercial SP'), 'Previtas 30');
  await userEvent.click(screen.getByRole('checkbox', { name: /Nova camuflagem \(#5\)/ }));
  const phone = await screen.findByRole('option', { name: /Previtas 30 · samsung/ });
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Celular da Multilogin' }), phone);
  await userEvent.click(screen.getByRole('button', { name: 'Criar sessão' }));
  expect(onCreate).toHaveBeenCalledWith(expect.objectContaining({ label: 'Previtas 30', multiloginPhoneId: 'ml-1' }));
});

it('não mostra a nova camuflagem para quem não é admin do ZapLiga', () => {
  render(<Harness onCreate={vi.fn()} numbers={[{ id: 'n7', label: 'Previtas 16', status: 'connected', canary_status: 'passed' }]} />);
  expect(screen.queryByRole('combobox', { name: 'Camuflagem da linha' })).not.toBeInTheDocument();
});

it('mostra as quedas do mês por causa, a pausa imposta pelo WhatsApp e o motivo informado', async () => {
  server.use(http.get('*/api/numbers/loss-causes', () => HttpResponse.json({ days: 30, causes: [{ cause: 'temp_banned', total: 2, lines: 1 }, { cause: 'device_removed', total: 1, lines: 1 }] })));
  const until = new Date(Date.now() + 3_600_000).toISOString();
  render(<Harness onCreate={vi.fn()} numbers={[
    { id: 'n7', label: 'Previtas 9', status: 'connected', canary_status: 'passed', dial_blocked_until: until, dial_block_cause: 'temp_banned', losses_recent: { temp_banned: 2 } },
    { id: 'n8', label: 'Previtas 10', status: 'disconnected', loss_reason: 'account_locked', loss_cause: 'account_locked', loss_detail: { violationReason: 'other_harm' }, removal_count: 1, canary_status: 'passed' },
  ]} />);
  expect(await screen.findByText('Banimento temporário: 2 (1 linha)')).toBeInTheDocument();
  expect(screen.getByText(/Pausadas até .* · Banimento temporário/)).toBeInTheDocument();
  expect(screen.getByText('Banimento temporário 2')).toBeInTheDocument();
  expect(screen.getByText(/Conta bloqueada: resolver no celular/)).toBeInTheDocument();
  expect(screen.getByText('other_harm')).toBeInTheDocument();
});

it('registra o que o celular mostrou quando o WhatsApp recusou o número', async () => {
  let sent: unknown = null;
  server.use(http.post('*/api/numbers/n9/registration-reason', async ({ request }) => { sent = await request.json(); return HttpResponse.json({ id: 'n9', registration_reason: 'too_many_guesses' }); }));
  render(<Harness onCreate={vi.fn()} numbers={[{ id: 'n9', label: 'Previtas 11', status: 'disconnected', canary_status: 'passed' }]} />);
  await userEvent.selectOptions(screen.getByLabelText('Motivo da recusa de Previtas 11'), 'too_many_guesses');
  await userEvent.click(screen.getByRole('button', { name: /Registrar/ }));
  await waitFor(() => expect(sent).toEqual({ reason: 'too_many_guesses' }));
});
