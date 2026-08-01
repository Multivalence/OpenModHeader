/* OpenModHeader — inline SVG icon set.

   Emoji render differently on every platform and pick up the system colour
   font, which fights the interface. These are stroked paths that inherit
   currentColor and scale with the surrounding text. */

const NS = 'http://www.w3.org/2000/svg';

/* 24x24 viewBox, stroked, no fills. Kept deliberately simple so they stay
   legible at the 12-14px sizes the UI actually uses. */
const PATHS = {
  lock: ['rect:5,11,14,10,2', 'M8 11V7a4 4 0 0 1 8 0v4'],
  unlock: ['rect:5,11,14,10,2', 'M8 11V7a4 4 0 0 1 7.5-2'],
  eye: ['M2 12s3.5-6.5 10-6.5S22 12 22 12s-3.5 6.5-10 6.5S2 12 2 12z', 'circle:12,12,3'],
  eyeOff: [
    'M10.6 6.2A9.9 9.9 0 0 1 12 6c6.5 0 10 6 10 6a17 17 0 0 1-2.7 3.4',
    'M6.3 7.6A17 17 0 0 0 2 12s3.5 6 10 6a9.7 9.7 0 0 0 4-.8',
    'M9.9 9.9a3 3 0 0 0 4.2 4.2',
    'M3 3l18 18'
  ],
  back: ['M19 12H5', 'M11 18l-6-6 6-6'],
  key: ['circle:8,15,4', 'M11 12l8-8', 'M17 6l2 2', 'M20 3l1.5 1.5'],
  pencil: ['M4 20h4L20 8l-4-4L4 16v4z', 'M14 6l4 4'],
  gear: ['circle:12,12,3', 'M19.4 15a1.6 1.6 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.6 1.6 0 0 0-2.7 1.1V21a2 2 0 1 1-4 0v-.1A1.6 1.6 0 0 0 7 19.4a1.6 1.6 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.6 1.6 0 0 0-1.1-2.7H1a2 2 0 1 1 0-4h.1A1.6 1.6 0 0 0 2.6 7a1.6 1.6 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.6 1.6 0 0 0 1.8.3H7a1.6 1.6 0 0 0 1-1.5V1a2 2 0 1 1 4 0v.1a1.6 1.6 0 0 0 1 1.5 1.6 1.6 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.6 1.6 0 0 0-.3 1.8V7a1.6 1.6 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.6 1.6 0 0 0-1.5 1z'],
  close: ['M18 6 6 18', 'M6 6l12 12'],
  undo: ['M3 7v6h6', 'M3.5 13a9 9 0 1 0 2.1-5.7L3 10'],
  expand: ['M15 3h6v6', 'M10 14 21 3', 'M21 14v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5'],
  more: ['circle:5,12,1.4', 'circle:12,12,1.4', 'circle:19,12,1.4'],
  arrowUp: ['M12 19V5', 'M6 11l6-6 6 6'],
  arrowDown: ['M12 5v14', 'M18 13l-6 6-6-6'],
  filter: ['M3 5h18', 'M7 12h10', 'M11 19h2'],
  plus: ['M12 5v14', 'M5 12h14'],
  caret: ['M6 9l6 6 6-6'],
  shield: ['M12 3l8 3v6c0 4.6-3.2 7.9-8 9-4.8-1.1-8-4.4-8-9V6l8-3z'],
  cookie: ['circle:12,12,9', 'circle:9,9,1', 'circle:15,10,1', 'circle:11,15,1', 'circle:16,15,1'],
  redirect: ['M4 12h13', 'M13 7l5 5-5 5'],
  policy: ['M12 3l8 3v6c0 4.6-3.2 7.9-8 9-4.8-1.1-8-4.4-8-9V6l8-3z', 'M9 12l2 2 4-4']
};

function node(name, attrs) {
  const element = document.createElementNS(NS, name);
  for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
  return element;
}

/* `icon('lock')` returns an <svg> element sized to the surrounding text.
   Marked aria-hidden because every caller supplies its own accessible label
   via title or adjacent text. */
export function icon(name, { size = 14, stroke = 1.9 } = {}) {
  const shapes = PATHS[name];
  if (!shapes) throw new Error(`Unknown icon: ${name}`);

  const svg = node('svg', {
    xmlns: NS,
    viewBox: '0 0 24 24',
    width: size,
    height: size,
    fill: 'none',
    stroke: 'currentColor',
    'stroke-width': stroke,
    'stroke-linecap': 'round',
    'stroke-linejoin': 'round',
    'aria-hidden': 'true',
    focusable: 'false',
    class: 'icon'
  });

  for (const shape of shapes) {
    if (shape.startsWith('circle:')) {
      const [cx, cy, r] = shape.slice(7).split(',');
      svg.append(node('circle', { cx, cy, r }));
    } else if (shape.startsWith('rect:')) {
      const [x, y, width, height, rx] = shape.slice(5).split(',');
      svg.append(node('rect', { x, y, width, height, rx }));
    } else {
      svg.append(node('path', { d: shape }));
    }
  }
  return svg;
}

/* Replaces the text content of every [data-icon] element in a container. Lets
   the static markup stay declarative instead of holding glyph characters. */
export function hydrateIcons(root = document) {
  for (const host of root.querySelectorAll('[data-icon]')) {
    const name = host.dataset.icon;
    if (!PATHS[name]) continue;
    const size = Number(host.dataset.iconSize) || 14;
    host.textContent = '';
    host.append(icon(name, { size }));
  }
}
