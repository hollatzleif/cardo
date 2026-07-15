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
};

/** Live instances (widgets render from these). */
export const liveTools = new Map<string, CardoTool>();

export function instantiateTools(): void {
  for (const [id, factory] of Object.entries(toolFactories)) {
    if (!liveTools.has(id)) liveTools.set(id, factory());
  }
}
