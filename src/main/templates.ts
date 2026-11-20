// Starter content for new projects.

import fs from 'node:fs/promises'
import path from 'node:path'
import zlib from 'node:zlib'

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
]

export function escapeLatex(text: string): string {
  return text
    .replace(/\\/g, '\\textbackslash{}')
    .replace(/([&%$#_{}])/g, '\\$1')
    .replace(/~/g, '\\textasciitilde{}')
    .replace(/\^/g, '\\textasciicircum{}')
}

export function blankMainTex(projectName: string, now = new Date()): string {
  return `\\documentclass{article}
\\usepackage{graphicx} % for \\includegraphics

\\title{${escapeLatex(projectName)}}
\\author{}
\\date{${MONTHS[now.getMonth()]} ${now.getFullYear()}}

\\begin{document}

\\maketitle

\\section{Introduction}

\\end{document}
`
}

function exampleMainTex(projectName: string): string {
  return `\\documentclass{article}

% Paper size and margins
\\usepackage[a4paper, margin=2.5cm]{geometry}

% Mathematics, images, table rules and clickable references
\\usepackage{amsmath}
\\usepackage{graphicx}
\\usepackage{booktabs}
\\usepackage[colorlinks, allcolors=blue]{hyperref}

\\title{${escapeLatex(projectName)}}
\\author{Your Name}

\\begin{document}
\\maketitle

\\begin{abstract}
A short tour of what a \\LaTeX{} article is usually made of: a figure, some
mathematics, a table, lists and a bibliography. Change anything in the source
and press \\textbf{Recompile} to see the result in the PDF.
\\end{abstract}

\\section{Introduction}

Everything in this project is stored in an ordinary folder on your computer and
compiled locally, so you can keep writing without an internet connection. When
you want to work online again, download the project as a \\texttt{.zip} file and
upload it to Overleaf; the same archive format works in both directions.

Each of the following sections is a small example that stands on its own. Keep
the ones that are useful as a starting point and delete the rest.

\\section{Figures}

Images are files in the project, like the text. This project keeps its only
picture, \\texttt{wave.png}, in the \\texttt{figures} folder, and
\\verb|\\includegraphics| places it in Figure~\\ref{fig:wave}. The text points
to the figure through its label rather than a fixed number, so the reference
stays correct when figures are added or moved.

\\begin{figure}[htbp]
  \\centering
  \\includegraphics[width=0.6\\linewidth]{figures/wave.png}
  \\caption{A damped oscillation (solid) and its envelope (dashed).}
  \\label{fig:wave}
\\end{figure}

\\section{Mathematics}

A short formula such as $\\omega = 2\\pi f$ sits in the running text. A formula
that deserves a line of its own gets a number. The curve in
Figure~\\ref{fig:wave} is
\\begin{equation}
  x(t) = A\\,e^{-\\gamma t}\\sin(\\omega t),
  \\label{eq:damped}
\\end{equation}
where $A$ is the initial amplitude, $\\gamma$ the damping rate and $\\omega$ the
angular frequency. Differentiating equation~\\eqref{eq:damped} twice gives
\\begin{align}
  \\dot{x}(t)  &= A\\,e^{-\\gamma t}\\bigl(\\omega\\cos(\\omega t) - \\gamma\\sin(\\omega t)\\bigr), \\\\
  \\ddot{x}(t) &= -2\\gamma\\,\\dot{x}(t) - \\bigl(\\omega^{2} + \\gamma^{2}\\bigr)\\,x(t),
\\end{align}
which is the equation of motion of a damped harmonic oscillator.

\\section{Tables}

Table~\\ref{tab:engines} uses the \\texttt{booktabs} package for its horizontal
rules. It lists the compilers offered under \\emph{Settings} in the menu of
the editor.

\\begin{table}[htbp]
  \\centering
  \\begin{tabular}{lll}
    \\toprule
    Compiler & Fonts & Typical use \\\\
    \\midrule
    pdf\\LaTeX & Type~1 & Most journal templates \\\\
    \\LaTeX & Type~1 & Older documents with EPS figures \\\\
    Xe\\LaTeX & OpenType & Multilingual documents \\\\
    Lua\\LaTeX & OpenType & Lua scripting, fine control \\\\
    \\bottomrule
  \\end{tabular}
  \\caption{The compilers a project can use.}
  \\label{tab:engines}
\\end{table}

\\section{Lists}

A numbered list suits steps that are done in order:

\\begin{enumerate}
  \\item change the source,
  \\item recompile,
  \\item read the result in the PDF.
\\end{enumerate}
A bulleted list suits points that have no particular order:

\\begin{itemize}
  \\item double-click a place in the PDF to jump to the matching source line;
  \\item click an entry in the logs to go to the line it is about;
  \\item drop files on the file tree to add them to the project.
\\end{itemize}

\\section{Citations}

The references are kept in \\texttt{references.bib}. Every entry in that file
has a key, and \\verb|\\cite| with a key puts the matching number in the text:
the \\TeX{}book~\\cite{knuth1984}, the \\LaTeX{} manual~\\cite{lamport1994} and a
journal article~\\cite{shannon1948}. Only cited entries appear in the list of
references, which is put together automatically.

\\bibliographystyle{plain}
\\bibliography{references}

\\end{document}
`
}

const EXAMPLE_BIB = `@book{knuth1984,
  author    = {Donald E. Knuth},
  title     = {The {\\TeX}book},
  publisher = {Addison-Wesley},
  address   = {Reading, Massachusetts},
  year      = {1984}
}

@book{lamport1994,
  author    = {Leslie Lamport},
  title     = {{\\LaTeX}: A Document Preparation System},
  publisher = {Addison-Wesley},
  address   = {Reading, Massachusetts},
  edition   = {Second},
  year      = {1994}
}

@article{shannon1948,
  author  = {Claude E. Shannon},
  title   = {A Mathematical Theory of Communication},
  journal = {Bell System Technical Journal},
  volume  = {27},
  number  = {3},
  pages   = {379--423},
  year    = {1948}
}
`

// ------------------------------------------------------------ PNG figure

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c >>> 0
  }
  return table
})()

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const head = Buffer.alloc(8)
  head.writeUInt32BE(data.length, 0)
  head.write(type, 4, 'latin1')
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(Buffer.concat([head.subarray(4), data])), 0)
  return Buffer.concat([head, data, crc])
}

