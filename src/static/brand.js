// Brand configuration for the graph viewer UI.
// This is the ONLY JS file that differs between branded branches.
//
// chatLogo is the F01 "Six-petal" Spore mark — see
// /mnt/user/appdata/anima/design_stuff/spore logo and node/README.md
// for the design spec. Geometry uses viewBox="-1 -1 2 2" so the spec
// coords (petal ring r=0.62, petal r=0.16, center r=0.18, spoke
// width 0.04) drop in without scaling. Ink uses currentColor so it
// follows the text color of the surrounding header; amber #c8762c is
// the brand accent and stays literal.
window.BRAND = {
  name: 'Spore Core',
  tagline: 'Memory that grows with you',
  agent: 'agent',
  agents: 'agents',
  Agent: 'Spore Core',
  company: 'Spore Core',
  chatLogo: '<svg height="20" viewBox="-1 -1 2 2" xmlns="http://www.w3.org/2000/svg" style="flex-shrink:0;display:block;overflow:visible" aria-label="Spore Core"><g stroke="currentColor" stroke-width="0.04" stroke-linecap="round"><line x1="0" y1="0" x2="0" y2="-0.62"/><line x1="0" y1="0" x2="0.5369" y2="-0.31"/><line x1="0" y1="0" x2="0.5369" y2="0.31"/><line x1="0" y1="0" x2="0" y2="0.62"/><line x1="0" y1="0" x2="-0.5369" y2="0.31"/><line x1="0" y1="0" x2="-0.5369" y2="-0.31"/></g><g fill="#c8762c"><circle cx="0" cy="-0.62" r="0.16"/><circle cx="0.5369" cy="-0.31" r="0.16"/><circle cx="0.5369" cy="0.31" r="0.16"/><circle cx="0" cy="0.62" r="0.16"/><circle cx="-0.5369" cy="0.31" r="0.16"/><circle cx="-0.5369" cy="-0.31" r="0.16"/></g><circle cx="0" cy="0" r="0.18" fill="currentColor"/></svg>',
  // Header text next to logo
  chatHeaderText: 'Spore Core',
};
