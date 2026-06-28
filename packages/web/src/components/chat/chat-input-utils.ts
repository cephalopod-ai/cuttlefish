import type { MediaAttachment } from '@/lib/conversations'

export interface Employee {
  name: string
  displayName?: string
  department?: string
  rank?: string
  engine?: string
  avatar?: string
  emoji?: string
}

export interface SlashCommand {
  name: string
  description: string
  /** Whether this command needs an @employee argument */
  needsEmployee?: boolean
}

/** Built-in commands handled client-side (not sent to engine) */
export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'new', description: 'Start a new chat session' },
  { name: 'status', description: 'Show current session info' },
]

export type ClientCommand = 'new' | 'status'

export function resolveClientCommand(text: string): ClientCommand | null {
  const trimmed = text.trim()
  if (trimmed === '/new') return 'new'
  if (trimmed === '/status') return 'status'
  return null
}

function resizeImage(file: File, maxPx: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    const url = URL.createObjectURL(file)
    img.onload = () => {
      URL.revokeObjectURL(url)
      let { width, height } = img
      if (width > maxPx || height > maxPx) {
        const scale = maxPx / Math.max(width, height)
        width = Math.round(width * scale)
        height = Math.round(height * scale)
      }
      const canvas = document.createElement('canvas')
      canvas.width = width
      canvas.height = height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('no canvas context')); return }
      ctx.drawImage(img, 0, 0, width, height)
      const mimeType = file.size > 50000 ? 'image/jpeg' : 'image/png'
      const quality = mimeType === 'image/jpeg' ? 0.85 : undefined
      resolve(canvas.toDataURL(mimeType, quality))
    }
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('image load failed')) }
    img.src = url
  })
}

export async function fileToAttachment(file: File): Promise<MediaAttachment> {
  const isImage = file.type.startsWith('image/')
  const isAudio = file.type.startsWith('audio/')

  let dataUrl: string
  if (isImage) {
    dataUrl = await resizeImage(file, 1200)
  } else {
    dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader()
      reader.onloadend = () => resolve(reader.result as string)
      reader.onerror = reject
      reader.readAsDataURL(file)
    })
  }

  return {
    type: isImage ? 'image' : isAudio ? 'audio' : 'file',
    url: dataUrl,
    name: file.name,
    mimeType: file.type,
    size: file.size,
    file,
  }
}
