import type { ReactNode } from 'react';
import type { ButtonVariant } from '../types';

const iconPaths: Record<string, string> = {
  dashboard: 'M4 13h6V4H4v9Zm10 7h6v-9h-6v9ZM4 20h6v-3H4v3Zm10-12h6V4h-6v4Z',
  phone: 'M21 15.5v3a2 2 0 0 1-2.18 2 19.8 19.8 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6A19.8 19.8 0 0 1 1.12 2.8 2 2 0 0 1 3.11.62h3a2 2 0 0 1 2 1.72c.12.9.34 1.78.65 2.63a2 2 0 0 1-.45 2.11L7.04 8.34a16 16 0 0 0 6 6l1.26-1.26a2 2 0 0 1 2.11-.45c.85.31 1.73.53 2.63.65a2 2 0 0 1 1.72 2.22Z',
  users: 'M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8Zm13 10v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75',
  history: 'M3 12a9 9 0 1 0 3-6.7M3 4v5h5M12 7v5l3 2',
  settings: 'M12 15.5a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7Zm8.2-3.5a6.8 6.8 0 0 0-.08-1l2-1.56-2-3.46-2.37.95a7 7 0 0 0-1.74-1L15.65 3h-4l-.36 2.94a7 7 0 0 0-1.74 1l-2.37-.95-2 3.46 2 1.56a7 7 0 0 0 0 2l-2 1.56 2 3.46 2.37-.95a7 7 0 0 0 1.74 1L11.65 21h4l.36-2.94a7 7 0 0 0 1.74-1l2.37.95 2-3.46-2-1.55c.05-.33.08-.66.08-1Z',
  search: 'm21 21-4.35-4.35M10.5 18a7.5 7.5 0 1 1 0-15 7.5 7.5 0 0 1 0 15Z',
  sparkles: 'm12 3-1.3 4.7L6 9l4.7 1.3L12 15l1.3-4.7L18 9l-4.7-1.3L12 3ZM19 15l-.7 2.3L16 18l2.3.7L19 21l.7-2.3L22 18l-2.3-.7L19 15Z',
  close: 'M6 6l12 12M18 6 6 18', copy: 'M8 8h11v11H8zM5 16H4a1 1 0 0 1-1-1V4a1 1 0 0 1 1-1h11a1 1 0 0 1 1 1v1', chevron: 'm6 9 6 6 6-6', refresh: 'M20 11a8 8 0 0 0-14.9-3M4 5v4h4M4 13a8 8 0 0 0 14.9 3M20 19v-4h-4',
  calendar: 'M7 2v4M17 2v4M3 9h18M5 4h14a2 2 0 0 1 2 2v13a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2Z', filter: 'M4 5h16M7 12h10M10 19h4', plus: 'M12 5v14M5 12h14', upload: 'M12 16V4m0 0L7 9m5-5 5 5M5 20h14',
  qr: 'M4 4h6v6H4zM14 4h6v6h-6zM4 14h6v6H4zM14 14h2v2h-2zM18 14h2v6h-6v-2', plug: 'M8 12h8M12 8v8M7 4v4M17 4v4M5 8h14v5a7 7 0 0 1-14 0V8Z', pause: 'M8 5v14M16 5v14', play: 'm8 5 11 7-11 7V5Z',
  headset: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h3v5H5a1 1 0 0 1-1-1v-4Zm16 0h-3v5h2a1 1 0 0 0 1-1v-4Z', check: 'm5 12 4 4L19 6', alert: 'M12 9v4M12 17h.01M10.3 3.4 2.2 18a2 2 0 0 0 1.7 3h16.2a2 2 0 0 0 1.7-3L13.7 3.4a2 2 0 0 0-3.4 0', more: 'M5 12h.01M12 12h.01M19 12h.01', bot: 'M12 3v3m-5 3h10M5 9h14v9H5zM8 13h.01M16 13h.01M9 16h6', chart: 'M4 19V5m0 14h16M8 16v-4m4 4V8m4 8v-7',
};

export function Icon({ name, size = 16 }: { name: string; size?: number }) { return <svg className="icon" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={iconPaths[name] ?? iconPaths.dashboard} /></svg>; }
export function Button({ children, variant = 'primary', icon, className = '', ...props }: { children: ReactNode; variant?: ButtonVariant; icon?: string; className?: string } & React.ButtonHTMLAttributes<HTMLButtonElement>) { return <button className={`button button-${variant} ${className}`} {...props}>{icon && <Icon name={icon} size={15} />}{children}</button>; }
export function Badge({ children, tone = 'neutral' }: { children: ReactNode; tone?: string }) { return <span className={`badge badge-${tone}`}>{children}</span>; }
export function Panel({ children, className = '' }: { children: ReactNode; className?: string }) { return <section className={`panel ${className}`}>{children}</section>; }
export function SectionHeader({ eyebrow, title, description, action }: { eyebrow?: string; title: string; description?: string; action?: ReactNode }) { return <div className="section-header"><div>{eyebrow && <span className="eyebrow">{eyebrow}</span>}<h2>{title}</h2>{description && <p>{description}</p>}</div>{action}</div>; }
export function EmptyState({ title = 'Nada por aqui ainda.', description }: { title?: string; description?: string }) { return <div className="empty-state"><div className="empty-icon"><Icon name="dashboard" size={20} /></div><strong>{title}</strong>{description && <span>{description}</span>}</div>; }
