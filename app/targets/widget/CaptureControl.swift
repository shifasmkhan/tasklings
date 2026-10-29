import AppIntents
import SwiftUI
import WidgetKit

/// Control Center / lock screen / Action Button control (iOS 18+). Runs the same intent as the
/// widget, so the app opens ready to record. It never shows task data.
@available(iOS 18.0, *)
struct CaptureControl: ControlWidget {
  static let kind = "com.shifasmkhan.tasklings.capture-control"

  var body: some ControlWidgetConfiguration {
    StaticControlConfiguration(kind: Self.kind) {
      ControlWidgetButton(action: AddTaskIntent()) {
        Label("Add a task", systemImage: "mic.fill")
      }
    }
    .displayName("Add a task")
    .description("Opens Tasklings ready to record a task.")
  }
}
