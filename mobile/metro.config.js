/**
 * Metro configuration for React Native
 * https://github.com/facebook/react-native
 *
 * Since the `shared/` folder is now inside `mobile/`,
 * we no longer need custom watchFolders or nodeModulesPaths.
 */

const { getDefaultConfig } = require('expo/metro-config');

// Get default Expo Metro config for this project
const config = getDefaultConfig(__dirname);

module.exports = config;
