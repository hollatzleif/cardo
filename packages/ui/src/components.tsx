import { forwardRef } from 'react';
import type { ButtonHTMLAttributes, InputHTMLAttributes, ReactNode } from 'react';

/** Shared component library – tools build on these, never on raw styles. */

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: 'default' | 'primary' | 'danger' | 'ghost';
};

export function Button({ variant = 'default', className = '', ...rest }: ButtonProps) {
  const variantClass = variant === 'default' ? '' : ` c-btn--${variant}`;
  return <button className={`c-btn${variantClass} ${className}`} {...rest} />;
}

export const Input = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(
  function Input({ className = '', ...rest }, ref) {
    return <input ref={ref} className={`c-input ${className}`} {...rest} />;
  },
);

export function Card({ children, className = '', style }: { children: ReactNode; className?: string; style?: React.CSSProperties }) {
  return (
    <div className={`c-card ${className}`} style={style}>
      {children}
    </div>
  );
}

export function Modal({ children, onClose }: { children: ReactNode; onClose: () => void }) {
  return (
    <div
      className="c-modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div className="c-modal" role="dialog" aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export function PrivacyBadge({ level, label }: { level: 'green' | 'yellow'; label: string }) {
  return <span className={`c-badge c-badge--${level}`}>{level === 'green' ? '●' : '●'} {label}</span>;
}

/**
 * Numbered in-app setup guide. Tools with configuration/import needs render
 * this in their empty state; the market shows the same steps before
 * activation. Steps arrive already translated – the component knows nothing
 * about i18n, which keeps it usable from both the host and sandboxed tools.
 */
export function SetupGuide({
  title,
  steps,
  children,
}: {
  title: string;
  steps: Array<{ title: string; body: string }>;
  children?: ReactNode;
}) {
  return (
    <div className="c-setup-guide">
      <div className="c-setup-guide__title">{title}</div>
      <ol className="c-setup-guide__steps">
        {steps.map((step, i) => (
          <li key={i} className="c-setup-guide__step">
            <span className="c-setup-guide__num" aria-hidden="true">
              {i + 1}
            </span>
            <div>
              <div className="c-setup-guide__step-title">{step.title}</div>
              <div className="c-setup-guide__step-body c-muted">{step.body}</div>
            </div>
          </li>
        ))}
      </ol>
      {children}
    </div>
  );
}
