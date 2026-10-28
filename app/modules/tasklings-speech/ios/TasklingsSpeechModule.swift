import ExpoModulesCore

/// Error codes shared with the JS wrapper (`SpeechErrorCode` in app/src/features/capture/speech).
enum SpeechErrorCode: String {
  case permissionDenied = "permission_denied"
  case unavailable = "unavailable"
  case failed = "failed"
}

/// Thrown to JavaScript with a stable `code`. The message never carries transcript text.
final class SpeechException: Exception, @unchecked Sendable {
  private let speechCode: SpeechErrorCode

  init(_ code: SpeechErrorCode) {
    self.speechCode = code
    super.init(name: "SpeechException", description: "Speech recognizer error: \(code.rawValue)", code: code.rawValue)
  }

  override var code: String { speechCode.rawValue }
}

/// US-01: on-device speech recognition. All the work is in `SpeechController`; this file only
/// exposes it to JavaScript. Nothing here logs, and nothing writes audio or text to disk.
public final class TasklingsSpeechModule: Module {
  private let controller = SpeechController()

  public func definition() -> ModuleDefinition {
    let controller = self.controller
    Name("TasklingsSpeech")

    Events("onPartial", "onLevel", "onError")

    OnCreate {
      controller.emit = { [weak self] name, body in
        self?.sendEvent(name, body)
      }
    }

    OnDestroy {
      controller.cancel()
    }

    // Asks for permission if needed, then starts listening. Rejects with a SpeechException.
    AsyncFunction("start") { () async throws -> Void in
      try await controller.start()
    }

    // Stops listening and resolves with the final transcript (possibly empty).
    AsyncFunction("stop") { () async -> String in
      await controller.stop()
    }

    // Stops listening and discards everything.
    Function("cancel") { () -> Void in
      controller.cancel()
    }
  }
}
