Pod::Spec.new do |s|
  s.name           = 'TasklingsIntents'
  s.version        = '0.1.0'
  s.summary        = 'Hands the "launched by our own App Intent" signal to JavaScript (US-01).'
  s.description    = 'One-shot, in-process flag set by AddTaskIntent. Not reachable from URLs or other apps.'
  s.license        = { :type => 'MIT' }
  s.author         = 'Tasklings'
  s.homepage       = 'https://github.com/shifasmkhan/tasklings'
  s.platforms      = { :ios => '16.4' }
  s.swift_version  = '5.9'
  s.source         = { :git => 'https://github.com/shifasmkhan/tasklings.git' }
  s.static_framework = true

  s.dependency 'ExpoModulesCore'

  s.source_files = '**/*.{h,m,swift}'
  s.pod_target_xcconfig = {
    'DEFINES_MODULE' => 'YES',
    'SWIFT_COMPILATION_MODE' => 'wholemodule'
  }
end
