import { motion } from 'framer-motion';
import { Download as DownloadIcon, Smartphone, ShieldAlert } from 'lucide-react';
import Button from './ui/Button.jsx';
import { fadeUp, stagger, viewport } from '../lib/utils.js';

export default function Download() {
  return (
    <section id="download" className="section relative">
      <div className="container-narrow">
        <motion.div
          variants={stagger()}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="relative mx-auto max-w-4xl overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-b from-white/[0.04] to-white/[0.01] p-10 text-center md:p-16"
        >
          <div
            aria-hidden="true"
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(500px 280px at 50% -10%, rgba(99,102,241,0.25), transparent 70%)',
            }}
          />

          <motion.div
            variants={fadeUp}
            className="relative inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-3.5 py-1 text-xs text-ink-secondary"
          >
            <Smartphone className="h-3.5 w-3.5 text-brand-violet" />
            Android · v1.0.0-beta
          </motion.div>

          <motion.h2
            variants={fadeUp}
            className="relative mt-6 font-display text-3xl leading-tight tracking-tight md:text-5xl"
          >
            Install once. <span className="text-gradient-brand">Never feel alone again.</span>
          </motion.h2>

          <motion.p
            variants={fadeUp}
            className="relative mx-auto mt-5 max-w-xl text-base text-ink-secondary md:text-lg"
          >
            Sideload the APK and grant the permissions LifeOS needs to start watching.
            The first useful insights show up by day three.
          </motion.p>

          <motion.div
            variants={fadeUp}
            className="relative mt-10 flex flex-col items-center gap-3"
          >
            <Button as="a" href="/lifeos.apk" download size="lg" className="px-10">
              <DownloadIcon className="h-5 w-5" />
              Download for Android
            </Button>
            <p className="mt-3 inline-flex items-center gap-2 text-xs text-ink-muted">
              <ShieldAlert className="h-3.5 w-3.5" />
              Sideload APK — enable "Install from unknown sources" in Android settings.
            </p>
          </motion.div>
        </motion.div>
      </div>
    </section>
  );
}
