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
