import { cn } from '../../lib/utils.js';

export default function Card({ children, className, ...rest }) {
  return (
    <div
      className={cn(
        'glass glass-hover rounded-2xl p-6 md:p-7',
        className,
      )}
      {...rest}
    >
      {children}
    </div>
  );
}
