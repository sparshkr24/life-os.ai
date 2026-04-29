import { motion } from 'framer-motion';
import { fadeUp, stagger, viewport } from '../lib/utils.js';

export default function Problem() {
  return (
    <section className="section relative">
      <div className="container-narrow">
        <motion.div
          variants={stagger(0.18)}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="mx-auto max-w-4xl text-center"
        >
          <motion.span
            variants={fadeUp}
            className="text-xs uppercase tracking-[0.3em] text-brand-violet"
          >
            The problem
          </motion.span>

          <motion.h2
            variants={fadeUp}
            className="mt-6 font-display text-3xl leading-[1.15] tracking-tight md:text-5xl"
          >
            We know what we should do.
            <br />
            <span className="text-ink-secondary">We just don't do it.</span>
          </motion.h2>

          <motion.p
            variants={fadeUp}
            className="mx-auto mt-8 max-w-2xl text-lg leading-relaxed text-ink-secondary md:text-xl"
          >
            Phones distract. Habits slip. Calendars lie. Trackers count steps but never
            ask <em className="not-italic text-ink-primary">why</em> the run got skipped.
            No tool actually understands you — until now.
          </motion.p>
        </motion.div>
      </div>
    </section>
  );
}
