/// <reference types="vite/client" />
import type { SketchbookAPI } from '../../shared/ipc'

declare global {
  interface Window {
    sketchbook: SketchbookAPI
    EXCALIDRAW_ASSET_PATH?: string | string[]
  }
}
