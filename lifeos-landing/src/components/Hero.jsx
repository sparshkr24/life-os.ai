import { motion } from 'framer-motion';
import { ArrowRight, Download as DownloadIcon, Sparkles } from 'lucide-react';
import Button from './ui/Button.jsx';
import AmbientBackground from './AmbientBackground.jsx';
import { fadeUp, stagger } from '../lib/utils.js';

export default function Hero() {
  return (
    <section
      id="top"
      className="relative flex min-h-[100svh] items-center justify-center overflow-hidden px-6 pt-24 md:px-10"
    >
      <AmbientBackground />

      <motion.div
        variants={stagger(0.15)}
        initial="hidden"
        animate="show"
        className="relative z-10 mx-auto flex max-w-5xl flex-col items-center text-center"
      >
        <motion.div
          variants={fadeUp}
          className="mb-7 inline-flex items-center gap-2 rounded-full border border-white/10 bg-white/[0.04] px-4 py-1.5 text-xs text-ink-secondary backdrop-blur-md"
        >
          <Sparkles className="h-3.5 w-3.5 text-brand-violet" />
          <span>On-device AI · Android · v1.0.0-beta</span>
        </motion.div>

        <motion.h1
          variants={fadeUp}
          className="font-display text-[40px] leading-[1.05] tracking-tightest md:text-[72px]"
        >
          <span className="text-gradient">Meet another</span>
          <br />
          <span className="text-gradient-brand">you.</span>
        </motion.h1>

        <motion.p
          variants={fadeUp}
          className="mt-7 max-w-2xl text-base text-ink-secondary md:text-lg"
        >
          LifeOS is a personal AI that lives on your phone, learns your behavior 24/7,
          and quietly helps you become who you actually want to be.
        </motion.p>

        <motion.div
          variants={fadeUp}
          className="mt-10 flex flex-col items-center gap-3 sm:flex-row sm:gap-4"
        >
          <Button as="a" href="/lifeos.apk" download size="lg">
            <DownloadIcon className="h-5 w-5" />
            Download APK
          </Button>
          <Button as="a" href="#how" variant="ghost" size="lg">
            Learn more
            <ArrowRight className="h-4 w-4" />
          </Button>
        </motion.div>

        <motion.div
          variants={fadeUp}
          className="mt-14 grid w-full max-w-3xl grid-cols-3 gap-4 text-center"
        >
          {[
            ['8+', 'data sources'],
            ['100%', 'on-device'],
            ['0', 'cloud servers'],
          ].map(([num, label]) => (
            <div
              key={label}
              className="glass rounded-xl px-3 py-4 md:px-5 md:py-5"
            >
              <div className="text-gradient-brand font-display text-2xl font-bold md:text-3xl">
                {num}
              </div>
              <div className="mt-1 text-[11px] uppercase tracking-wider text-ink-muted md:text-xs">
                {label}
              </div>
            </div>
          ))}
        </motion.div>
      </motion.div>

      {/* Scroll cue */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        transition={{ delay: 1.2, duration: 0.8 }}
        className="absolute bottom-8 left-1/2 z-10 -translate-x-1/2"
      >
        <div className="flex h-9 w-6 justify-center rounded-full border border-white/15 p-1.5">
          <motion.div
            animate={{ y: [0, 10, 0] }}
            transition={{ duration: 1.6, repeat: Infinity, ease: 'easeInOut' }}
            className="h-2 w-1 rounded-full bg-white/40"
          />
        </div>
      </motion.div>
    </section>
  );
}
