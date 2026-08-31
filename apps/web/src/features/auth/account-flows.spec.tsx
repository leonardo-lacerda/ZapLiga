import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { vi } from 'vitest';
import { server } from '../../test/setup';
import { ForgotPasswordPage } from './AccountRecoveryPages';
import { RegisterPage } from './RegisterPage';
import { EmailVerificationGate } from './AccountGates';

describe('account flows', () => {
  it('does not expose whether an email exists during recovery', async () => {
    server.use(http.post('http://localhost:3000/api/auth/password/forgot', () => HttpResponse.json({ message: 'Se existir uma conta com este e-mail, enviaremos as instruções.' })));
    render(<ForgotPasswordPage />);
    await userEvent.type(screen.getByLabelText('E-mail'), 'unknown@example.com');
    await userEvent.click(screen.getByRole('button', { name: 'Enviar instruções' }));
    expect(await screen.findByText(/Se existir uma conta/)).toBeInTheDocument();
  });

  it('requires explicit legal acceptance in registration', async () => {
    const register = vi.fn().mockResolvedValue(undefined);
    render(<RegisterPage register={register} />);
    const inputs = screen.getAllByRole('textbox');
    await userEvent.type(inputs[0], 'Líder Teste'); await userEvent.type(inputs[1], 'leader@example.com');
    fireEvent.change(screen.getByPlaceholderText('Crie uma senha segura'), { target: { value: 'senha-segura' } });
    await userEvent.type(screen.getByPlaceholderText('Ex.: Acme Comercial'), 'Empresa Teste');
    await userEvent.click(screen.getByRole('button', { name: /Criar minha operação/ }));
    expect(register).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('checkbox'));
    await userEvent.click(screen.getByRole('button', { name: /Criar minha operação/ }));
    await waitFor(() => expect(register).toHaveBeenCalledWith(expect.objectContaining({ legalAccepted: true })));
  });

  it('lets an unverified user resend the verification safely', async () => {
    server.use(http.post('http://localhost:3000/api/auth/email/resend-verification', () => HttpResponse.json({ message: 'Se a conta estiver pendente, enviaremos um novo link.' })));
    render(<EmailVerificationGate session={{ user: { id: 'u1', name: 'User', email: 'user@example.com', platformRole: 'user', status: 'active' }, tenants: [] }} reload={vi.fn()} />);
    await userEvent.click(screen.getByRole('button', { name: 'Reenviar verificação' }));
    expect(await screen.findByText(/Se a conta estiver pendente/)).toBeInTheDocument();
  });
});
