/** Build a minimal WAV container around raw PCM (16kHz, mono, Int16 LE). */
export function buildWavBuffer(pcmChunks: Buffer[]): Buffer {
  const pcmData = Buffer.concat(pcmChunks)
  const sampleRate = 16000
  const numChannels = 1
  const bitsPerSample = 16
  const byteRate = sampleRate * numChannels * (bitsPerSample / 8)
  const blockAlign = numChannels * (bitsPerSample / 8)
  const dataSize = pcmData.length
  const wav = Buffer.allocUnsafe(44 + dataSize)
  let o = 0
  wav.write('RIFF', o); o += 4
  wav.writeUInt32LE(36 + dataSize, o); o += 4
  wav.write('WAVE', o); o += 4
  wav.write('fmt ', o); o += 4
  wav.writeUInt32LE(16, o); o += 4
  wav.writeUInt16LE(1, o); o += 2              // PCM
  wav.writeUInt16LE(numChannels, o); o += 2
  wav.writeUInt32LE(sampleRate, o); o += 4
  wav.writeUInt32LE(byteRate, o); o += 4
  wav.writeUInt16LE(blockAlign, o); o += 2
  wav.writeUInt16LE(bitsPerSample, o); o += 2
  wav.write('data', o); o += 4
  wav.writeUInt32LE(dataSize, o); o += 4
  pcmData.copy(wav, o)
  return wav
}
