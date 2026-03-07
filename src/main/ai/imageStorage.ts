/**
 * Stores AI-generated images on disk in the user data directory.
 *
 * Images are saved to `{userData}/generated-images/{uuid}.{ext}` and can be
 * referenced in TipTap note content as local file paths.
 */

import { app } from 'electron'
import { join } from 'path'
import { mkdir, writeFile } from 'fs/promises'
import { randomUUID } from 'crypto'

const GENERATED_IMAGES_DIR = 'generated-images'

const MIME_TO_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/webp': 'webp',
}

function getImageDir(): string {
  return join(app.getPath('userData'), GENERATED_IMAGES_DIR)
}

/**
 * Save a base64-encoded generated image to disk.
 * Returns the absolute file path of the saved image.
 */
export async function saveGeneratedImage(
  base64: string,
  mimeType: string,
): Promise<string> {
  const dir = getImageDir()
  await mkdir(dir, { recursive: true })

  const ext = MIME_TO_EXT[mimeType] ?? 'png'
  const filename = `${randomUUID()}.${ext}`
  const filePath = join(dir, filename)

  const buffer = Buffer.from(base64, 'base64')
  await writeFile(filePath, buffer)

  return filePath
}

/**
 * Returns the directory where generated images are stored.
 */
export function getGeneratedImageDir(): string {
  return getImageDir()
}
