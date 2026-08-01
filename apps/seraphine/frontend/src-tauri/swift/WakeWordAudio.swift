// Wake-word microphone capture for iOS, exposed to Rust via @_cdecl C ABI.
//
// This exists because on iOS the WKWebView is suspended when the screen
// goes off, so anything listening in JavaScript stops. AVAudioEngine keeps
// running as long as the audio session stays active and the app declares
// the `audio` background mode (see src-tauri/Info.ios.plist).
//
// Contract with Rust (src/wakeword/mod.rs):
//   seraphine_wakeword_audio_start() -> 0 ok, negative = error code
//   seraphine_wakeword_audio_stop()
//   ...and we call back into Rust with 16 kHz mono Int16 frames via
//   seraphine_wakeword_push_pcm.
//
// macOS builds compile this file too (build.rs globs swift/*.swift), but
// AVAudioSession is iOS-only and the Mac has its own capture path in
// mic.rs, so the whole body is gated.

#if os(iOS)

import AVFoundation
import Foundation

// Implemented in Rust. Static linking, so a plain symbol reference is enough.
@_silgen_name("seraphine_wakeword_push_pcm")
func seraphine_wakeword_push_pcm(_ ptr: UnsafePointer<Int16>?, _ count: Int32)

private let WW_OK: Int32 = 0
private let WW_ERR_PERMISSION: Int32 = -1
private let WW_ERR_SESSION: Int32 = -2
private let WW_ERR_ENGINE: Int32 = -3
private let WW_ERR_FORMAT: Int32 = -4

private let TARGET_SAMPLE_RATE: Double = 16_000

/// Owns the engine so start/stop are idempotent and the tap is installed
/// exactly once. All mutation happens on the main queue.
private final class WakeWordAudio {
    static let shared = WakeWordAudio()

    private let engine = AVAudioEngine()
    private var converter: AVAudioConverter?
    private var running = false

    private init() {
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleInterruption(_:)),
            name: AVAudioSession.interruptionNotification, object: nil)
        NotificationCenter.default.addObserver(
            self, selector: #selector(handleMediaServicesReset(_:)),
            name: AVAudioSession.mediaServicesWereResetNotification, object: nil)
    }

    func start() -> Int32 {
        if running { return WW_OK }

        let session = AVAudioSession.sharedInstance()

        // Bail out rather than silently capturing zeros. The permission
        // prompt itself is driven by the onboarding screen; by the time the
        // wake word is armed the answer is already known.
        var granted = false
        let sem = DispatchSemaphore(value: 0)
        session.requestRecordPermission { ok in
            granted = ok
            sem.signal()
        }
        _ = sem.wait(timeout: .now() + 10)
        if !granted { return WW_ERR_PERMISSION }

        do {
            // .playAndRecord + .voiceChat gives us Apple's voice-processing
            // I/O (the same AEC the Mac path uses), so Seraphine's own TTS
            // is cancelled out of the mic instead of re-triggering the wake
            // word. .mixWithOthers keeps other apps' audio playing — an
            // always-on listener must not stop the user's music.
            try session.setCategory(
                .playAndRecord, mode: .voiceChat,
                options: [.allowBluetooth, .allowBluetoothA2DP, .defaultToSpeaker,
                          .mixWithOthers])
            try session.setActive(true, options: [])
        } catch {
            return WW_ERR_SESSION
        }

        let input = engine.inputNode
        // Hardware echo cancellation. Best-effort: unavailable on some
        // route configurations, and the chain still works without it.
        if #available(iOS 13.0, *) {
            try? input.setVoiceProcessingEnabled(true)
        }

        let inputFormat = input.outputFormat(forBus: 0)
        guard inputFormat.sampleRate > 0, inputFormat.channelCount > 0 else {
            return WW_ERR_FORMAT
        }
        guard
            let outputFormat = AVAudioFormat(
                commonFormat: .pcmFormatInt16, sampleRate: TARGET_SAMPLE_RATE,
                channels: 1, interleaved: true),
            let conv = AVAudioConverter(from: inputFormat, to: outputFormat)
        else {
            return WW_ERR_FORMAT
        }
        converter = conv

        // ~100 ms at the device rate, matching the cadence mic.rs emits at.
        let bufferSize = AVAudioFrameCount(inputFormat.sampleRate / 10)
        input.removeTap(onBus: 0)
        input.installTap(onBus: 0, bufferSize: bufferSize, format: inputFormat) {
            [weak self] buffer, _ in
            self?.forward(buffer, to: outputFormat)
        }

        engine.prepare()
        do {
            try engine.start()
        } catch {
            input.removeTap(onBus: 0)
            return WW_ERR_ENGINE
        }
        running = true
        return WW_OK
    }

    func stop() {
        guard running else { return }
        running = false
        engine.inputNode.removeTap(onBus: 0)
        engine.stop()
        converter = nil
        // Give the session back so other apps can take the mic and the
        // system stops showing the recording indicator.
        try? AVAudioSession.sharedInstance().setActive(
            false, options: [.notifyOthersOnDeactivation])
    }

    /// Resample/downmix to 16 kHz mono Int16 and hand the samples to Rust.
    private func forward(_ buffer: AVAudioPCMBuffer, to outputFormat: AVAudioFormat) {
        guard let converter = converter else { return }
        let ratio = outputFormat.sampleRate / buffer.format.sampleRate
        let capacity = AVAudioFrameCount((Double(buffer.frameLength) * ratio).rounded(.up)) + 16
        guard let out = AVAudioPCMBuffer(pcmFormat: outputFormat, frameCapacity: capacity) else {
            return
        }

        var consumed = false
        var error: NSError?
        let status = converter.convert(to: out, error: &error) { _, outStatus in
            if consumed {
                outStatus.pointee = .noDataNow
                return nil
            }
            consumed = true
            outStatus.pointee = .haveData
            return buffer
        }
        guard status != .error, error == nil, out.frameLength > 0,
              let channel = out.int16ChannelData
        else { return }

        seraphine_wakeword_push_pcm(channel[0], Int32(out.frameLength))
    }

    // A phone call (or Siri) tears the session down. Without this the wake
    // word would come back from the interruption permanently deaf.
    @objc private func handleInterruption(_ note: Notification) {
        guard
            let info = note.userInfo,
            let raw = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: raw)
        else { return }

        switch type {
        case .began:
            engine.pause()
        case .ended:
            let wanted = running
            running = false
            if wanted { _ = start() }
        @unknown default:
            break
        }
    }

    @objc private func handleMediaServicesReset(_ note: Notification) {
        let wanted = running
        stop()
        if wanted { _ = start() }
    }
}

@_cdecl("seraphine_wakeword_audio_start")
public func seraphine_wakeword_audio_start() -> Int32 {
    if Thread.isMainThread { return WakeWordAudio.shared.start() }
    var result: Int32 = WW_ERR_ENGINE
    DispatchQueue.main.sync { result = WakeWordAudio.shared.start() }
    return result
}

@_cdecl("seraphine_wakeword_audio_stop")
public func seraphine_wakeword_audio_stop() {
    if Thread.isMainThread {
        WakeWordAudio.shared.stop()
    } else {
        DispatchQueue.main.sync { WakeWordAudio.shared.stop() }
    }
}

#endif
