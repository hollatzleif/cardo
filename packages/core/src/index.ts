export { CommandRegistry } from './commands';
export { SearchRegistry, type ScoredSearchResult } from './search';
export { createEventBus } from './events';
export {
  createNamespacedStorage,
  createMemoryBackend,
  type StorageBackend,
} from './storage';
export { ToolRegistry, type HostServices, type RegisteredTool } from './registry';
export {
  runDiagnostics,
  buildToolChecks,
  renderReportMarkdown,
  type DiagnoseCheck,
  type DiagnoseReport,
  type DiagnoseResult,
  type ToolUnderTest,
} from './diagnose';
