/* global __dirname */
// Local config plugin: compiles plugins/app-shortcuts/TasklingsShortcuts.swift into the APP target
// only. Apple expects one AppShortcutsProvider per app, and the widget extension must not carry one,
// so it can't live in targets/widget/_shared (which @bacons/apple-targets links into both).
// AddTaskIntent stays in _shared, so the provider can reference it from the same module.
const fs = require('fs');
const path = require('path');
const { withXcodeProject, IOSConfig } = require('expo/config-plugins');

const FILE = 'TasklingsShortcuts.swift';

module.exports = function withAppShortcuts(config) {
  return withXcodeProject(config, (cfg) => {
    const { projectName, platformProjectRoot } = cfg.modRequest;
    const src = path.join(__dirname, 'app-shortcuts', FILE);
    const dest = path.join(platformProjectRoot, projectName, FILE);
    fs.copyFileSync(src, dest);
    IOSConfig.XcodeUtils.addBuildSourceFileToGroup({
      filepath: path.posix.join(projectName, FILE),
      groupName: projectName,
      project: cfg.modResults,
    });
    return cfg;
  });
};
