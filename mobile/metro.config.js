// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// WASM support for expo-sqlite web
config.resolver.assetExts.push('wasm');

config.transformer = {
  ...config.transformer,
  unstable_transformProfile: 'default',
  // Force babel to transform packages that contain import.meta
  transformIgnorePatterns: [
    'node_modules/(?!' +
      '(jest-)?react-native' +
      '|@react-native(-community)?' +
      '|expo(nent)?' +
      '|@expo(nent)?(/.*)?' +
      '|@expo-google-fonts/.*' +
      '|react-navigation' +
      '|@react-navigation/.*' +
      '|@unimodules/.*' +
      '|unimodules' +
      '|sentry-expo' +
      '|native-base' +
      '|react-native-svg' +
      '|react-native-get-random-values' +
      '|zustand' +        // <-- contains import.meta.env in devtools middleware
    ')',
  ],
};

module.exports = config;