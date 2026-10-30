const { withSettingsGradle } = require('@expo/config-plugins');

const PANGLE_REPOSITORY = 'https://artifact.bytedance.com/repository/pangle/';

module.exports = function withPangleMaven(config) {
  return withSettingsGradle(config, config => {
    let contents = config.modResults.contents;
    if (contents.includes(PANGLE_REPOSITORY)) return config;

    const repositoriesBlock = /(dependencyResolutionManagement\s*\{[\s\S]*?repositories\s*\{)/;
    if (repositoriesBlock.test(contents)) {
      contents = contents.replace(repositoriesBlock, `$1\n        maven { url = uri("${PANGLE_REPOSITORY}") }`);
    }

    config.modResults.contents = contents;
    return config;
  });
};
