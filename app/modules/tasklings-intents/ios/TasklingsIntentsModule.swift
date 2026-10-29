import ExpoModulesCore
import Foundation

/// US-01: tells JavaScript that the app was opened by our own "Add a task" App Intent, so it may
/// start recording at once. The intent (targets/widget/_shared/AddTaskIntent.swift) writes a
/// timestamp to the app's private UserDefaults and posts a notification; this module only reads and
/// clears them. Nothing here is reachable from a URL, another app or a web page, and nothing is logged.
public final class TasklingsIntentsModule: Module {
  // Keep in sync with PendingLaunch in AddTaskIntent.swift (that file lives in the app and widget
  // targets, which a pod can't import).
  private static let key = "tasklings.pendingIntentLaunchAt"
  private static let notification = Notification.Name("com.shifasmkhan.tasklings.intentLaunch")
  /// A signal older than this is stale (the app never consumed it) and must not start the mic.
  private static let maxAgeSeconds: TimeInterval = 15

  private var observer: NSObjectProtocol?

  public func definition() -> ModuleDefinition {
    Name("TasklingsIntents")

    Events("onIntentLaunch")

    OnCreate {
      self.observer = NotificationCenter.default.addObserver(
        forName: TasklingsIntentsModule.notification, object: nil, queue: .main
      ) { [weak self] _ in
        self?.sendEvent("onIntentLaunch", [:])
      }
    }

    OnDestroy {
      if let observer = self.observer { NotificationCenter.default.removeObserver(observer) }
      self.observer = nil
    }

    // True at most once per intent run: reads the flag and clears it in the same call.
    Function("consumePendingLaunch") { () -> Bool in
      let defaults = UserDefaults.standard
      let at = defaults.double(forKey: TasklingsIntentsModule.key)
      defaults.removeObject(forKey: TasklingsIntentsModule.key)
      guard at > 0 else { return false }
      let age = Date().timeIntervalSince1970 - at
      return age >= 0 && age <= TasklingsIntentsModule.maxAgeSeconds
    }
  }
}
