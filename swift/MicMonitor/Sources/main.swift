import CoreAudio
import Foundation

// MARK: - Event Output

struct Event: Encodable {
    let type: String
    let timestamp: String
    let deviceName: String?
    let isActive: Bool
}

func emit(_ event: Event) {
    let encoder = JSONEncoder()
    if let data = try? encoder.encode(event),
       let json = String(data: data, encoding: .utf8) {
        print(json)
        fflush(stdout)
    }
}

func now() -> String {
    ISO8601DateFormatter().string(from: Date())
}

// MARK: - Audio Helpers

func getDefaultInputDevice() -> AudioDeviceID? {
    var deviceID = AudioDeviceID(0)
    var size = UInt32(MemoryLayout<AudioDeviceID>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDefaultInputDevice,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address, 0, nil, &size, &deviceID
    )
    guard status == noErr, deviceID != kAudioObjectUnknown else { return nil }
    return deviceID
}

func getDeviceName(_ deviceID: AudioDeviceID) -> String? {
    var name: CFString = "" as CFString
    var size = UInt32(MemoryLayout<CFString>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioObjectPropertyName,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    let status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &name)
    guard status == noErr else { return nil }
    return name as String
}

func isDeviceRunning(_ deviceID: AudioDeviceID) -> Bool {
    // Try kAudioDevicePropertyDeviceIsRunningSomewhere (input scope)
    var isRunning: UInt32 = 0
    var size = UInt32(MemoryLayout<UInt32>.size)
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioDevicePropertyDeviceIsRunningSomewhere,
        mScope: kAudioObjectPropertyScopeInput,
        mElement: kAudioObjectPropertyElementMain
    )
    var status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &isRunning)
    if status == noErr && isRunning != 0 {
        return true
    }

    // Fallback: kAudioDevicePropertyDeviceIsRunning (input scope)
    isRunning = 0
    address.mSelector = kAudioDevicePropertyDeviceIsRunning
    status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &isRunning)
    if status == noErr && isRunning != 0 {
        return true
    }

    // Fallback: global scope
    isRunning = 0
    address.mSelector = kAudioDevicePropertyDeviceIsRunningSomewhere
    address.mScope = kAudioObjectPropertyScopeGlobal
    status = AudioObjectGetPropertyData(deviceID, &address, 0, nil, &size, &isRunning)
    if status == noErr && isRunning != 0 {
        return true
    }

    return false
}

func getAllInputDevices() -> [AudioDeviceID] {
    var size: UInt32 = 0
    var address = AudioObjectPropertyAddress(
        mSelector: kAudioHardwarePropertyDevices,
        mScope: kAudioObjectPropertyScopeGlobal,
        mElement: kAudioObjectPropertyElementMain
    )
    AudioObjectGetPropertyDataSize(
        AudioObjectID(kAudioObjectSystemObject),
        &address, 0, nil, &size
    )
    let count = Int(size) / MemoryLayout<AudioDeviceID>.size
    var devices = [AudioDeviceID](repeating: 0, count: count)
    AudioObjectGetPropertyData(
        AudioObjectID(kAudioObjectSystemObject),
        &address, 0, nil, &size, &devices
    )

    // Filter to devices that have input channels
    return devices.filter { device in
        var streamSize: UInt32 = 0
        var streamAddress = AudioObjectPropertyAddress(
            mSelector: kAudioDevicePropertyStreams,
            mScope: kAudioObjectPropertyScopeInput,
            mElement: kAudioObjectPropertyElementMain
        )
        AudioObjectGetPropertyDataSize(device, &streamAddress, 0, nil, &streamSize)
        return streamSize > 0
    }
}

// MARK: - Main polling loop

func main() {
    setbuf(stdout, nil)

    var lastState = false

    // Log all input devices at startup for diagnostics
    let allInputs = getAllInputDevices()
    for dev in allInputs {
        let name = getDeviceName(dev) ?? "unknown"
        let running = isDeviceRunning(dev)
        emit(Event(
            type: "log",
            timestamp: now(),
            deviceName: "\(name) (id:\(dev), running:\(running))",
            isActive: running
        ))
    }

    // Emit initial state
    if let device = getDefaultInputDevice() {
        let name = getDeviceName(device)
        let active = isDeviceRunning(device)
        lastState = active
        emit(Event(type: active ? "mic_active" : "mic_inactive",
                    timestamp: now(), deviceName: name, isActive: active))
    }

    // Handle signals
    signal(SIGTERM) { _ in exit(0) }
    signal(SIGINT) { _ in exit(0) }

    // Poll every second — check ALL input devices
    let timer = DispatchSource.makeTimerSource(queue: .global())
    timer.schedule(deadline: .now() + 1.0, repeating: 1.0)
    timer.setEventHandler {
        let inputs = getAllInputDevices()
        let anyRunning = inputs.contains { isDeviceRunning($0) }

        if anyRunning != lastState {
            lastState = anyRunning

            var activeName: String? = nil
            if anyRunning {
                if let activeDevice = inputs.first(where: { isDeviceRunning($0) }) {
                    activeName = getDeviceName(activeDevice)
                }
            } else {
                activeName = getDeviceName(getDefaultInputDevice() ?? 0)
            }

            emit(Event(
                type: anyRunning ? "mic_active" : "mic_inactive",
                timestamp: now(),
                deviceName: activeName,
                isActive: anyRunning
            ))
        }
    }
    timer.resume()

    dispatchMain()
}

main()
