# AI Life OS

Personal Android assistant. Sideload APK only. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md).

## Layout

```
client/   Expo (React Native + TypeScript) app
server/   Node + Express + TypeScript backend
docs/     Architecture & design docs
```

## Prerequisites

- Node 20+ (you have it)
- For the phone: install **Expo Go** from the Play Store
- For the actual MVP later (not tonight): JDK 17 + Android SDK (easiest install path = Android Studio, but you'll keep editing in VS Code)

## Run it (today's goal: blank screen on phone)

Open two terminals.

**Terminal 1 — server:**

```bash
cd server
npm run dev
# → listening on http://0.0.0.0:3001
```

Sanity check from the laptop:

```bash
curl http://localhost:3001/health
```

**Terminal 2 — client:**

First, find your laptop's LAN IP and tell the client to use it (so the phone can reach the server):

```bash
export EXPO_PUBLIC_SERVER_URL="http://$(ipconfig getifaddr en0):3001"
cd client
npx expo start
```

Then on your phone (same WiFi as laptop):

1. Open Expo Go
2. Scan the QR code shown in the terminal
3. App loads — you should see "AI Life OS" with a green "OK" badge from `/health`

If the badge is red ("UNREACHABLE"), your phone can't reach the laptop. Common causes:
- Phone and laptop on different WiFi networks
- macOS firewall blocking node — System Settings → Network → Firewall → allow incoming for `node`
- You're on `en1` not `en0` — try `ipconfig getifaddr en1`

## Why no Android Studio yet?

Tonight uses **Expo Go** — a pre-built host app that loads your JS bundle. No native compile. No Android SDK. Just WiFi + QR code.

You'll need Android Studio's SDK only when we run `npx expo prebuild` to generate a custom APK with the Kotlin native module (Sunday onward, per the architecture doc). Even then, VS Code stays your editor — Android Studio is just the SDK installer.
