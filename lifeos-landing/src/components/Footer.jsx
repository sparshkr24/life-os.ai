export default function Footer() {
  return (
    <footer className="relative border-t border-white/[0.06] px-6 py-12 md:px-10">
      <div className="container-narrow flex flex-col items-start justify-between gap-8 md:flex-row md:items-center">
        <div>
          <div className="flex items-center gap-2.5">
            <img
              src="/lifeos-logo.png"
              alt="LifeOS"
              className="h-8 w-8 rounded-md object-contain"
              width={32}
              height={32}
            />
            <span className="font-display text-base font-semibold">LifeOS</span>
          </div>
          <p className="mt-3 max-w-xs text-sm text-ink-secondary">
            A personal AI that lives on your phone. Watches, learns, and quietly
            becomes another you.
          </p>
        </div>

        <nav className="flex flex-wrap items-center gap-x-7 gap-y-3 text-sm text-ink-secondary">
          <a href="#download" className="transition-colors hover:text-ink-primary">
            Download
          </a>
          <a href="#privacy" className="transition-colors hover:text-ink-primary">
            Privacy
          </a>
          <a href="#contact" className="transition-colors hover:text-ink-primary">
            Contact
          </a>
        </nav>
      </div>

      <div className="container-narrow mt-10 flex flex-col items-start justify-between gap-3 border-t border-white/[0.05] pt-6 text-xs text-ink-muted md:flex-row md:items-center">
        <span>© {new Date().getFullYear()} LifeOS. All rights stay on your device.</span>
        <span>No cookies. No tracking. No cloud.</span>
      </div>
    </footer>
  );
}
