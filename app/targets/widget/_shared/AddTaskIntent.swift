import AppIntents
import Foundation

/// Linked into BOTH the app and the widget extension (`_shared`): an intent with `openAppWhenRun`
/// has to exist in the app so the system runs `perform()` in the app process.
///
/// Security: this is the only thing that arms auto-start recording. It can only be run by the
/// system on the user's behalf (Siri, Shortcuts, Action Button, Control Center, our own widget).
/// Other apps and web pages cannot run it, and it takes no parameters.
/// The signal stays inside the app: a timestamp in the app's private (non-App-Group) UserDefaults
/// plus an in-process notification. The JS side consumes it once (TasklingsIntents module).
enum PendingLaunch {
  // Keep these two strings in sync with modules/tasklings-intents/ios/TasklingsIntentsModule.swift.
  static let key = "tasklings.pendingIntentLaunchAt"
  static let notification = Notification.Name("com.shifasmkhan.tasklings.intentLaunch")

  static func mark() {
    UserDefaults.standard.set(Date().timeIntervalSince1970, forKey: key)
    NotificationCenter.default.post(name: notification, object: nil)
  }
}

@available(iOS 16.0, *)
struct AddTaskIntent: AppIntent {
  static let title: LocalizedStringResource = "Add a task"
  static let description = IntentDescription("Opens Tasklings ready to record a task.")
  // Foreground only: no background recording. On a locked iPhone iOS asks for unlock first.
  static let openAppWhenRun: Bool = true

  // iOS 26+: also declare foreground mode, so the system runs perform() in the app process even
  // when the intent is started from the widget or control extension (the flag below lives in the
  // app's private UserDefaults, which the extension process cannot reach). Before iOS 26, only
  // openAppWhenRun applies. If a run did land in the extension, auto-start would simply not fire
  // and the sheet would open idle: safe, never an unintended recording.
  @available(iOS 26.0, *)
  static var supportedModes: IntentModes { .foreground }

  func perform() async throws -> some IntentResult {
    PendingLaunch.mark()
    return .result()
  }
}
