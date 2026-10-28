import AVFoundation
import Speech
import UIKit

/// Records with AVAudioEngine and recognizes with SFSpeechRecognizer, on the device only.
///
/// Privacy rules (security acceptance criteria for US-01):
/// - `requiresOnDeviceRecognition` is always true. If the device or language can't do that, start
///   fails with `unavailable`. There is no fallback to server recognition.
/// - Audio buffers go from the microphone straight to the recognizer. Nothing is written to disk.
/// - Nothing in this file logs. Transcripts only travel to JavaScript through events and results.
final class SpeechController: @unchecked Sendable {
  /// Hard cap on one note, enforced here as well as in the app.
  static let maxRecordingSeconds: TimeInterval = 120
  /// How long to wait for the final result after the audio ends.
  static let finalResultTimeoutSeconds: TimeInterval = 3
  /// Minimum gap between level events.
  static let levelIntervalSeconds: TimeInterval = 0.1

  private enum State {
    case idle
    case starting
    case listening
    /// Audio has ended; waiting for the recognizer's final result.
    case finishing
    /// The final text is ready and waits for `stop()`.
    case done
  }

  /// Set by the module; sends an event to JavaScript.
  var emit: (String, [String: Any?]) -> Void = { _, _ in }

  private let lock = NSLock()
  private var state: State = .idle
  /// Bumped on every start and cancel, so late callbacks from an older session are ignored.
  private var generation = 0

  private var engine: AVAudioEngine?
  private var request: SFSpeechAudioBufferRecognitionRequest?
  private var task: SFSpeechRecognitionTask?
  private var recognizer: SFSpeechRecognizer?
  private var capTimer: DispatchSourceTimer?
  private var finalTimer: DispatchSourceTimer?
  private var observers: [NSObjectProtocol] = []

  private var latest = ""
  private var finishedText = ""
  private var waiters: [CheckedContinuation<String, Never>] = []

  // MARK: - Public

  func start() async throws {
    let myGeneration = beginStart()

    do {
      try await requestPermissions()
      try startListening(generation: myGeneration)
    } catch {
      lock.lock()
      if generation == myGeneration, state == .starting {
        teardownLocked()
        state = .idle
      }
      lock.unlock()
      if let speechError = error as? SpeechException { throw speechError }
      throw SpeechException(.failed)
    }
  }

  func stop() async -> String {
    await withCheckedContinuation { (continuation: CheckedContinuation<String, Never>) in
      lock.lock()
      defer { lock.unlock() }
      switch state {
      case .idle, .starting:
        continuation.resume(returning: "")
      case .listening:
        beginFinishingLocked()
        waiters.append(continuation)
      case .finishing:
        waiters.append(continuation)
      case .done:
        let text = finishedText
        resetLocked()
        continuation.resume(returning: text)
      }
    }
  }

  func cancel() {
    lock.lock()
    generation += 1
    teardownLocked()
    resetLocked()
    let pending = waiters
    waiters = []
    lock.unlock()
    pending.forEach { $0.resume(returning: "") }
  }

  // MARK: - Start

  private func beginStart() -> Int {
    lock.lock()
    generation += 1
    let mine = generation
    teardownLocked()
    resetLocked()
    state = .starting
    let pending = waiters
    waiters = []
    lock.unlock()
    pending.forEach { $0.resume(returning: "") }
    return mine
  }

