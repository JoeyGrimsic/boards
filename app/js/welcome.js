// The starter board created the very first time.
export function welcomeBoard() {
  const items = [
    { id: 'w-title', type: 'text', x: 0, y: -120, w: 900, h: 0, text: 'hello, brainstorm', font: 'marker', size: 64, color: 'ink', bg: null, center: { title: 'start here' } },
    {
      id: 'w-make', type: 'text', x: 0, y: 30, w: 330, h: 300, font: 'hand', size: 30, color: 'ink', bg: 'paper',
      text: '**double-click** anywhere to write\n\n- T text\n- H heading\n- N sticky note\n- A arrows\n- M music',
    },
    {
      id: 'w-tags', type: 'text', x: 430, y: 40, w: 360, h: 0, font: 'print', size: 24, color: 'ink', bg: null,
      text: 'type a #tag in any text.\n\nthings that share a tag get tied together with faint threads — hover a tag to light them up. #ideas',
    },
    {
      id: 'w-todo', type: 'text', x: 870, y: 20, w: 300, h: 260, font: 'hand', size: 28, color: 'ink', bg: 'yellow',
      text: 'try these #ideas\n\n[ ] paste a screenshot (ctrl+V)\n[ ] drop in a video\n[ ] press M for music\n[ ] press ? for shortcuts',
    },
    {
      id: 'w-move', type: 'text', x: 430, y: 360, w: 460, h: 0, font: 'print', size: 22, color: 'gray', bg: null,
      text: 'drag empty space to pan · scroll to zoom · shift+drag to select a bunch · 0 shows everything',
    },
    {
      id: 'w-next', type: 'text', x: 1700, y: 0, w: 420, h: 220, font: 'hand', size: 32, color: 'ink', bg: 'pink',
      text: 'this is another **center piece** ✶\n\nselect anything and press P to make your own, then hop between them with ← →',
      center: { title: 'center pieces' },
    },
    { id: 'w-a1', type: 'arrow', from: 'w-make', to: 'w-tags', color: 'ink', label: '' },
  ];
  return { version: 1, items, settings: { threads: true } };
}
