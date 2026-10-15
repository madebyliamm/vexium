// Artifact types (Plan, StyleSpec, Manifest, LaunchChecks, BusinessState) + validateArtifact. ONE source shared with the edge functions:
// supabase/functions/_shared/artifacts.ts (see docs/STAGES.md). Re-exported here so the studio imports it like any other module.
export * from '../../../supabase/functions/_shared/artifacts.ts';
