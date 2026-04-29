import { motion } from 'framer-motion';
import { Lock, CloudOff, Trash2 } from 'lucide-react';
import { fadeUp, stagger, viewport } from '../lib/utils.js';

const points = [
  {
    icon: Lock,
    title: 'Fully on-device',
    desc: 'Every event, every memory, every prediction is processed and stored on your phone.',
  },
  {
    icon: CloudOff,
    title: 'Zero cloud sync',
    desc: 'No account, no servers, no analytics pipeline. The only outbound traffic is your chosen LLM key.',
  },
  {
    icon: Trash2,
    title: 'Wipe on uninstall',
    desc: 'Delete the app and everything it ever learned about you is gone. No recovery, no backup, no trace.',
  },
];

export default function Privacy() {
  return (
    <section id="privacy" className="section relative">
      <div className="container-narrow">
        <motion.div
          variants={stagger()}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="relative overflow-hidden rounded-3xl border border-white/[0.08] bg-gradient-to-br from-white/[0.03] to-white/[0.01] p-8 md:p-16"
        >
          {/* Soft inner glow */}
          <div
            aria-hidden="true"
            className="pointer-events-none absolute -inset-px rounded-3xl opacity-40"
            style={{
              background:
                'radial-gradient(600px 240px at 80% 0%, rgba(139,92,246,0.18), transparent 70%)',
            }}
          />

          <div className="relative grid items-start gap-10 md:grid-cols-2 md:gap-16">
            <div>
              <motion.span
                variants={fadeUp}
                className="text-xs uppercase tracking-[0.3em] text-brand-cyan"
              >
                Privacy
              </motion.span>
              <motion.h2
                variants={fadeUp}
                className="mt-5 font-display text-3xl leading-[1.1] tracking-tight md:text-5xl"
              >
                Your data never
                <br />
                <span className="text-gradient-brand">leaves your phone.</span>
              </motion.h2>
              <motion.p
                variants={fadeUp}
                className="mt-6 text-base text-ink-secondary md:text-lg"
              >
                LifeOS is sideload-only. There is no backend. There is no us watching. The
                most personal model you'll ever use is also the most private one.
              </motion.p>
            </div>

            <motion.ul variants={stagger(0.12)} className="space-y-4">
              {points.map((p) => (
                <motion.li
                  key={p.title}
                  variants={fadeUp}
                  className="glass glass-hover flex gap-5 rounded-2xl p-5 md:p-6"
                >
                  <div className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl bg-brand-gradient/10 border border-white/10">
                    <p.icon className="h-5 w-5 text-brand-cyan" />
                  </div>
                  <div>
                    <h3 className="font-display text-lg tracking-tight">{p.title}</h3>
                    <p className="mt-1.5 text-sm text-ink-secondary">{p.desc}</p>
                  </div>
                </motion.li>
              ))}
            </motion.ul>
          </div>
        </motion.div>
      </div>
    </section>
  );
}
