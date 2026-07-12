/**
 * Host hook for "Bearbeiten": the assistant hands a command + prefilled
 * params to whoever owns the command palette. The integrator wires the real
 * palette via setPaletteEditHandler (e.g. open the palette in param mode);
 * until then the call is a safe no-op.
 */

export let requestPaletteEdit: (commandId: string, params: Record<string, unknown>) => void =
  () => {};

export function setPaletteEditHandler(fn: typeof requestPaletteEdit): void {
  requestPaletteEdit = fn;
}
