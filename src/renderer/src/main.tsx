import { createRoot } from 'react-dom/client'
import '@fontsource-variable/noto-sans/index.css'
// PDF.js styles come first so that the app's own rules can override them.
import 'pdfjs-dist/web/pdf_viewer.css'
import './styles/base.css'
import './styles/dashboard.css'
import './styles/ide.css'
import { App } from './App'

const root = document.getElementById('root')
if (!root) throw new Error('Missing #root element')
createRoot(root).render(<App />)
