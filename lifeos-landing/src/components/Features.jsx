import { motion } from 'framer-motion';
import {
  Fingerprint,
  GitBranch,
  CalendarClock,
  Bell,
  ShieldCheck,
  RefreshCw,
} from 'lucide-react';
import Card from './ui/Card.jsx';
import { fadeUp, stagger, viewport } from '../lib/utils.js';

const features = [
  {
    icon: Fingerprint,
    title: 'Behavioral Identity Engine',
    desc: 'Builds a profile so deep it mirrors your decision-making — not your steps, your reasoning.',
  },
  {
    icon: GitBranch,
    title: 'Cause-Effect Habit Chains',
    desc: 'Pinpoints exactly what behavior drains tomorrow. "Instagram after 11PM → 34% lower productivity."',
  },
  {
    icon: CalendarClock,
    title: 'Context-Aware Scheduling',
    desc: 'Surfaces tasks when your pattern says you\u2019ll actually do them — not when the clock strikes.',
  },
  {
    icon: Bell,
    title: 'Smart Nudges',
    desc: 'Three escalating levels, fired at the right moment, never on a timer. Helpful, never annoying.',
  },
  {
    icon: ShieldCheck,
    title: 'Full Privacy',
    desc: 'On-device only. No cloud. No account. No data sharing. Ever.',
  },
  {
    icon: RefreshCw,
    title: 'Self-Reinforcing Loop',
    desc: 'Every day the model gets sharper. Confidence grows with data. Predictions get scary accurate.',
  },
];

export default function Features() {
  return (
    <section id="features" className="section relative">
      <div className="container-narrow">
        <motion.div
          variants={stagger()}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="mx-auto mb-14 max-w-3xl text-center md:mb-20"
        >
          <motion.span
            variants={fadeUp}
            className="text-xs uppercase tracking-[0.3em] text-brand-violet"
          >
            Core capabilities
          </motion.span>
          <motion.h2
            variants={fadeUp}
            className="mt-5 font-display text-3xl leading-tight tracking-tight md:text-5xl"
          >
            Built to <span className="text-gradient-brand">understand</span>, not just track.
          </motion.h2>
          <motion.p
            variants={fadeUp}
            className="mt-5 text-base text-ink-secondary md:text-lg"
          >
            Every feature exists for one reason: to make the model accurately you.
          </motion.p>
        </motion.div>

        <motion.div
          variants={stagger(0.1)}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="grid grid-cols-1 gap-5 sm:grid-cols-2 lg:grid-cols-3"
        >
          {features.map((f) => (
            <motion.div key={f.title} variants={fadeUp}>
              <Card className="h-full">
                <div className="flex h-11 w-11 items-center justify-center rounded-xl bg-white/[0.06] border border-white/10">
                  <f.icon className="h-5 w-5 text-brand-violet" />
                </div>
                <h3 className="mt-6 font-display text-xl tracking-tight">{f.title}</h3>
                <p className="mt-3 text-[15px] leading-relaxed text-ink-secondary">
                  {f.desc}
                </p>
              </Card>
            </motion.div>
          ))}
        </motion.div>
      </div>
    </section>
  );
}