/** Encodes an RGB pixel buffer (3 bytes per pixel) as a PNG file. */
export function encodePng(width: number, height: number, rgb: Uint8Array): Buffer {
  const stride = width * 3
  const raw = Buffer.alloc((stride + 1) * height)
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0 // filter type: none
    raw.set(rgb.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 2 // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw, { level: 9 })),
    pngChunk('IEND', Buffer.alloc(0))
  ])
}

/** Draws the plot used by the example project: a damped sine wave with axes. */
export function exampleFigurePng(): Buffer {
  const W = 720
  const H = 400
  const px = new Uint8Array(W * H * 3).fill(255)

  const dot = (cx: number, cy: number, radius: number, r: number, g: number, b: number): void => {
    const r2 = radius * radius
    for (let y = Math.floor(cy - radius); y <= Math.ceil(cy + radius); y++) {
      for (let x = Math.floor(cx - radius); x <= Math.ceil(cx + radius); x++) {
        if (x < 0 || y < 0 || x >= W || y >= H) continue
        const d2 = (x - cx) * (x - cx) + (y - cy) * (y - cy)
        if (d2 > r2) continue
        // Soft edge: blend the outermost pixel ring with the background.
        const alpha = Math.min(1, Math.max(0, radius - Math.sqrt(d2) + 0.5))
        const i = (y * W + x) * 3
        px[i] = Math.round(px[i] * (1 - alpha) + r * alpha)
        px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + g * alpha)
        px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + b * alpha)
      }
    }
  }

  const left = 50
  const right = W - 30
  const top = 30
  const bottom = H - 40
  const mid = (top + bottom) / 2

  // Light grid
  for (let i = 0; i <= 8; i++) {
    const x = left + ((right - left) * i) / 8
    for (let y = top; y <= bottom; y += 1) dot(x, y, 0.5, 228, 231, 236)
  }
  for (let i = 0; i <= 4; i++) {
    const y = top + ((bottom - top) * i) / 4
    for (let x = left; x <= right; x += 1) dot(x, y, 0.5, 228, 231, 236)
  }
  // Axes
  for (let x = left; x <= right; x += 0.5) dot(x, mid, 1, 73, 83, 101)
  for (let y = top; y <= bottom; y += 0.5) dot(left, y, 1, 73, 83, 101)

  // Envelope (dashed) and curve
  const xMax = 4 * Math.PI
  const amp = (bottom - top) / 2 - 8
  const steps = (right - left) * 4
  for (let s = 0; s <= steps; s++) {
    const t = s / steps
    const x = left + t * (right - left)
    const env = Math.exp((-t * xMax) / 5)
    if (Math.floor(s / 24) % 2 === 0) {
      dot(x, mid - amp * env, 0.9, 175, 181, 192)
      dot(x, mid + amp * env, 0.9, 175, 181, 192)
    }
    dot(x, mid - amp * env * Math.sin(t * xMax * 1.5), 2.2, 9, 136, 66)
  }

  return encodePng(W, H, px)
}

export type TemplateName = 'blank' | 'example'

export async function writeTemplate(dir: string, template: TemplateName, projectName: string): Promise<void> {
  if (template === 'example') {
    await fs.mkdir(path.join(dir, 'figures'), { recursive: true })
    await fs.writeFile(path.join(dir, 'main.tex'), exampleMainTex(projectName), 'utf8')
    await fs.writeFile(path.join(dir, 'references.bib'), EXAMPLE_BIB, 'utf8')
    await fs.writeFile(path.join(dir, 'figures', 'wave.png'), exampleFigurePng())
  } else {
    await fs.writeFile(path.join(dir, 'main.tex'), blankMainTex(projectName), 'utf8')
  }
}
