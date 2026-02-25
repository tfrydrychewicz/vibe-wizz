/**
 * AudioCapture — system audio + microphone capture binary for macOS 13+.
 *
 * Captures system audio output (what plays during Zoom/Meet calls) via
 * ScreenCaptureKit SCStream plus microphone input via AVAudioEngine,
 * mixes them to PCM Int16 16kHz mono, and streams 256ms chunks as
 * base64-encoded JSON lines to stdout.
 *
 * Design notes:
 *   • SCStream with capturesAudio=true is the reliable, Apple-supported way
 *     to capture system audio on macOS 13+.
 *   • Microphone is captured by a separate AVAudioEngine at 16 kHz mono.
 *   • IMPORTANT — each stream has its OWN buffer (sysBuf / micBuf).
 *     Mixing into a single buffer was wrong: both streams would advance
 *     mixBufPos sequentially, so the buffer grew at 2× the drain rate and
 *     overflowed every ~2 seconds, silently dropping all new audio.
 *     With separate buffers the timer drains each independently and sums them.
 *   • A DispatchSourceTimer drains both buffers every 256 ms, mixes them
 *     additively, and emits an Int16 JSON chunk.
 *
 * Protocol (stdout, one JSON object per line):
 *   {"type":"ready"}                              — recording started
 *   {"type":"audio_chunk","data":"<base64pcm>"}   — 256ms PCM Int16 16kHz mono
 *   {"type":"error","message":"..."}              — fatal error
 *
 * Lifecycle: SIGTERM / SIGINT → stop stream + engine, exit 0.
 */

import AVFoundation
import CoreAudio
import Foundation
import ScreenCaptureKit

// MARK: - JSON output

func emit(type: String, data: String? = nil, message: String? = nil) {
    var obj: [String: Any] = ["type": type]
    if let d = data    { obj["data"]    = d }
    if let m = message { obj["message"] = m }
    guard let jsonData = try? JSONSerialization.data(withJSONObject: obj),
          let json = String(data: jsonData, encoding: .utf8) else { return }
    print(json)
    fflush(stdout)
}

// MARK: - Constants

let kTargetSampleRate: Double = 16_000
let kChunkSamples = 4096   // 256 ms @ 16 kHz
let kBufCapacity  = kChunkSamples * 8   // 2 s per stream; drained every 256 ms

// MARK: - Separate stream buffers
//
// Each audio source (system audio from SCStream, mic from AVAudioEngine) has
// its own linear buffer with an independent write pointer.  The timer mixes
// them at drain time by adding corresponding sample positions together.
// This prevents the "sequential overflow" bug that occurred when both sources
// advanced a single shared write pointer (combined rate 2× drain rate).

var sysBuf  = [Float](repeating: 0, count: kBufCapacity)
var sysPos  = 0   // next free write index in sysBuf
var micBuf  = [Float](repeating: 0, count: kBufCapacity)
var micPos  = 0   // next free write index in micBuf
let bufLock = NSLock()

func appendSysAudio(_ ptr: UnsafePointer<Float>, count: Int) {
    guard count > 0 else { return }
    bufLock.lock()
    let n = min(count, kBufCapacity - sysPos)
    if n > 0 {
        for i in 0..<n { sysBuf[sysPos + i] = ptr[i] }
        sysPos += n
    }
    bufLock.unlock()
}

func appendMicAudio(_ ptr: UnsafePointer<Float>, count: Int) {
    guard count > 0 else { return }
    bufLock.lock()
    let n = min(count, kBufCapacity - micPos)
    if n > 0 {
        for i in 0..<n { micBuf[micPos + i] = ptr[i] }
        micPos += n
    }
    bufLock.unlock()
}

// MARK: - Globals for shutdown

var scStreamRef:   SCStream?            = nil
var micEngineRef:  AVAudioEngine?       = nil
var chunkTimerRef: DispatchSourceTimer? = nil

// MARK: - SCStream delegate for system audio

final class SystemAudioDelegate: NSObject, SCStreamOutput, SCStreamDelegate {

    var diagCount = 0   // emit first-few-callback diagnostics to stderr

