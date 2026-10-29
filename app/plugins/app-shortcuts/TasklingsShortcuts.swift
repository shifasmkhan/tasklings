import AppIntents

/// Makes "Add a task" appear in Shortcuts, Spotlight, Siri and the Action Button's Shortcut picker
/// without the user building anything.
@available(iOS 16.4, *)
struct TasklingsShortcuts: AppShortcutsProvider {
  static var appShortcuts: [AppShortcut] {
    AppShortcut(
      intent: AddTaskIntent(),
      phrases: [
        "Add a task in \(.applicationName)",
        "New \(.applicationName) note",
      ],
      shortTitle: "Add a task",
      systemImageName: "mic.fill"
    )
  }
}
