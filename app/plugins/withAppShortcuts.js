/* global __dirname */
// Local config plugin: compiles plugins/app-shortcuts/TasklingsShortcuts.swift into the APP target
// only. Apple expects one AppShortcutsProvider per app, and the widget extension must not carry one,
// so it can't live in targets/widget/_shared (which @bacons/apple-targets links into both).
// AddTaskIntent stays in _shared, so the provider can reference it from the same module.
const fs = require('fs');
const { withXcodeProject, IOSConfig } = require('expo/config-plugins');

const FILE = 'TasklingsShortcuts.swift';
// The Expo template names the app folder after the project; fail loudly if that ever changes.
const APP_DIR = 'Tasklings';

module.exports = function withAppShortcuts(config) {
  return withXcodeProject(config, (cfg) => {
    const { projectName, platformProjectRoot } = cfg.modRequest;
    if (projectName !== APP_DIR) throw new Error(`withAppShortcuts: unexpected iOS project name ${projectName}`);
    const src = `${__dirname}/app-shortcuts/${FILE}`;
    const dest = `${platformProjectRoot}/${APP_DIR}/${FILE}`;
    fs.copyFileSync(src, dest);
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: `${APP_DIR}/${FILE}`,
      groupName: APP_DIR,
      project: cfg.modResults,
    });
    return cfg;
  });
};
