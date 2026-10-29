/** @type {import('@bacons/apple-targets/app.plugin').ConfigFunction} */
module.exports = (_config) => ({
  type: 'widget',
  name: 'TasklingsWidgets',
  displayName: 'Tasklings',
  // iOS 17 for Button(intent:) and containerBackground; the Control Center control is gated to iOS 18 in code.
  deploymentTarget: '17.0',
  frameworks: ['AppIntents'],
  // No entitlements and no App Group on purpose: the widget shows no task data (US-06 adds that).
});
