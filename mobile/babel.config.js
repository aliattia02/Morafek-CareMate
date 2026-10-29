module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    plugins: [
      // Transforms import.meta → compatible syntax for Metro web builds
      'babel-plugin-transform-import-meta',
    ],
  };
};