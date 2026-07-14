# Fix: "Cannot use 'import.meta' outside a module" (Expo Web)

## Problem

Running the mobile app in **web mode** (`npx expo start --web`) crashed the browser bundle with:

```
Uncaught SyntaxError: Cannot use 'import.meta' outside a module
```

### Root Cause

`zustand`'s middleware module (`node_modules/zustand/esm/middleware.mjs`) contains
devtools-related code that uses `import.meta.env`:

```js
extensionConnector = (import.meta.env ? import.meta.env.MODE : void 0) !== "production"
```

This project imports `persist` and `createJSONStorage` from `zustand/middleware`
(used in `store/health-connect.store.ts`). Because it's the same file, Metro's
web bundler pulls in the whole module — including the `import.meta` line.

**Metro's web bundler (via Hermes) does not support `import.meta` syntax** in
Expo SDK 54. Support is only becoming default in SDK 56.

## Solution

Force Metro to resolve packages using `require`/`react-native` conditions
instead of modern ESM exports, in **`mobile/metro.config.js`**:

```js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('wasm');

// Force Metro to prefer CommonJS/react-native exports over modern ESM,
// which fixes "Cannot use import.meta outside a module" from zustand's
// middleware.mjs when running on web.
config.resolver.unstable_conditionNames = ['browser', 'require', 'react-native'];

module.exports = config;
```

### Required cleanup after editing config

Metro caches aggressively — editing the config alone is not enough:

```powershell
cd mobile
Get-Process node -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-Item -Recurse -Force .expo -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force node_modules\.cache -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $env:TEMP\metro-* -ErrorAction SilentlyContinue
Remove-Item -Recurse -Force $env:TEMP\haste-map-* -ErrorAction SilentlyContinue

npx expo start --web --clear
```

Then **hard refresh** the browser tab (`Ctrl+Shift+R`) — a normal reload can
still serve the old broken bundle from the browser's HTTP cache.

## How it was diagnosed

```powershell
Get-ChildItem -Path node_modules\zustand -Recurse -Include *.js,*.mjs |
  Select-String -Pattern "import\.meta" -List
```

This pinpointed the exact file/line, avoiding guesswork across dependencies
(`uuid`, `victory-native`, etc. were ruled out the same way).
