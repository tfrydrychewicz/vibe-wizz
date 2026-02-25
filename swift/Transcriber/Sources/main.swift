/**
 * Transcriber — macOS SFSpeechRecognizer binary for offline meeting transcription.
 *
 * Usage: ./Transcriber
 *   No arguments — uses SFSpeechRecognizer() which defaults to Locale.current
 *   (the macOS system language). Polish macOS → pl-PL, English macOS → en-US, etc.
 *
 * Protocol (stdout, one JSON object per line):
 *   {"type":"ready"}                                       — ready to receive audio
 *   {"type":"partial","text":"...","isFinal":false}        — non-final transcript
 *   {"type":"partial","text":"...","isFinal":true}         — committed segment
 *   {"type":"error","message":"..."}                       — error (non-fatal unless startup)
 *
 * Lifecycle:
 *   SIGTERM / SIGINT → stop audio, flush final recognition result, exit 0.
 */

import Foundation
import Speech

// MARK: – JSON output

func emit(type: String, text: String? = nil, isFinal: Bool? = nil, message: String? = nil) {
    var obj: [String: Any] = ["type": type]
    if let t = text    { obj["text"]    = t }
    if let f = isFinal { obj["isFinal"] = f }
    if let m = message { obj["message"] = m }
    guard let data = try? JSONSerialization.data(withJSONObject: obj),
          let json = String(data: data, encoding: .utf8) else { return }
    print(json)
    fflush(stdout)
}

// MARK: – Authorization

let authSema = DispatchSemaphore(value: 0)
SFSpeechRecognizer.requestAuthorization { _ in authSema.signal() }
authSema.wait()

guard SFSpeechRecognizer.authorizationStatus() == .authorized else {
    emit(type: "error", message: "Speech recognition not authorized. Grant permission in System Settings → Privacy → Speech Recognition.")
    exit(1)
}

// MARK: – Recognizer

// SFSpeechRecognizer() without a locale uses Locale.current (the macOS system language).
guard let recognizer = SFSpeechRecognizer(), recognizer.isAvailable else {
    emit(type: "error", message: "Speech recognizer unavailable on this device")
    exit(1)
}

// MARK: – Audio engine + recognition request

let audioEngine = AVAudioEngine()
let request = SFSpeechAudioBufferRecognitionRequest()
request.shouldReportPartialResults = true
// requiresOnDeviceRecognition is intentionally NOT set (defaults to false = online Apple
// Speech servers). Forcing on-device fails with "Siri and Dictation are disabled" when
// the user has Siri turned off in System Settings, even if the language model is present.

let inputNode = audioEngine.inputNode
let recordingFormat = inputNode.outputFormat(forBus: 0)
inputNode.installTap(onBus: 0, bufferSize: 1024, format: recordingFormat) { buf, _ in
    request.append(buf)
}

// MARK: – Recognition task

var lastText = ""
var finalEmitted = false
let finalSema = DispatchSemaphore(value: 0)

let recognitionTask = recognizer.recognitionTask(with: request) { result, error in
    if let err = error as NSError? {
        // Ignore benign codes: 1101 = no speech, 209/216/203 = cancelled/stopped
        let ignoredCodes = Set([1101, 203, 209, 216, 301])
        if !ignoredCodes.contains(err.code) {
            emit(type: "error", message: err.localizedDescription)
        }
        if !finalEmitted {
            finalEmitted = true
            emit(type: "partial", text: lastText, isFinal: true)
        }
        finalSema.signal()
        return
    }
    guard let r = result else { return }
    let text = r.bestTranscription.formattedString
    if !text.isEmpty {
        lastText = text
        // isFinal=true on natural sentence completion; isFinal=false while speaking
        emit(type: "partial", text: text, isFinal: r.isFinal)
    }
    if r.isFinal {
        finalEmitted = true
        finalSema.signal()
    }
}

// MARK: – Start

do {
    audioEngine.prepare()
    try audioEngine.start()
    emit(type: "ready")
} catch {
    emit(type: "error", message: "Failed to start audio engine: \(error.localizedDescription)")
    exit(1)
}

// MARK: – Graceful shutdown

signal(SIGTERM, SIG_IGN)
signal(SIGINT, SIG_IGN)

func gracefulStop() {
    audioEngine.stop()
    inputNode.removeTap(onBus: 0)
    request.endAudio()
    // Wait up to 5 s for the recognition task to deliver the final result
    _ = finalSema.wait(timeout: .now() + 5)
    if !finalEmitted {
        finalEmitted = true
        emit(type: "partial", text: lastText, isFinal: true)
    }
    exit(0)
}

let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
sigtermSrc.setEventHandler { gracefulStop() }
sigtermSrc.resume()

let sigintSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
sigintSrc.setEventHandler { gracefulStop() }
sigintSrc.resume()

// MARK: – Main run loop
RunLoop.main.run()
