export interface AgentScreen {
  id: string; // stable key
  label: string; // e.g. "Agent Screen 1"
  url: string; // wss URL
}

// Dynamic: add/remove entries here; the Screen tab renders exactly this many
// screens. With a single entry the selector is hidden and the page behaves as a
// single-feed view. Only the currently-viewed screen's WebSocket is connected.
export const AGENT_SCREENS: AgentScreen[] = [
  { id: 'screen-1', label: 'Agent Screen 1', url: 'wss://vm.satorilabs.tech/video' },
  // add more feeds here as they come online, e.g.
  // { id: 'screen-2', label: 'Agent Screen 2', url: 'wss://...' },
];