  private func requestPermissions() async throws {
    let speechStatus: SFSpeechRecognizerAuthorizationStatus = await withCheckedContinuation { continuation in
      SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
    }
    guard speechStatus == .authorized else { throw SpeechException(.permissionDenied) }

    let micGranted: Bool
    if #available(iOS 17.0, *) {
      micGranted = await AVAudioApplication.requestRecordPermission()
    } else {
      micGranted = await withCheckedContinuation { continuation in
        AVAudioSession.sharedInstance().requestRecordPermission { continuation.resume(returning: $0) }
      }
    }
    guard micGranted else { throw SpeechException(.permissionDenied) }
  }

  private func startListening(generation myGeneration: Int) throws {
    // Device language. No fallback to another locale and no server recognition.
    guard let recognizer = SFSpeechRecognizer(locale: Locale.current),
      recognizer.isAvailable,
      recognizer.supportsOnDeviceRecognition
    else {
      throw SpeechException(.unavailable)
    }

    let request = SFSpeechAudioBufferRecognitionRequest()
    request.shouldReportPartialResults = true
    request.requiresOnDeviceRecognition = true
    request.taskHint = .dictation
    request.addsPunctuation = true

    let audioSession = AVAudioSession.sharedInstance()
    let engine = AVAudioEngine()
    do {
      try audioSession.setCategory(.record, mode: .default, options: [])
      try audioSession.setActive(true, options: [])
    } catch {
      throw SpeechException(.failed)
    }

    let inputNode = engine.inputNode
    let format = inputNode.outputFormat(forBus: 0)
    guard format.sampleRate > 0, format.channelCount > 0 else {
      try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      throw SpeechException(.failed)
    }

    // The tap runs on an audio thread: it only hands buffers to the recognizer and reports a level.
    let levelMeter = LevelMeter(interval: Self.levelIntervalSeconds) { [weak self] level in
      self?.emitLevel(level)
    }
    inputNode.installTap(onBus: 0, bufferSize: 1024, format: format) { buffer, _ in
      request.append(buffer)
      levelMeter.process(buffer)
    }

    lock.lock()
    guard generation == myGeneration, state == .starting else {
      // Cancelled while permissions or setup were running.
      lock.unlock()
      inputNode.removeTap(onBus: 0)
      try? audioSession.setActive(false, options: .notifyOthersOnDeactivation)
      return
    }
    self.recognizer = recognizer
    self.request = request
    self.engine = engine
    self.latest = ""
    self.task = recognizer.recognitionTask(with: request) { [weak self] result, error in
      self?.handle(generation: myGeneration, text: result?.bestTranscription.formattedString, isFinal: result?.isFinal ?? false, failed: error != nil)
    }
    lock.unlock()

    do {
      engine.prepare()
      try engine.start()
    } catch {
      lock.lock()
      if generation == myGeneration {
        teardownLocked()
        state = .idle
      }
      lock.unlock()
      throw SpeechException(.failed)
    }

    lock.lock()
    guard generation == myGeneration, state == .starting else {
      lock.unlock()
      return
    }
    state = .listening
    installObserversLocked(generation: myGeneration)
    scheduleCapLocked(generation: myGeneration)
    lock.unlock()
  }

  // MARK: - Recognition results

  private func handle(generation myGeneration: Int, text: String?, isFinal: Bool, failed: Bool) {
    var partialToEmit: String?
    var errorToEmit = false
    var pending: [CheckedContinuation<String, Never>] = []
    var resumeText = ""

    lock.lock()
    guard generation == myGeneration else {
      lock.unlock()
      return
    }
    if let text = text {
      latest = text
    }
    switch state {
    case .listening:
      if failed && !isFinal {
        // The recognizer died while the user was still talking: stop everything and tell the app.
        teardownLocked()
        resetLocked()
        errorToEmit = true
      } else if let text = text, !isFinal {
        partialToEmit = text
      }
    case .finishing:
      if isFinal || failed {
        (pending, resumeText) = completeLocked()
      }
    default:
      break
    }
    lock.unlock()

    if let partial = partialToEmit { emit("onPartial", ["text": partial]) }
    if errorToEmit { emit("onError", ["code": SpeechErrorCode.failed.rawValue]) }
    pending.forEach { $0.resume(returning: resumeText) }
  }

  /// Called from the audio thread, so it must not take the lock (stopping the engine waits for the
  /// tap while holding it). A level that arrives just after a stop is ignored by the JS wrapper.
  private func emitLevel(_ level: Double) {
    DispatchQueue.global(qos: .userInteractive).async { [weak self] in
      self?.emit("onLevel", ["level": level])
    }
  }

  // MARK: - Finishing and failing

  /// Stops the audio and asks the recognizer for its final result. Caller holds the lock.
  private func beginFinishingLocked() {
    guard state == .listening else { return }
    state = .finishing
    capTimer?.cancel()
    capTimer = nil
    removeObserversLocked()
    stopAudioLocked()
    request?.endAudio()
    let myGeneration = generation
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
    timer.schedule(deadline: .now() + Self.finalResultTimeoutSeconds)
    timer.setEventHandler { [weak self] in self?.finalTimedOut(generation: myGeneration) }
    finalTimer = timer
    timer.resume()
  }

  private func finalTimedOut(generation myGeneration: Int) {
    var pending: [CheckedContinuation<String, Never>] = []
    var text = ""
    lock.lock()
    if generation == myGeneration, state == .finishing {
      (pending, text) = completeLocked()
    }
    lock.unlock()
    pending.forEach { $0.resume(returning: text) }
  }

  /// Finishes a note: keeps the text for `stop()` unless someone is already waiting for it.
  /// Caller holds the lock and resumes the returned waiters after unlocking.
  private func completeLocked() -> ([CheckedContinuation<String, Never>], String) {
    let text = latest
    let pending = waiters
    waiters = []
    teardownLocked()
    if pending.isEmpty {
      finishedText = text
      state = .done
    } else {
      resetLocked()
    }
    return (pending, text)
  }

  /// Stops listening because something outside our control ended it (call, route change, backgrounding).
  private func fail(generation myGeneration: Int) {
    var shouldEmit = false
    lock.lock()
    if generation == myGeneration, state == .listening {
      generation += 1
      teardownLocked()
      resetLocked()
      shouldEmit = true
    }
    lock.unlock()
    if shouldEmit { emit("onError", ["code": SpeechErrorCode.failed.rawValue]) }
  }

  private func capReached(generation myGeneration: Int) {
    lock.lock()
    if generation == myGeneration, state == .listening {
      // Stop recording and keep what was heard; the app's stop() picks up the final text.
      beginFinishingLocked()
    }
    lock.unlock()
  }

  // MARK: - Lifecycle helpers (caller holds the lock)

  private func scheduleCapLocked(generation myGeneration: Int) {
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
    timer.schedule(deadline: .now() + Self.maxRecordingSeconds)
    timer.setEventHandler { [weak self] in self?.capReached(generation: myGeneration) }
    capTimer = timer
    timer.resume()
  }

  private func installObserversLocked(generation myGeneration: Int) {
    let center = NotificationCenter.default
    let names: [Notification.Name] = [
      AVAudioSession.interruptionNotification,
      AVAudioSession.mediaServicesWereResetNotification,
      .AVAudioEngineConfigurationChange,
      UIApplication.didEnterBackgroundNotification,
    ]
    observers = names.map { name in
      center.addObserver(forName: name, object: nil, queue: nil) { [weak self] notification in
        if name == AVAudioSession.interruptionNotification {
          // Only the start of an interruption matters; we never resume by ourselves.
          let raw = notification.userInfo?[AVAudioSessionInterruptionTypeKey] as? UInt
          guard raw == AVAudioSession.InterruptionType.began.rawValue else { return }
        }
        self?.fail(generation: myGeneration)
      }
    }
  }

  private func removeObserversLocked() {
    observers.forEach { NotificationCenter.default.removeObserver($0) }
    observers = []
  }

  private func stopAudioLocked() {
    if let engine = engine {
      engine.inputNode.removeTap(onBus: 0)
      engine.stop()
    }
    engine = nil
    try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation)
  }

  /// Releases the microphone and the recognizer. Safe to call more than once.
  private func teardownLocked() {
    capTimer?.cancel()
    capTimer = nil
    finalTimer?.cancel()
    finalTimer = nil
    removeObserversLocked()
    stopAudioLocked()
    request?.endAudio()
    task?.cancel()
    task = nil
    request = nil
    recognizer = nil
  }

  private func resetLocked() {
    state = .idle
    latest = ""
    finishedText = ""
  }
}

/// Turns audio buffers into a 0 to 1 level, at most every `interval` seconds. Audio thread only.
private final class LevelMeter: @unchecked Sendable {
  private let interval: TimeInterval
  private let onLevel: (Double) -> Void
  private var lastEmit: TimeInterval = 0

  init(interval: TimeInterval, onLevel: @escaping (Double) -> Void) {
    self.interval = interval
    self.onLevel = onLevel
  }

  func process(_ buffer: AVAudioPCMBuffer) {
    let now = ProcessInfo.processInfo.systemUptime
    guard now - lastEmit >= interval else { return }
    guard let channel = buffer.floatChannelData?[0] else { return }
    let count = Int(buffer.frameLength)
    guard count > 0 else { return }
    var sum: Float = 0
    for index in 0..<count {
      let sample = channel[index]
      sum += sample * sample
    }
    let rms = (sum / Float(count)).squareRoot()
    // About -50 dB (silence) to 0 dB (loud) mapped to 0...1.
    let decibels = 20 * log10(max(rms, 1e-7))
    let level = min(1, max(0, Double((decibels + 50) / 50)))
    lastEmit = now
    onLevel(level)
  }
}
