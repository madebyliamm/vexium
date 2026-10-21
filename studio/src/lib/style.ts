// The style engine: colour maths, vibe presets (theme / accent / fonts / density / tone) and the pure token swaps behind the vibe
// controls. ONE source shared with the edge functions and the database tests: supabase/functions/_shared/style.ts (see docs/STAGES.md).
// Re-exported here so the studio imports it like any other lib.
export * from '../../../supabase/functions/_shared/style.ts';
