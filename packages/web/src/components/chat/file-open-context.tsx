import { createContext, useContext } from 'react'

/** Provides a way for chat message path-links to open a file in an in-app tab. */
export const FileOpenContext = createContext<((path: string) => void) | null>(null)

export function useOpenFile() {
  return useContext(FileOpenContext)
}
