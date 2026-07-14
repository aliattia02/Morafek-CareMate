const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

config.resolver.assetExts.push('wasm');

// Force zustand to resolve to its CommonJS build instead of the ESM one,
// which uses import.meta and breaks Metro's web bundler (Hermes).
config.resolver.resolveRequest = (context, moduleName, platform) => {
  if (moduleName === 'zustand' || moduleName.startsWith('zustand/')) {
    const resolved = require.resolve(moduleName, { paths: [__dirname] });
    return context.resolveRequest(context, resolved, platform);
  }
  return context.resolveRequest(context, moduleName, platform);
};

module.exports = config;