# AI Life OS

Personal Android assistant. Sideload APK only. **Local-first** — no backend, no cloud DB. See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for design and [CLAUDE.md](CLAUDE.md) for working rules.

## Layout

```
client/   Expo (React Native + TypeScript) app + native Kotlin module
docs/     Architecture & design docs
```

## Prerequisites (one-time)

- Node 20+
- Android Studio (Android SDK + bundled JDK). Open once, let the standard setup finish.
- A real Android phone with USB debugging on (Settings → About phone → tap "Build number" 7×; then Settings → Developer options → USB debugging).

Add to `~/.zshrc`:

```bash
export ANDROID_HOME=$HOME/Library/Android/sdk
export JAVA_HOME="/Applications/Android Studio.app/Contents/jbr/Contents/Home"
export PATH=$JAVA_HOME/bin:$PATH:$ANDROID_HOME/platform-tools
```

`source ~/.zshrc`, then verify with `adb --version` and `java -version`.

## Daily start

Plug phone in, then **one terminal**:

```bash
cd client && npx expo start --dev-client
```

Launch "Life OS" on the phone. JS hot-reloads on save.

## When you change code

| Change | What to run |
|---|---|
| JS / TSX only | nothing — Metro hot-reloads |
| Kotlin (`*.kt`) / `AndroidManifest.xml` / `app.json` permissions | `cd client/android && ./gradlew assembleDebug && adb install -r app/build/outputs/apk/debug/app-debug.apk` |
| After USB unplug/replug | `adb reverse tcp:8081 tcp:8081` |
| Schema change in `client/src/db/schema.ts` | bump `SCHEMA_VERSION`; uninstall+reinstall app to wipe DB |

## Native logs

```bash
adb logcat -s 'LifeOsService:*' 'LifeOsBridge:*' 'LifeOsBoot:*' 'AndroidRuntime:E'
```

## Live db

```bashbash
# 1. Pull the live DB to your Mac
adb exec-out run-as com.lifeos cat files/SQLite/lifeos.db > lifeos.db

# 2. Optional: also pull WAL + SHM (for in-flight writes; safe to skip)
adb exec-out run-as com.lifeos cat files/SQLite/lifeos.db-wal > lifeos.db-wal 2>/dev/null
adb exec-out run-as com.lifeos cat files/SQLite/lifeos.db-shm > lifeos.db-shm 2>/dev/null

# 3. Install a viewer (one-time)
brew install --cask db-browser-for-sqlite

# 4. Open it
open -a "DB Browser for SQLite" lifeos.db
```

## Stage status

See the table in [CLAUDE.md](CLAUDE.md#stage-tracker).
