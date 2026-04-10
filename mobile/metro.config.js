// metro.config.js
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);

// 👇 add WASM support for expo-sqlite web
config.resolver.assetExts.push('wasm');

module.exports = config;