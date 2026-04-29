import { motion } from 'framer-motion';
import { Eye, BrainCircuit, UserCheck } from 'lucide-react';
import { fadeUp, stagger, viewport } from '../lib/utils.js';

const steps = [
  {
    icon: Eye,
    title: 'Watches',
    desc: '24/7 passive collection from 8+ signals — phone usage, sleep, location, health, notifications, motion.',
    tag: '01',
  },
  {
    icon: BrainCircuit,
    title: 'Learns',
    desc: 'On-device LLM builds cause-effect chains. A vector memory store refines your patterns every single night.',
    tag: '02',
  },
  {
    icon: UserCheck,
    title: 'Becomes you',
    desc: 'Predicts your decisions, surfaces what\u2019s holding you back, and nudges with the right intensity at the right moment.',
    tag: '03',
  },
];

export default function HowItWorks() {
  return (
    <section id="how" className="section relative">
      <div className="container-narrow">
        <motion.div
          variants={stagger()}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="mx-auto mb-16 max-w-3xl text-center md:mb-20"
        >
          <motion.span
            variants={fadeUp}
            className="text-xs uppercase tracking-[0.3em] text-brand-violet"
          >
            How it works
          </motion.span>
          <motion.h2
            variants={fadeUp}
            className="mt-5 font-display text-3xl leading-tight tracking-tight md:text-5xl"
          >
            Three quiet steps to <span className="text-gradient-brand">another you</span>.
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="mt-5 text-base text-ink-secondary md:text-lg"
          >
            No setup wizard. No daily logging. Install once and the model starts learning.
          </motion.p>
        </motion.div>

        <motion.ol
          variants={stagger(0.18)}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="relative grid gap-6 md:grid-cols-3"
        >
          {/* Connector line on desktop */}
          <div className="pointer-events-none absolute left-0 right-0 top-[68px] hidden h-px md:block">
            <div className="hairline mx-12" />
          </div>

          {steps.map((s, i) => (
            <motion.li
              key={s.title}
              variants={fadeUp}
              className="glass relative rounded-2xl p-7 md:p-8"
            >
              <div className="flex items-center justify-between">
                <span className="relative flex h-12 w-12 items-center justify-center rounded-xl bg-brand-gradient shadow-glow">
                  <s.icon className="h-5 w-5 text-white" />
                </span>
                <span className="font-display text-sm tracking-widest text-ink-muted">
                  {s.tag}
                </span>
              </div>
              <h3 className="mt-6 font-display text-2xl tracking-tight">{s.title}</h3>
              <p className="mt-3 text-[15px] leading-relaxed text-ink-secondary">
                {s.desc}
              </p>

              {/* Subtle index glow */}
              <div
                aria-hidden="true"
                className="pointer-events-none absolute -top-px left-6 right-6 h-px"
                style={{
                  background:
                    'linear-gradient(90deg, transparent, rgba(139,92,246,0.6), transparent)',
                  opacity: 0.5,
                }}
              />
              {i < steps.length - 1 && (
                <span
                  aria-hidden="true"
                  className="absolute -right-3 top-1/2 hidden h-6 w-6 -translate-y-1/2 rounded-full border border-white/10 bg-bg md:flex md:items-center md:justify-center"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-brand-violet" />
                </span>
              )}
            </motion.li>
          ))}
        </motion.ol>
      </div>
    </section>
  );
}
