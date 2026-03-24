export interface FontPreset {
  name: string
  displayName: string
  url: string
  category: 'sans-serif' | 'serif' | 'monospace' | 'handwriting' | 'cjk'
}

export const FONT_PRESETS: FontPreset[] = [
  {
    name: 'roboto',
    displayName: 'Roboto',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/roboto/Roboto%5Bwdth%2Cwght%5D.ttf',
    category: 'sans-serif',
  },
  {
    name: 'roboto-slab',
    displayName: 'Roboto Slab',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/apache/robotoslab/RobotoSlab%5Bwght%5D.ttf',
    category: 'serif',
  },
  {
    name: 'jetbrains-mono',
    displayName: 'JetBrains Mono',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/jetbrainsmono/JetBrainsMono%5Bwght%5D.ttf',
    category: 'monospace',
  },
  {
    name: 'caveat',
    displayName: 'Caveat',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/caveat/Caveat%5Bwght%5D.ttf',
    category: 'handwriting',
  },
  {
    name: 'noto-sans-sc',
    displayName: 'Noto Sans SC',
    url: 'https://cdn.jsdelivr.net/gh/google/fonts@main/ofl/notosanssc/NotoSansSC%5Bwght%5D.ttf',
    category: 'cjk',
  },
]

export const FONT_PRESET_MAP = new Map(FONT_PRESETS.map(f => [f.name, f]))
