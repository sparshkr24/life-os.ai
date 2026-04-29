import Navbar from './components/Navbar.jsx';
import Hero from './components/Hero.jsx';
import Problem from './components/Problem.jsx';
import HowItWorks from './components/HowItWorks.jsx';
import Features from './components/Features.jsx';
import Privacy from './components/Privacy.jsx';
import Download from './components/Download.jsx';
import Contact from './components/Contact.jsx';
import Footer from './components/Footer.jsx';

export default function App() {
  return (
    <div className="relative">
      {/* Ambient flanking orbs — fixed, GPU-only */}
      <div className="side-orb left" aria-hidden="true" />
      <div className="side-orb right" aria-hidden="true" />

      <div className="relative z-10">
        <Navbar />
        <main>
          <Hero />
          <Problem />
          <HowItWorks />
          <Features />
          <Privacy />
          <Download />
          <Contact />
        </main>
        <Footer />
      </div>
    </div>
  );
}
