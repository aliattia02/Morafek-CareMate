const { withGradleProperties } = require('@expo/config-plugins');

module.exports = function withMinSdk(config) {
  return withGradleProperties(config, (config) => {
    config.modResults = config.modResults.filter(
      (item) => item.key !== 'android.minSdkVersion'
    );
    config.modResults.push({ type: 'property', key: 'android.minSdkVersion', value: '26' });
    return config;
  });
};