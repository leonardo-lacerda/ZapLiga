import type { ReactNode } from 'react';
import { Icon } from '../../components/ui';

type AuthMode = 'login' | 'register';

export function AuthBrand({ compact = false }: { compact?: boolean }) {
  return <div className={`auth-brand ${compact ? 'auth-brand-compact' : ''}`}>
    <span className="brand-mark"><Icon name="phone" size={compact ? 16 : 18} /></span>
    <strong>Zap<span>Liga</span></strong>
  </div>;
}

export function AuthShell({ mode, children }: { mode: AuthMode; children: ReactNode }) {
  const isRegister = mode === 'register';

  return <div className={`auth-shell auth-shell-${mode}`}>
    <div className="auth-glow auth-glow-one" />
    <div className="auth-glow auth-glow-two" />
    <div className={`auth-layout ${isRegister ? 'auth-layout-register' : ''}`}>
      <aside className="auth-showcase">
        <AuthBrand />
        <div className="auth-showcase-copy">
          <span className="auth-kicker">{isRegister ? 'SUA OPERAÇÃO COMEÇA AQUI' : 'CENTRAL DE OPERAÇÃO SDR'}</span>
          <h2>{isRegister ? 'Estruture seu time para vender mais.' : 'Transforme cada ligação em uma oportunidade.'}</h2>
          <p>{isRegister ? 'Tenha uma visão clara dos seus contatos, números e resultados desde o primeiro dia.' : 'Uma central simples e poderosa para organizar contatos, discadores e o ritmo do seu time.'}</p>
          <div className="auth-feature-list">
            <div><span className="auth-feature-icon"><Icon name="check" size={14} /></span><span>{isRegister ? 'Cadastre sua empresa em poucos passos' : 'Acompanhe sua operação em tempo real'}</span></div>
            <div><span className="auth-feature-icon"><Icon name="check" size={14} /></span><span>Mais foco para o seu time comercial</span></div>
            <div><span className="auth-feature-icon"><Icon name="check" size={14} /></span><span>Dados organizados em um só lugar</span></div>
          </div>
        </div>
        <div className="auth-showcase-note"><span className="auth-note-dot" /> Feito para operações que não podem parar</div>
      </aside>
      <main className="auth-main">
        <div className="auth-mobile-brand"><AuthBrand compact /></div>
        {children}
        <p className="auth-copyright">© 2026 ZapLiga · Operação mais inteligente, todos os dias.</p>
      </main>
    </div>
  </div>;
}
