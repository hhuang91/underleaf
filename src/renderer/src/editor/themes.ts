import { HighlightStyle, syntaxHighlighting } from '@codemirror/language'
import type { Extension } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { tags as t } from '@lezer/highlight'
import type { EditorFontFamily, LineHeight } from '@shared/types'
import { latexTags } from './latexLanguage'

export interface EditorThemeSpec {
  id: string
  label: string
  dark: boolean
  bg: string
  fg: string
  gutterBg: string
  gutterFg: string
  gutterBorder: string
  activeLine: string
  selection: string
  cursor: string
  matchBracket: string
  command: string
  envName: string
  refKey: string
  fileArg: string
  comment: string
  math: string
  mathDelim: string
  bracket: string
  special: string
}

export const EDITOR_THEMES: EditorThemeSpec[] = [
  {
    id: 'textmate',
    label: 'Textmate (default)',
    dark: false,
    bg: '#ffffff',
    fg: '#1b222c',
    gutterBg: '#f4f5f6',
    gutterFg: '#8d96a5',
    gutterBorder: '#e7e9ee',
    activeLine: 'rgba(0, 0, 0, 0.05)',
    selection: '#b5d5ff',
    cursor: '#000000',
    matchBracket: 'rgba(9, 136, 66, 0.25)',
    command: '#0033cc',
    envName: '#b85c00',
    refKey: '#2b7a8c',
    fileArg: '#3c4c72',
    comment: '#4c886b',
    math: '#036a07',
    mathDelim: '#c5060b',
    bracket: '#5b6472',
    special: '#c5060b'
  },
  {
    id: 'github',
    label: 'GitHub Light',
    dark: false,
    bg: '#ffffff',
    fg: '#24292f',
    gutterBg: '#ffffff',
    gutterFg: '#8c959f',
    gutterBorder: '#eaeef2',
    activeLine: '#f6f8fa',
    selection: '#b6d7ff',
    cursor: '#24292f',
    matchBracket: 'rgba(84, 174, 255, 0.4)',
    command: '#0550ae',
    envName: '#116329',
    refKey: '#8250df',
    fileArg: '#0a3069',
    comment: '#6e7781',
    math: '#953800',
    mathDelim: '#cf222e',
    bracket: '#57606a',
    special: '#cf222e'
  },
  {
    id: 'solarized-light',
    label: 'Solarized Light',
    dark: false,
    bg: '#fdf6e3',
    fg: '#586e75',
    gutterBg: '#eee8d5',
    gutterFg: '#93a1a1',
    gutterBorder: '#e4ddc8',
    activeLine: 'rgba(238, 232, 213, 0.7)',
    selection: '#d9d2bc',
    cursor: '#586e75',
    matchBracket: 'rgba(38, 139, 210, 0.3)',
    command: '#268bd2',
    envName: '#cb4b16',
    refKey: '#6c71c4',
    fileArg: '#2aa198',
    comment: '#93a1a1',
    math: '#859900',
    mathDelim: '#dc322f',
    bracket: '#839496',
    special: '#d33682'
  },
  {
    id: 'dracula',
    label: 'Dracula',
    dark: true,
    bg: '#282a36',
    fg: '#f8f8f2',
    gutterBg: '#282a36',
    gutterFg: '#6272a4',
    gutterBorder: '#343746',
    activeLine: 'rgba(68, 71, 90, 0.6)',
    selection: '#44475a',
    cursor: '#f8f8f0',
    matchBracket: 'rgba(80, 250, 123, 0.3)',
    command: '#8be9fd',
    envName: '#ffb86c',
    refKey: '#bd93f9',
    fileArg: '#f1fa8c',
    comment: '#6272a4',
    math: '#50fa7b',
    mathDelim: '#ff79c6',
    bracket: '#b8bccf',
    special: '#ff79c6'
  },
  {
    id: 'monokai',
    label: 'Monokai',
    dark: true,
    bg: '#272822',
    fg: '#f8f8f2',
    gutterBg: '#2f3129',
    gutterFg: '#8f908a',
    gutterBorder: '#3b3d33',
    activeLine: 'rgba(62, 61, 50, 0.8)',
    selection: '#49483e',
    cursor: '#f8f8f0',
    matchBracket: 'rgba(166, 226, 46, 0.3)',
    command: '#66d9ef',
    envName: '#fd971f',
    refKey: '#ae81ff',
    fileArg: '#e6db74',
    comment: '#75715e',
    math: '#a6e22e',
    mathDelim: '#f92672',
    bracket: '#c5c8c0',
    special: '#f92672'
  },
  {
    id: 'solarized-dark',
    label: 'Solarized Dark',
    dark: true,
    bg: '#002b36',
    fg: '#93a1a1',
    gutterBg: '#073642',
    gutterFg: '#586e75',
    gutterBorder: '#0a4150',
    activeLine: 'rgba(7, 54, 66, 0.8)',
    selection: '#174652',
    cursor: '#93a1a1',
    matchBracket: 'rgba(38, 139, 210, 0.4)',
    command: '#268bd2',
    envName: '#cb4b16',
    refKey: '#6c71c4',
    fileArg: '#2aa198',
    comment: '#586e75',
    math: '#859900',
    mathDelim: '#dc322f',
    bracket: '#839496',
    special: '#d33682'
  }
]

export function themeSpec(id: string): EditorThemeSpec {
  return EDITOR_THEMES.find((x) => x.id === id) ?? EDITOR_THEMES[0]
}

const FONT_STACKS: Record<EditorFontFamily, string> = {
  monaco: "Monaco, Menlo, 'Ubuntu Mono', Consolas, 'DejaVu Sans Mono', monospace",
  lucida: "'Lucida Console', 'Source Code Pro', 'Lucida Sans Typewriter', monospace"
}

