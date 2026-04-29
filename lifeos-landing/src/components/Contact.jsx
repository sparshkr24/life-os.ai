import { useState } from 'react';
import { motion } from 'framer-motion';
import { Mail, Github, Send } from 'lucide-react';
import Button from './ui/Button.jsx';
import { fadeUp, stagger, viewport } from '../lib/utils.js';

const CONTACT_EMAIL = 'ai@lifeos7.com';
const GITHUB_URL = 'https://github.com/';

export default function Contact() {
  const [form, setForm] = useState({ name: '', email: '', message: '' });

  const onChange = (key) => (e) => setForm((f) => ({ ...f, [key]: e.target.value }));

  const onSubmit = (e) => {
    e.preventDefault();
    const subject = encodeURIComponent(`LifeOS — message from ${form.name || 'a friend'}`);
    const body = encodeURIComponent(
      `${form.message}\n\n— ${form.name}${form.email ? ` (${form.email})` : ''}`,
    );
    window.location.href = `mailto:${CONTACT_EMAIL}?subject=${subject}&body=${body}`;
  };

  const fieldClass =
    'w-full rounded-xl border border-white/10 bg-white/[0.03] px-4 py-3 text-[15px] text-ink-primary placeholder:text-ink-muted transition-colors focus:border-brand-violet/60 focus:bg-white/[0.05] focus:outline-none';

  return (
    <section id="contact" className="section relative">
      <div className="container-narrow">
        <motion.div
          variants={stagger()}
          initial="hidden"
          whileInView="show"
          viewport={viewport}
          className="grid gap-12 md:grid-cols-2 md:gap-16"
        >
          <div>
            <motion.span
              variants={fadeUp}
              className="text-xs uppercase tracking-[0.3em] text-brand-violet"
            >
              Get in touch
            </motion.span>
            <motion.h2
              variants={fadeUp}
              className="mt-5 font-display text-3xl leading-tight tracking-tight md:text-5xl"
            >
              Let’s <span className="text-gradient-brand">talk</span>.
            </motion.h2>
            <motion.p
              variants={fadeUp}
              className="mt-6 max-w-md text-base text-ink-secondary md:text-lg"
            >
              Partnerships, product feedback, research collaborations, or pilot access
              — reach out and we’ll respond personally.
            </motion.p>

            <motion.div variants={fadeUp} className="mt-8 flex flex-col gap-3">
              <a
                href={`mailto:${CONTACT_EMAIL}`}
                className="group inline-flex items-center gap-3 text-ink-primary"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] transition-colors group-hover:border-brand-violet/40 group-hover:bg-white/[0.07]">
                  <Mail className="h-4 w-4 text-brand-violet" />
                </span>
                <span className="text-[15px]">{CONTACT_EMAIL}</span>
              </a>
              <a
                href={GITHUB_URL}
                target="_blank"
                rel="noreferrer"
                className="group inline-flex items-center gap-3 text-ink-primary"
              >
                <span className="flex h-10 w-10 items-center justify-center rounded-xl border border-white/10 bg-white/[0.04] transition-colors group-hover:border-brand-violet/40 group-hover:bg-white/[0.07]">
                  <Github className="h-4 w-4 text-brand-violet" />
                </span>
                <span className="text-[15px]">github.com/lifeos</span>
              </a>
            </motion.div>
          </div>

          <motion.form
            variants={fadeUp}
            onSubmit={onSubmit}
            className="glass space-y-4 rounded-2xl p-6 md:p-8"
          >
            <div>
              <label className="mb-2 block text-xs uppercase tracking-wider text-ink-muted">
                Name
              </label>
              <input
                required
                value={form.name}
                onChange={onChange('name')}
                placeholder="Your name"
                className={fieldClass}
              />
            </div>
            <div>
              <label className="mb-2 block text-xs uppercase tracking-wider text-ink-muted">
                Email
              </label>
              <input
                type="email"
                required
                value={form.email}
                onChange={onChange('email')}
                placeholder="you@somewhere.com"
                className={fieldClass}
              />
            </div>
            <div>
              <label className="mb-2 block text-xs uppercase tracking-wider text-ink-muted">
                Message
              </label>
              <textarea
                required
                rows={4}
                value={form.message}
                onChange={onChange('message')}
                placeholder="Say hi, share an idea, request a feature\u2026"
                className={`${fieldClass} resize-none`}
              />
            </div>
            <Button type="submit" size="md" className="w-full">
              <Send className="h-4 w-4" />
              Send message
            </Button>
            <p className="text-center text-xs text-ink-muted">
              Opens your mail app. We never store your message on a server.
            </p>
          </motion.form>
        </motion.div>
      </div>
    </section>
  );
}
