export function cn(...inputs) {
  return inputs.filter(Boolean).join(' ');
}

export const fadeUp = {
  hidden: { opacity: 0, y: 24 },
  show: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.7, ease: [0.2, 0.8, 0.2, 1] },
  },
};

export const stagger = (delay = 0.12) => ({
  hidden: {},
  show: { transition: { staggerChildren: delay, delayChildren: 0.1 } },
});

export const viewport = { once: true, amount: 0.2 };
