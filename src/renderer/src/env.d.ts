/// <reference types="vite/client" />

import type { UnderleafApi } from '@shared/api'

declare global {
  interface Window {
    api: UnderleafApi
  }
}

export {}