    func stream(_ stream: SCStream,
                didOutputSampleBuffer sampleBuffer: CMSampleBuffer,
                of type: SCStreamOutputType) {
        guard type == .audio else { return }
        let numFrames = CMSampleBufferGetNumSamples(sampleBuffer)
        guard numFrames > 0 else { return }

        // Read the actual delivered format — SCStream may not honour sampleRate=16000.
        guard let fmtDesc = sampleBuffer.formatDescription,
              let asbdPtr = CMAudioFormatDescriptionGetStreamBasicDescription(fmtDesc) else { return }
        let asbd      = asbdPtr.pointee
        let srcRate   = asbd.mSampleRate
        let srcCh     = Int(asbd.mChannelsPerFrame)
        let isNonInterleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0
        let isFloat   = (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0
        let fmtID     = asbd.mFormatID  // should be kAudioFormatLinearPCM

        // Extract audio bytes from the first (and for mono: only) buffer.
        var audioList = AudioBufferList()
        var blockBuf:  CMBlockBuffer?
        guard CMSampleBufferGetAudioBufferListWithRetainedBlockBuffer(
            sampleBuffer,
            bufferListSizeNeededOut: nil,
            bufferListOut: &audioList,
            bufferListSize: MemoryLayout<AudioBufferList>.size,
            blockBufferAllocator: nil,
            blockBufferMemoryAllocator: nil,
            flags: kCMSampleBufferFlag_AudioBufferList_Assure16ByteAlignment,
            blockBufferOut: &blockBuf) == noErr,
              let rawData = audioList.mBuffers.mData else { return }

        let byteCount = Int(audioList.mBuffers.mDataByteSize)

        // Bail if the format isn't Float32 PCM — we can't interpret it as Float.
        guard isFloat && fmtID == kAudioFormatLinearPCM else {
            if diagCount < 3 {
                diagCount += 1
                fputs("[AudioCapture] Unexpected audio format: fmtID=\(fmtID) isFloat=\(isFloat) — skipping\n", stderr)
            }
            return
        }

        let samples   = rawData.assumingMemoryBound(to: Float32.self)

        // For interleaved formats mDataByteSize covers all channels per frame.
        // For non-interleaved, mBuffers[0] holds only channel 0.
        let frameCount = isNonInterleaved
            ? byteCount / MemoryLayout<Float32>.size          // frames in ch0
            : byteCount / (srcCh * MemoryLayout<Float32>.size)// frames across all ch

        guard frameCount > 0 else { return }

        // Diagnostic: log format + peak amplitude for the first few callbacks.
        if diagCount < 5 {
            diagCount += 1
            let checkN = min(frameCount * (isNonInterleaved ? 1 : srcCh), 256)
            var peak: Float = 0
            for i in 0..<checkN { peak = max(peak, abs(samples[i])) }
            fputs("[AudioCapture] cb#\(diagCount): rate=\(srcRate) ch=\(srcCh) nonInterleaved=\(isNonInterleaved) frames=\(frameCount) peak=\(peak)\n", stderr)
        }

        // Fast path: already 16 kHz mono — append directly to sys buffer.
        if srcRate == kTargetSampleRate && srcCh == 1 {
            appendSysAudio(samples, count: frameCount)
            return
        }

        // General path: windowed-average resample + mono downmix.
        let ratio    = srcRate / kTargetSampleRate
        let outCount = max(1, Int(Double(frameCount) / ratio))
        var outBuf   = [Float](repeating: 0, count: outCount)
        let halfW    = max(0.5, ratio * 0.5)

        if isNonInterleaved || srcCh == 1 {
            var pos = 0.0
            for i in 0..<outCount {
                let s = max(0, Int(pos - halfW + 0.5))
                let e = min(frameCount - 1, Int(pos + halfW - 0.5))
                var sum: Float = 0
                let n = e - s + 1
                for j in s...e { sum += samples[j] }
                outBuf[i] = sum / Float(n)
                pos += ratio
            }
        } else {
            var pos = 0.0
            let invCh = Float(1) / Float(srcCh)
            for i in 0..<outCount {
                let s = max(0, Int(pos - halfW + 0.5))
                let e = min(frameCount - 1, Int(pos + halfW - 0.5))
                var sum: Float = 0
                let n = e - s + 1
                for fi in s...e {
                    var frameSum: Float = 0
                    for ch in 0..<srcCh { frameSum += samples[fi * srcCh + ch] }
                    sum += frameSum * invCh
                }
                outBuf[i] = sum / Float(n)
                pos += ratio
            }
        }

        outBuf.withUnsafeBufferPointer { ptr in
            if let base = ptr.baseAddress { appendSysAudio(base, count: outCount) }
        }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(type: "error",
             message: "System audio stream stopped unexpectedly: \(error.localizedDescription)")
    }
}

// Keep delegate alive.
let sysAudioDelegate = SystemAudioDelegate()

// MARK: - Microphone engine

func startMicEngine() {
    let engine = AVAudioEngine()
    micEngineRef = engine

    let inputNode  = engine.inputNode
    let nativeFmt  = inputNode.outputFormat(forBus: 0)
    let targetFmt  = AVAudioFormat(
        commonFormat: .pcmFormatFloat32,
        sampleRate: kTargetSampleRate,
        channels: 1,
        interleaved: false)!

    guard let conv = AVAudioConverter(from: nativeFmt, to: targetFmt) else {
        emit(type: "error", message: "Failed to create mic AVAudioConverter.")
        exit(1)
    }

    inputNode.installTap(
        onBus: 0,
        bufferSize: AVAudioFrameCount(kChunkSamples),
        format: nativeFmt
    ) { buf, _ in
        let outCap = AVAudioFrameCount(
            Double(buf.frameLength) * kTargetSampleRate / nativeFmt.sampleRate + 1)
        guard let out = AVAudioPCMBuffer(pcmFormat: targetFmt, frameCapacity: outCap) else { return }
        var used = false
        conv.convert(to: out, error: nil) { _, status in
            if used { status.pointee = .noDataNow; return nil }
            status.pointee = .haveData; used = true; return buf
        }
        if let ch = out.floatChannelData?[0] { appendMicAudio(ch, count: Int(out.frameLength)) }
    }

    do {
        engine.prepare()
        try engine.start()
    } catch {
        emit(type: "error", message: "Failed to start mic engine: \(error.localizedDescription)")
        exit(1)
    }
}

// MARK: - Output timer

func startOutputTimer() {
    let timer = DispatchSource.makeTimerSource(queue: .global(qos: .userInitiated))
    chunkTimerRef = timer
    timer.schedule(deadline: .now() + .milliseconds(256), repeating: .milliseconds(256))
    timer.setEventHandler {
        bufLock.lock()

        // How many samples each stream has available (up to one chunk).
        let sysF = min(sysPos, kChunkSamples)
        let micF = min(micPos, kChunkSamples)
        let frames = max(sysF, micF)
        guard frames > 0 else { bufLock.unlock(); return }

        // Mix: sum system audio and mic sample-by-sample.
        // Where only one stream has data the other contributes 0.
        var outBuf = [Float](repeating: 0, count: frames)
        for i in 0..<sysF { outBuf[i] += sysBuf[i] }
        for i in 0..<micF { outBuf[i] += micBuf[i] }

        // Compact system audio buffer (shift tail to front, zero freed region).
        let sysRem = sysPos - sysF
        for i in 0..<sysRem { sysBuf[i] = sysBuf[sysF + i] }
        for i in 0..<sysF   { sysBuf[sysRem + i] = 0 }
        sysPos = sysRem

        // Compact mic buffer.
        let micRem = micPos - micF
        for i in 0..<micRem { micBuf[i] = micBuf[micF + i] }
        for i in 0..<micF   { micBuf[micRem + i] = 0 }
        micPos = micRem

        bufLock.unlock()

        // Attenuate (0.6 headroom for mixed signal), clamp, convert to Int16.
        var i16 = [Int16](repeating: 0, count: frames)
        for i in 0..<frames {
            let v = max(-1.0, min(1.0, outBuf[i] * 0.6))
            i16[i] = Int16(v * 32_767)
        }
        let raw = i16.withUnsafeBufferPointer { Data(buffer: $0) }
        emit(type: "audio_chunk", data: raw.base64EncodedString())
    }
    timer.resume()
}

// MARK: - Graceful shutdown

func gracefulStop() {
    chunkTimerRef?.cancel()
    micEngineRef?.inputNode.removeTap(onBus: 0)
    micEngineRef?.stop()
    scStreamRef?.stopCapture { _ in }
    exit(0)
}

// MARK: - Signal handlers

signal(SIGTERM, SIG_IGN)
signal(SIGINT,  SIG_IGN)

let sigtermSrc = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
sigtermSrc.setEventHandler { gracefulStop() }
sigtermSrc.resume()

let sigintSrc = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
sigintSrc.setEventHandler { gracefulStop() }
sigintSrc.resume()

// MARK: - SCStream audio capture setup

DispatchQueue.main.async {
    SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: false) { content, error in
        guard let content = content, let display = content.displays.first else {
            emit(type: "error",
                 message: "Screen & System Audio Recording permission denied or no display found. " +
                          "Grant it in System Settings → Privacy & Security, then restart Wizz.")
            exit(1)
        }

        DispatchQueue.main.async {
            let filter = SCContentFilter(display: display, excludingWindows: [])

            let config = SCStreamConfiguration()
            config.capturesAudio              = true
            config.excludesCurrentProcessAudio = true
            config.sampleRate                 = Int(kTargetSampleRate)  // 16 000 Hz
            config.channelCount               = 1                        // mono
            // Minimise video overhead (SCStream always captures video)
            config.minimumFrameInterval       = CMTime(value: 1, timescale: 1)  // 1 fps
            config.width                      = 2
            config.height                     = 2
            config.showsCursor                = false

            let stream = SCStream(filter: filter, configuration: config,
                                  delegate: sysAudioDelegate)
            scStreamRef = stream

            do {
                try stream.addStreamOutput(sysAudioDelegate, type: .audio,
                                           sampleHandlerQueue: .global(qos: .userInteractive))
            } catch {
                emit(type: "error",
                     message: "Failed to add audio stream output: \(error.localizedDescription)")
                exit(1)
            }

            stream.startCapture { captureError in
                if let captureError = captureError {
                    emit(type: "error",
                         message: "SCStream start failed: \(captureError.localizedDescription)")
                    exit(1)
                }
                // System audio is streaming; start mic and timer on main queue.
                DispatchQueue.main.async {
                    startMicEngine()
                    startOutputTimer()
                    emit(type: "ready")
                }
            }
        }
    }
}

// MARK: - Run loop
RunLoop.main.run()
