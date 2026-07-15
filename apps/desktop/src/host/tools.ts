import type { CardoTool } from '@cardo/plugin-api';
import { createTool as createClockTool } from '@cardo/tool-clock';
import { createTool as createCounterTool } from '@cardo/tool-counter';
import { createTool as createTodoTool } from '@cardo/tool-todo';
import { createTool as createTodayTool } from '@cardo/tool-today';
import { createTool as createHabitsTool } from '@cardo/tool-habits';
import { createTool as createNotesTool } from '@cardo/tool-notes';
import { createTool as createCalendarTool } from '@cardo/tool-calendar';
import { createTool as createPomodoroTool } from '@cardo/tool-pomodoro';
import { createTool as createWorkclockTool } from '@cardo/tool-workclock';
import { createTool as createStatsTool } from '@cardo/tool-stats';
import { createTool as createAlarmTool } from '@cardo/tool-alarm';
import { createTool as createCountdownTool } from '@cardo/tool-countdown';
import { createTool as createQuickcaptureTool } from '@cardo/tool-quickcapture';
import { createTool as createRoutineTool } from '@cardo/tool-routine';
import { createAssistantTool } from '../assistant';
import { createTool as createWeatherTool } from '@cardo/tool-weather';
import { createTool as createHydrationTool } from '@cardo/tool-hydration';
import { createTool as createFilesExplorerTool } from '@cardo/tool-files-explorer';
import { createTool as createEisenhowerTool } from '@cardo/tool-eisenhower';
import { createTool as createStickyNotesTool } from '@cardo/tool-sticky-notes';
import { createTool as createDecisionLogTool } from '@cardo/tool-decision-log';
import { createTool as createReadingListTool } from '@cardo/tool-reading-list';
import { createTool as createScratchpadTool } from '@cardo/tool-scratchpad';
import { createTool as createSavingsJarTool } from '@cardo/tool-savings-jar';
import { createTool as createSubscriptionsTool } from '@cardo/tool-subscriptions';
import { createTool as createUnitConverterTool } from '@cardo/tool-unit-converter';
import { createTool as createWorldClockTool } from '@cardo/tool-world-clock';
import { createTool as createPasswordGenTool } from '@cardo/tool-password-gen';
import { createTool as createRandomPickerTool } from '@cardo/tool-random-picker';
import { createTool as createBookmarksTool } from '@cardo/tool-bookmarks';
import { createTool as createQrGeneratorTool } from '@cardo/tool-qr-generator';
import { createTool as createTimeBlockingTool } from '@cardo/tool-time-blocking';
import { createTool as createProjectTrackerTool } from '@cardo/tool-project-tracker';
import { createTool as createOkrTool } from '@cardo/tool-okr';
import { createTool as createFlashcardsTool } from '@cardo/tool-flashcards';
import { createTool as createMoodTool } from '@cardo/tool-mood';
import { createTool as createSleepLogTool } from '@cardo/tool-sleep-log';
import { createTool as createWorkoutTool } from '@cardo/tool-workout';
import { createTool as createMealPlannerTool } from '@cardo/tool-meal-planner';
import { createTool as createMedicationTool } from '@cardo/tool-medication';
import { createTool as createBreathingTool } from '@cardo/tool-breathing';
import { createTool as createSharedExpensesTool } from '@cardo/tool-shared-expenses';
import { createTool as createCalculatorTool } from '@cardo/tool-calculator';
import { createTool as createColorToolTool } from '@cardo/tool-color-tool';
import { createTool as createSnippetsTool } from '@cardo/tool-snippets';

/**
 * First-party tool catalog. Every tool ships with the app; "installing" in
 * the tool market only activates it. The factory is used twice: once for
 * the live instance, and per diagnose run for isolated scratch instances.
 */
export const toolFactories: Record<string, () => CardoTool> = {
  assistant: createAssistantTool,
  today: createTodayTool,
  todo: createTodoTool,
  habits: createHabitsTool,
  notes: createNotesTool,
  'files-explorer': createFilesExplorerTool,
  calendar: createCalendarTool,
  pomodoro: createPomodoroTool,
  workclock: createWorkclockTool,
  stats: createStatsTool,
  alarm: createAlarmTool,
  countdown: createCountdownTool,
  quickcapture: createQuickcaptureTool,
  routine: createRoutineTool,
  weather: createWeatherTool,
  hydration: createHydrationTool,
  clock: createClockTool,
  counter: createCounterTool,
  eisenhower: createEisenhowerTool,
  'sticky-notes': createStickyNotesTool,
  'decision-log': createDecisionLogTool,
  'reading-list': createReadingListTool,
  scratchpad: createScratchpadTool,
  'savings-jar': createSavingsJarTool,
  subscriptions: createSubscriptionsTool,
  'unit-converter': createUnitConverterTool,
  'world-clock': createWorldClockTool,
  'password-gen': createPasswordGenTool,
  'random-picker': createRandomPickerTool,
  bookmarks: createBookmarksTool,
  'qr-generator': createQrGeneratorTool,
  'time-blocking': createTimeBlockingTool,
  'project-tracker': createProjectTrackerTool,
  okr: createOkrTool,
  flashcards: createFlashcardsTool,
  mood: createMoodTool,
  'sleep-log': createSleepLogTool,
  workout: createWorkoutTool,
  'meal-planner': createMealPlannerTool,
  medication: createMedicationTool,
  breathing: createBreathingTool,
  'shared-expenses': createSharedExpensesTool,
  calculator: createCalculatorTool,
  'color-tool': createColorToolTool,
  snippets: createSnippetsTool,
};

/** Live instances (widgets render from these). */
export const liveTools = new Map<string, CardoTool>();

export function instantiateTools(): void {
  for (const [id, factory] of Object.entries(toolFactories)) {
    if (!liveTools.has(id)) liveTools.set(id, factory());
  }
}
