import SwiftUI
import WidgetKit

@main
struct TasklingsWidgetsBundle: WidgetBundle {
  var body: some Widget {
    MicWidget()
    if #available(iOS 18.0, *) {
      CaptureControl()
    }
  }
}
