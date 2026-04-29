# LifeOS — Landing Page

Single-page Vite + React landing for **LifeOS**, the on-device personal AI for Android.

## Stack

- React 18 + Vite (JS, no TS)
- Tailwind CSS + custom SCSS for animation control
- Framer Motion for entry animations
- lucide-react for icons
- Static site — zero backend. Deploys to Vercel as-is.

## Run locally

```bash
cd lifeos-landing
npm install
npm run dev
```

## Drop in your APK

Place your signed APK at `public/lifeos.apk`. Both download buttons point at `/lifeos.apk`.

```bash
cp ../client/android/app/build/outputs/apk/release/app-release.apk public/lifeos.apk
```

## Build

```bash
npm run build
npm run preview
```

## Deploy to Vercel

Push to a Git repo, import in Vercel. Defaults work — framework is auto-detected as Vite.

## Structure

```
lifeos-landing/
├─ index.html
├─ vite.config.js
├─ tailwind.config.js
├─ postcss.config.js
├─ public/
│  ├─ favicon.svg
│  └─ lifeos.apk        ← drop your APK here
└─ src/
   ├─ main.jsx
   ├─ App.jsx
   ├─ index.css
   ├─ styles/animations.scss
   ├─ lib/utils.js
   └─ components/
      ├─ Navbar.jsx
      ├─ Hero.jsx           (interactive particle field)
      ├─ AmbientBackground.jsx
      ├─ Problem.jsx
      ├─ HowItWorks.jsx
      ├─ Features.jsx
      ├─ Privacy.jsx
      ├─ Download.jsx
      ├─ Contact.jsx
      ├─ Footer.jsx
      └─ ui/
         ├─ Button.jsx
         └─ Card.jsx
```
