import { cn } from '../../lib/utils.js';

/**
 * Minimal shadcn-style button. Variants: primary, ghost, outline.
 */
export default function Button({
  children,
  variant = 'primary',
  size = 'md',
  className,
  as: Tag = 'button',
  ...rest
}) {
  const base =
    'relative inline-flex items-center justify-center gap-2 rounded-full font-medium transition-all duration-300 ease-out select-none focus:outline-none focus-visible:ring-2 focus-visible:ring-brand-violet/60 disabled:opacity-50 disabled:pointer-events-none';

  const sizes = {
    sm: 'h-9 px-4 text-sm',
    md: 'h-11 px-6 text-[15px]',
    lg: 'h-14 px-8 text-base',
  };

  const variants = {
    primary:
      'text-white bg-brand-gradient shadow-[0_10px_40px_-10px_rgba(99,102,241,0.6)] hover:shadow-[0_18px_60px_-12px_rgba(139,92,246,0.7)] hover:-translate-y-0.5',
    ghost:
      'text-ink-primary bg-white/5 border border-white/10 hover:bg-white/10 hover:border-white/20',
    outline:
      'text-ink-primary bg-transparent border border-white/15 hover:bg-white/5 hover:border-white/30',
  };

  return (
    <Tag className={cn(base, sizes[size], variants[variant], className)} {...rest}>
      {children}
    </Tag>
  );
}