const LINE_HEIGHTS: Record<LineHeight, number> = { compact: 1.33, normal: 1.6, wide: 2 }

export function editorTheme(
  id: string,
  opts: { fontSize: number; fontFamily: EditorFontFamily; lineHeight: LineHeight }
): Extension {
  const s = themeSpec(id)
  const panelBg = s.dark ? s.gutterBg : '#f4f5f6'
  const panelBorder = s.gutterBorder
  const theme = EditorView.theme(
    {
      '&': {
        color: s.fg,
        backgroundColor: s.bg,
        fontSize: `${opts.fontSize}px`,
        height: '100%'
      },
      '&.cm-focused': { outline: 'none' },
      '.cm-scroller': {
        fontFamily: FONT_STACKS[opts.fontFamily],
        lineHeight: String(LINE_HEIGHTS[opts.lineHeight]),
        overflow: 'auto'
      },
      '.cm-content': { caretColor: s.cursor, padding: '6px 0 40vh' },
      '.cm-line': { padding: '0 12px 0 8px' },
      '.cm-cursor, .cm-dropCursor': { borderLeftColor: s.cursor, borderLeftWidth: '1.5px' },
      '&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection':
        { backgroundColor: s.selection },
      '.cm-gutters': {
        backgroundColor: s.gutterBg,
        color: s.gutterFg,
        border: 'none',
        borderRight: `1px solid ${s.gutterBorder}`
      },
      '.cm-lineNumbers .cm-gutterElement': { padding: '0 8px 0 10px', minWidth: '38px' },
      '.cm-activeLine': { backgroundColor: s.activeLine },
      '.cm-activeLineGutter': { backgroundColor: s.activeLine, color: s.fg },
      '&.cm-focused .cm-matchingBracket, .cm-matchingBracket': {
        backgroundColor: s.matchBracket,
        outline: 'none'
      },
      '.cm-selectionMatch': { backgroundColor: s.dark ? 'rgba(255,255,255,0.12)' : 'rgba(9,136,66,0.14)' },
      '.cm-searchMatch': {
        backgroundColor: s.dark ? 'rgba(255, 213, 79, 0.3)' : 'rgba(255, 213, 79, 0.55)',
        outline: 'none'
      },
      '.cm-searchMatch.cm-searchMatch-selected': {
        backgroundColor: s.dark ? 'rgba(255, 150, 50, 0.55)' : 'rgba(255, 150, 50, 0.7)'
      },
      '.cm-panels': { backgroundColor: panelBg, color: s.fg, borderColor: panelBorder },
      '.cm-panels.cm-panels-top': { borderBottom: `1px solid ${panelBorder}` },
      '.cm-tooltip': {
        border: 'none',
        borderRadius: '6px',
        boxShadow: '0 4px 12px rgba(30, 37, 48, 0.24)',
        backgroundColor: s.dark ? '#2f3a4c' : '#ffffff',
        color: s.dark ? '#ffffff' : '#1b222c',
        overflow: 'hidden'
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul': {
        fontFamily: FONT_STACKS[opts.fontFamily],
        fontSize: '12.5px',
        maxHeight: '260px',
        minWidth: '260px'
      },
      '.cm-tooltip.cm-tooltip-autocomplete > ul > li': { padding: '3px 10px 3px 6px', lineHeight: '1.5' },
      '.cm-tooltip-autocomplete ul li[aria-selected]': {
        backgroundColor: '#098842',
        color: '#ffffff'
      },
      '.cm-completionDetail': { opacity: '0.7', fontStyle: 'normal', marginLeft: '12px' },
      '.cm-completionInfo': { padding: '6px 10px', maxWidth: '360px', fontFamily: 'var(--font-ui)' },
      '.cm-log-gutter': { width: '14px' },
      '.cm-log-marker': {
        display: 'block',
        width: '8px',
        height: '8px',
        margin: '0 3px',
        borderRadius: '50%',
        position: 'relative',
        top: '0.45em'
      },
      '.cm-log-marker.error': { backgroundColor: '#b83a33' },
      '.cm-log-marker.warning': { backgroundColor: '#de8014' },
      '.cm-log-marker.typesetting': { backgroundColor: '#366cbf' },
      '.cm-log-line-error': { backgroundColor: s.dark ? 'rgba(184, 58, 51, 0.22)' : 'rgba(184, 58, 51, 0.09)' },
      '.cm-sync-flash': { animation: 'cm-sync-flash 1.2s ease-out' }
    },
    { dark: s.dark }
  )

  const highlight = HighlightStyle.define([
    { tag: latexTags.command, color: s.command },
    { tag: latexTags.structure, color: s.command, fontWeight: '600' },
    { tag: latexTags.envName, color: s.envName, fontStyle: 'italic' },
    { tag: latexTags.refKey, color: s.refKey },
    { tag: latexTags.fileArg, color: s.fileArg },
    { tag: latexTags.heading, fontWeight: '700' },
    { tag: latexTags.math, color: s.math },
    { tag: latexTags.mathCommand, color: s.math, fontWeight: '600' },
    { tag: latexTags.mathDelim, color: s.mathDelim },
    { tag: latexTags.verbatim, color: s.bracket },
    { tag: latexTags.special, color: s.special },
    { tag: t.comment, color: s.comment, fontStyle: 'italic' },
    { tag: t.bracket, color: s.bracket },
    { tag: t.keyword, color: s.command, fontWeight: '600' },
    { tag: t.string, color: s.math },
    { tag: t.number, color: s.mathDelim },
    { tag: t.propertyName, color: s.fileArg },
    { tag: t.operator, color: s.special }
  ])

  return [theme, syntaxHighlighting(highlight)]
}
