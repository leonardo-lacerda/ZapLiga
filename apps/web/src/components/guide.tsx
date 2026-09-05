import type { ReactNode } from 'react';
import { Button, Icon, Panel } from './ui';

// Shared building blocks for the "operação avançada" pages (campanhas, saúde,
// aprendizado, experimentos, benchmarks). They exist so every one of those
// screens opens the same way: what this page is for, in one sentence a leader
// understands, then the content. Jargon stays out of the headings and goes
// into a "detalhes técnicos" disclosure when it has to exist at all.

export function PageIntro({ eyebrow, title, purpose, aside }: { eyebrow: string; title: string; purpose: string; aside?: ReactNode }) {
  return <div className="page-heading guide-heading">
    <div><span className="eyebrow">{eyebrow}</span><h1>{title}</h1><p className="guide-purpose">{purpose}</p></div>
    {aside && <div className="guide-heading-aside">{aside}</div>}
  </div>;
}

export type FlowStep = { key: string; label: string; hint: string };

// A real sequence (rascunho → publicada → em andamento). `current` marks where
// the selected item is; earlier steps read as done.
export function FlowSteps({ steps, current, label }: { steps: FlowStep[]; current?: string; label: string }) {
  const currentIndex = steps.findIndex((step) => step.key === current);
  return <ol className="flow-steps" aria-label={label}>
    {steps.map((step, index) => <li key={step.key} className={index === currentIndex ? 'is-current' : currentIndex > index ? 'is-done' : ''}>
      <span className="flow-step-mark">{currentIndex > index ? <Icon name="check" size={12} /> : index + 1}</span>
      <span className="flow-step-copy"><strong>{step.label}</strong><small>{step.hint}</small></span>
    </li>)}
  </ol>;
}

// Three or four plain facts about how a page works. Not a sequence: no numbers.
export function HowItWorks({ items }: { items: Array<{ icon: string; title: string; text: string }> }) {
  return <div className="how-grid">
    {items.map((item) => <div className="how-item" key={item.title}><span className="how-icon"><Icon name={item.icon} size={15} /></span><div><strong>{item.title}</strong><p>{item.text}</p></div></div>)}
  </div>;
}

export function FactGrid({ facts, columns = 4 }: { facts: Array<{ label: string; value: ReactNode; hint?: string }>; columns?: 2 | 3 | 4 }) {
  return <div className={`fact-grid fact-grid-${columns}`}>
    {facts.map((fact) => <div className="fact" key={fact.label}><span>{fact.label}</span><strong>{fact.value}</strong>{fact.hint && <small>{fact.hint}</small>}</div>)}
  </div>;
}

export function Notice({ tone = 'info', children, onClose }: { tone?: 'info' | 'success' | 'warning' | 'error'; children: ReactNode; onClose?: () => void }) {
  const icon = tone === 'success' ? 'check' : tone === 'info' ? 'info' : 'alert';
  return <div className={`notice notice-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
    <Icon name={icon} size={15} /><span>{children}</span>
    {onClose && <button type="button" className="notice-close" aria-label="Fechar aviso" onClick={onClose}><Icon name="close" size={13} /></button>}
  </div>;
}

export function TechnicalDetails({ summary = 'Detalhes técnicos', children }: { summary?: string; children: ReactNode }) {
  return <details className="tech-details"><summary>{summary}</summary><div>{children}</div></details>;
}

// Every advanced page is behind a per-company switch. Say what the page would
// do, and who can turn it on, instead of a bare lock icon.
export function FeatureOff({ title, description }: { title: string; description: string }) {
  return <Panel className="feature-off">
    <span className="feature-off-icon"><Icon name="lock" size={20} /></span>
    <div><strong>{title}</strong><p>{description}</p><small>Um super admin habilita este recurso em Admin → Detalhes da empresa → Recursos da empresa.</small></div>
  </Panel>;
}

export function LoadingBlock({ children }: { children: ReactNode }) {
  return <div className="loading-block">{children}</div>;
}

export function EmptyGuide({ icon = 'dashboard', title, text, action }: { icon?: string; title: string; text: string; action?: { label: string; onClick: () => void; icon?: string } }) {
  return <div className="empty-guide">
    <span className="empty-guide-icon"><Icon name={icon} size={18} /></span>
    <strong>{title}</strong>
    <p>{text}</p>
    {action && <Button variant="secondary" icon={action.icon} onClick={action.onClick}>{action.label}</Button>}
  </div>;
}
