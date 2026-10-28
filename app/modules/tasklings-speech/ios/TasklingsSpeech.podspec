Pod::Spec.new do |s|
  s.name           = 'TasklingsSpeech'
  s.version        = '0.1.0'
  s.summary        = 'On-device speech recognition for Tasklings capture (US-01).'
  s.description    = 'Wraps SFSpeechRecognizer with on-device recognition required. Audio never leaves the phone.'
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
