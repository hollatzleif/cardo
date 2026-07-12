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
  createScratchContext,
  renderReportMarkdown,
  DIAGNOSE_CATEGORIES,
  type DiagnoseCategory,
  type DiagnoseCheck,
  type DiagnoseReport,
  type DiagnoseResult,
  type ScratchContext,
  type ScratchServices,
  type ToolUnderTest,
} from './diagnose';
