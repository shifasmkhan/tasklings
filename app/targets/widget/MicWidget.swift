import AppIntents
import SwiftUI
import WidgetKit

/// Home Screen widget: app name and a mic button, nothing else. It deliberately has no data source,
/// so it can never show a task (counts and the next task come with US-06 and a summary store).
struct MicEntry: TimelineEntry {
  let date: Date
}

struct MicProvider: TimelineProvider {
  func placeholder(in context: Context) -> MicEntry { MicEntry(date: Date()) }
  func getSnapshot(in context: Context, completion: @escaping (MicEntry) -> Void) {
    completion(MicEntry(date: Date()))
  }
  func getTimeline(in context: Context, completion: @escaping (Timeline<MicEntry>) -> Void) {
    // Static content: one entry, never reloaded.
    completion(Timeline(entries: [MicEntry(date: Date())], policy: .never))
  }
}

struct MicWidgetView: View {
  var body: some View {
    VStack(spacing: 10) {
      Button(intent: AddTaskIntent()) {
        Image(systemName: "mic.fill")
          .font(.system(size: 30, weight: .semibold))
          .foregroundStyle(.white)
          .frame(width: 64, height: 64)
          .background(Circle().fill(Color.accentColor))
      }
      .buttonStyle(.plain)
      .accessibilityLabel("Add a task")
      Text("Tasklings")
        .font(.footnote.weight(.semibold))
        .foregroundStyle(.secondary)
    }
    .containerBackground(.fill.tertiary, for: .widget)
  }
}

struct MicWidget: Widget {
  let kind = "TasklingsMicWidget"

  var body: some WidgetConfiguration {
    StaticConfiguration(kind: kind, provider: MicProvider()) { _ in
      MicWidgetView()
    }
    .configurationDisplayName("Add a task")
    .description("Tap the mic and say a task.")
    .supportedFamilies([.systemSmall])
  }
}
