import { useEffect, useState } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { Download as DownloadIcon, Menu, X } from 'lucide-react';
import Button from './ui/Button.jsx';

const links = [
  { href: '#how', label: 'How it works' },
  { href: '#features', label: 'Features' },
  { href: '#privacy', label: 'Privacy' },
  { href: '#contact', label: 'Contact' },
];

export default function Navbar() {
  const [scrolled, setScrolled] = useState(false);
  const [open, setOpen] = useState(false);

  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 24);
    onScroll();
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <motion.header
      initial={{ y: -24, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      transition={{ duration: 0.6, ease: [0.2, 0.8, 0.2, 1] }}
      className={`fixed inset-x-0 top-0 z-50 transition-all duration-300 ${
        scrolled
          ? 'backdrop-blur-xl bg-bg/70 border-b border-white/[0.06]'
          : 'bg-transparent'
      }`}
    >
      <div className="container-narrow flex h-16 items-center justify-between px-6 md:px-10">
        <a href="#top" className="flex items-center gap-2.5">
          <img
            src="/lifeos-logo.png"
            alt="LifeOS"
            className="h-9 w-9 rounded-lg object-contain"
            width={36}
            height={36}
          />
          <span className="font-display text-lg font-semibold tracking-tight">
            LifeOS
          </span>
        </a>

        <nav className="hidden items-center gap-8 md:flex">
          {links.map((l) => (
            <a
              key={l.href}
              href={l.href}
              className="text-sm text-ink-secondary transition-colors hover:text-ink-primary"
            >
              {l.label}
            </a>
          ))}
        </nav>

        <div className="hidden md:block">
          <Button as="a" href="#download" size="sm" variant="primary">
            <DownloadIcon className="h-4 w-4" />
            Download
          </Button>
        </div>

        <button
          aria-label="Toggle menu"
          className="md:hidden flex h-10 w-10 items-center justify-center rounded-lg border border-white/10 bg-white/5"
          onClick={() => setOpen((v) => !v)}
        >
          {open ? <X className="h-5 w-5" /> : <Menu className="h-5 w-5" />}
        </button>
      </div>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, height: 0 }}
            animate={{ opacity: 1, height: 'auto' }}
            exit={{ opacity: 0, height: 0 }}
            transition={{ duration: 0.25 }}
            className="md:hidden overflow-hidden border-t border-white/[0.06] bg-bg/90 backdrop-blur-xl"
          >
            <div className="flex flex-col gap-1 px-6 py-4">
              {links.map((l) => (
                <a
                  key={l.href}
                  href={l.href}
                  onClick={() => setOpen(false)}
                  className="rounded-lg px-3 py-3 text-sm text-ink-secondary hover:bg-white/5 hover:text-ink-primary"
                >
                  {l.label}
                </a>
              ))}
              <Button as="a" href="#download" size="sm" className="mt-2 w-full">
                <DownloadIcon className="h-4 w-4" />
                Download APK
              </Button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.header>
  );
}
