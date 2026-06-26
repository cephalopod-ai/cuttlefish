import { describe, it, expect, vi } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MessageMedia } from '../message-media'
import { stripAttachedFilesBlock } from '@/lib/conversations'
import type { MediaAttachment } from '@/lib/conversations'

// VoiceMessage pulls in audio APIs jsdom lacks; we only test image/file rendering here.
vi.mock('../voice-message', () => ({ VoiceMessage: () => null }))

const mixed: MediaAttachment[] = [
  { type: 'image', url: '/api/files/a', name: 'one.png' },
  { type: 'image', url: '/api/files/b', name: 'two.png' },
  { type: 'image', url: '/api/files/c', name: 'three.png' },
  { type: 'file', url: '/api/files/z', name: 'bundle.zip', size: 2048, mimeType: 'application/zip' },
]

describe('MessageMedia (multi-file)', () => {
  it('renders every image and the file chip without clobbering', () => {
    render(<MessageMedia media={mixed} isUser={false} />)
    const imgs = screen.getAllByRole('img')
    expect(imgs).toHaveLength(3)
    expect(screen.getByText('bundle.zip')).toBeTruthy()
    // download links/anchors exist for the file chip (and lightbox provides one when open)
    const dl = screen.getByLabelText('Download bundle.zip') as HTMLAnchorElement
    expect(dl.getAttribute('href')).toBe('/api/files/z')
  })

  it('opens a lightbox with a download link on image click, and closes it', () => {
    render(<MessageMedia media={mixed} isUser={false} />)
    expect(screen.queryByRole('dialog')).toBeNull()

    fireEvent.click(screen.getByLabelText('Open one.png'))
    const dialog = screen.getByRole('dialog')
    expect(dialog).toBeTruthy()
    const lightboxDownload = screen.getByLabelText('Download image') as HTMLAnchorElement
    expect(lightboxDownload.getAttribute('href')).toBe('/api/files/a')

    fireEvent.click(screen.getByLabelText('Close'))
    expect(screen.queryByRole('dialog')).toBeNull()
  })

  it('renders a single image larger (no grid) without error', () => {
    render(<MessageMedia media={[mixed[0]]} isUser={true} />)
    expect(screen.getAllByRole('img')).toHaveLength(1)
  })
})

describe('MessageMedia image loading states', () => {
  it('shows a skeleton before load, then swaps to the image on onLoad', () => {
    render(<MessageMedia media={[mixed[0]]} isUser={false} />)
    // Skeleton placeholder is present while the image loads.
    expect(screen.getByTestId('image-skeleton')).toBeTruthy()
    const img = screen.getByAltText('one.png') as HTMLImageElement
    expect(img).toBeTruthy()
    // After the image fires onLoad, the skeleton is removed (image is revealed).
    fireEvent.load(img)
    expect(screen.queryByTestId('image-skeleton')).toBeNull()
  })

  it('renders one skeleton per image in a multi-image grid', () => {
    render(<MessageMedia media={mixed} isUser={false} />)
    // 3 images → 3 skeletons before any load fires.
    expect(screen.getAllByTestId('image-skeleton')).toHaveLength(3)
  })

  it('falls back to a broken-image placeholder on error (no infinite skeleton)', () => {
    render(<MessageMedia media={[mixed[0]]} isUser={false} />)
    const img = screen.getByAltText('one.png') as HTMLImageElement
    fireEvent.error(img)
    expect(screen.queryByTestId('image-skeleton')).toBeNull()
    // graceful fallback labelled, original <img> gone
    expect(screen.getByLabelText('one.png (failed to load)')).toBeTruthy()
    expect(screen.queryByAltText('one.png')).toBeNull()
  })
})

describe('stripAttachedFilesBlock', () => {
  it('removes the appended engine-only Attached files block', () => {
    const text = 'Please analyze this\n\nAttached files:\n- /Users/x/.cuttlefish/uploads/2026-05-30/s/report.pdf'
    expect(stripAttachedFilesBlock(text)).toBe('Please analyze this')
  })
  it('removes a multi-path block', () => {
    const text = 'hi\n\nAttached files:\n- /a/one.png\n- /a/two.zip'
    expect(stripAttachedFilesBlock(text)).toBe('hi')
  })
  it('leaves normal text untouched', () => {
    expect(stripAttachedFilesBlock('just a message')).toBe('just a message')
  })
})
